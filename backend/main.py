"""
RefCheck AI — FastAPI Backend
=============================
POST /analyze  — Extract 10 video frames via OpenCV and analyze with
                 llama3.2-vision running on a local Ollama server.

Run:
    uvicorn main:app --reload --port 8000
"""

import base64
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

import cv2
import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("refcheck.backend")

# ─── Config ───────────────────────────────────────────────────────────────────
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL    = os.getenv("OLLAMA_MODEL",    "llama3.2-vision")
NUM_FRAMES      = int(os.getenv("NUM_FRAMES",  "10"))
OLLAMA_TIMEOUT  = float(os.getenv("OLLAMA_TIMEOUT", "120"))   # seconds

# ─── Sport rulebook context ────────────────────────────────────────────────────
SPORT_RULES: dict[str, str] = {
    "basketball": """
OFFICIAL NBA RULES — KEY OFFICIATING SECTIONS:
• Blocking vs Charging (Rule 12B): A defender who establishes legal guarding
  position (both feet on the floor, facing the opponent, body in the path of
  travel) BEFORE the offensive player's upward shooting motion earns a CHARGE
  (offensive foul). If still moving laterally → BLOCK (defensive foul).
• Restricted Area Arc: Inside the painted arc under the basket a defender
  cannot draw a charge.
• Verticality: Defender may hold their vertical plane; offensive lean into a
  vertical defender is an offensive foul.
• Traveling (Rule 10): More than two steps after the gather without dribbling.
• Flagrant Foul 1/2: Unnecessary or excessive contact.
""",
    "soccer": """
FIFA LAWS OF THE GAME — KEY OFFICIATING SECTIONS:
• Law 12 (Fouls): Direct free-kick offenses include charging, jumping at,
  kicking, pushing, striking, tackling carelessly / recklessly / with excessive
  force, or tripping an opponent.
• Handball: Deliberate handball is always an offense. Accidental handball that
  leads directly to a goal or clear chance is also an offense.
• Offside (Law 11): Any body part (not arms) nearer to the goal line than both
  the ball and the second-to-last opponent when the ball is played.
• DOGSO: Denying an Obvious Goal-Scoring Opportunity = red card.
• Advantage: Referee may allow play to continue if non-offending team benefits.
""",
    "americanfootball": """
NFL OFFICIAL RULES — KEY OFFICIATING SECTIONS:
• Pass Interference: Defender cannot significantly hinder an eligible receiver
  after the ball is airborne. Contact within 1 yard of LoS is legal.
• Roughing the Passer: Forcible contact to the QB after clear ball release;
  landing full weight on QB is a foul.
• Holding: Hands/arms materially restricting an opponent's movement.
  Defensive holding on pass plays = 5 yards + automatic first down.
• Targeting: Forcible contact with helmet to the head/neck of a defenseless
  player, or lowering the head to initiate contact.
• Catch: Control + two feet (or knee) in-bounds + football move / survives contact.
""",
    "baseball": """
MLB OFFICIAL RULES — KEY OFFICIATING SECTIONS:
• Strike Zone: Over home plate from batter's mid-torso to the hollow below
  the kneecap in the batter's natural stance.
• Checked Swing: Strike if bat head passes the front of the plate.
• Tag Play: Fielder must tag runner with ball before runner reaches base.
• Force Play: Fielder touches base while possessing ball before runner arrives.
• Infield Fly Rule: Fair fly ball catchable by infielder with ordinary effort,
  runners on 1st & 2nd (or loaded), fewer than 2 outs → batter auto out.
• Balk: Illegal pitcher motion with runners on base → all runners advance one.
""",
    "hockey": """
NHL OFFICIAL RULES — KEY OFFICIATING SECTIONS:
• Goaltender Interference: No contact with goalie inside crease; incidental
  contact alone does not automatically void a goal.
• Icing: Puck shot from own side of center ice past opposing goal line without
  being touched — hybrid icing stops play at faceoff dot.
• High-Sticking: Stick above opponent's shoulder height making contact is a
  penalty; goal scored via high-stick is disallowed.
• Offside: Both skates fully across the blue line before the puck enters.
• Boarding/Charging: Violent check into the boards or excessive stride buildup
  before contact.
""",
    "tennis": """
ITF RULES OF TENNIS — KEY OFFICIATING SECTIONS:
• Ball In/Out: Ball is "in" if any part touches the court lines.
• Let: Serve clipping net and landing in correct box → retaken.
• Foot Fault: Server must not touch the baseline or inside before striking.
• Hindrance: Deliberate hindrance of opponent = loss of point.
• Hawkeye: Call based on ball's contact mark on surface, not bounce trajectory.
""",
}

_ALIASES = {
    "nba": "basketball", "nfl": "americanfootball", "mlb": "baseball",
    "nhl": "hockey", "football": "americanfootball", "futbol": "soccer",
}


def resolve_sport(sport: str) -> str:
    key = sport.lower().strip().replace(" ", "")
    return _ALIASES.get(key, key)


# ─── Pydantic schemas ──────────────────────────────────────────────────────────
class AnalysisResult(BaseModel):
    verdict: str = Field(..., description="Fair Call | Bad Call | Inconclusive")
    confidence: str = Field(..., description="Low | Medium | High")
    play_description: str = Field(..., description="Objective visual summary")
    rule_based_reasoning: str = Field(..., description="Rule-cited explanation")

    @field_validator("verdict")
    @classmethod
    def validate_verdict(cls, v: str) -> str:
        valid = {"Fair Call", "Bad Call", "Inconclusive"}
        # Attempt to normalize if model produces slight variation
        for opt in valid:
            if opt.lower() in v.lower():
                return opt
        return "Inconclusive"

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, v: str) -> str:
        for opt in ("High", "Medium", "Low"):
            if opt.lower() in v.lower():
                return opt
        return "Low"


class AnalysisResponse(BaseModel):
    success: bool
    analysis: AnalysisResult
    metadata: dict


# ─── Frame extraction ──────────────────────────────────────────────────────────
def extract_frames_b64(video_path: str, num_frames: int = NUM_FRAMES) -> list[dict]:
    """
    Extract `num_frames` evenly-distributed frames from the video.
    Returns list of dicts: {index, timestamp_str, b64_jpeg}
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {video_path}")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps   = cap.get(cv2.CAP_PROP_FPS) or 30.0

    if total <= 0:
        cap.release()
        raise ValueError("Video has no readable frames.")

    num_frames = min(num_frames, total)
    indices = (
        [total // 2]
        if num_frames == 1
        else [round(i * (total - 1) / (num_frames - 1)) for i in range(num_frames)]
    )

    results = []
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, 85]

    for seq_idx, frame_no in enumerate(indices):
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_no)
        ok, frame_bgr = cap.read()
        if not ok or frame_bgr is None:
            log.warning("Skipping unreadable frame %d", frame_no)
            continue

        ok_enc, buf = cv2.imencode(".jpg", frame_bgr, encode_params)
        if not ok_enc:
            continue

        ts = frame_no / fps
        m, s = divmod(ts, 60)
        results.append({
            "index": seq_idx,
            "timestamp_str": f"{int(m):02d}:{s:05.2f}",
            "b64_jpeg": base64.b64encode(buf.tobytes()).decode("utf-8"),
        })
        log.info("  Frame %02d/%02d @ %s", seq_idx + 1, num_frames, results[-1]["timestamp_str"])

    cap.release()
    if not results:
        raise ValueError("No frames could be extracted from the video.")
    return results


# ─── Prompt builders ───────────────────────────────────────────────────────────
def build_system_prompt(sport: str) -> str:
    sport_key = resolve_sport(sport)
    rules = SPORT_RULES.get(sport_key, f"Apply the standard official rules for {sport_key}.")

    return f"""\
You are a Professional Sports Officiating Consultant and Rules Analyst with \
20+ years of experience as a certified referee. Your ONLY job is to provide \
an objective, rule-based verdict on the sports play shown in the provided frames.

SPORT: {sport_key.upper()}

OFFICIAL RULEBOOK REFERENCE:
{rules}

STRICT BEHAVIORAL DIRECTIVES — follow these exactly:
1. Analyze every provided frame in chronological order.
2. Focus on: player body position, foot placement, hand/arm position, timing \
of contact, ball position, and trajectory of movement.
3. Compare your visual observations ONLY against the official rules above.
4. Do NOT invent, speculate about, or assume any detail not visible in the frames.
5. If the camera angle or image quality prevents a confident ruling, choose \
"Inconclusive" — never force a verdict you cannot visually justify.
6. Be a strict, neutral referee — precise and factual, not creative.
7. Always cite the specific rule name or number in your rule_based_reasoning.

OUTPUT FORMAT — you MUST respond with ONLY a valid JSON object using these \
exact keys. No markdown, no prose, no code fences, no extra keys:
{{
  "verdict": "Fair Call" | "Bad Call" | "Inconclusive",
  "confidence": "Low" | "Medium" | "High",
  "play_description": "<objective summary of what is visually observed>",
  "rule_based_reasoning": "<detailed explanation citing specific rules and frame observations>"
}}"""


def build_user_message(frames: list[dict], original_call: Optional[str]) -> str:
    call_context = (
        f'The referee\'s original call was: "{original_call.strip()}". '
        "Evaluate whether this call was correct."
        if original_call and original_call.strip()
        else "No original call was provided. Determine whether a violation or foul occurred."
    )
    frame_list = ", ".join(f"Frame {f['index']+1} @ {f['timestamp_str']}" for f in frames)
    return (
        f"I am providing {len(frames)} frames extracted evenly across the video clip "
        f"({frame_list}).\n\n"
        f"{call_context}\n\n"
        "Analyze each frame carefully and provide your officiating verdict as a JSON object."
    )


# ─── Ollama client ─────────────────────────────────────────────────────────────
async def call_ollama(
    system_prompt: str,
    user_message: str,
    frames: list[dict],
    model: str = OLLAMA_MODEL,
    timeout: float = OLLAMA_TIMEOUT,
) -> str:
    """
    Send frames + prompts to Ollama /api/chat.
    Images are embedded as base64 strings in the user message.
    `format: json` forces Ollama to return valid JSON.
    """
    url = f"{OLLAMA_BASE_URL}/api/chat"

    payload = {
        "model": model,
        "stream": False,
        "format": "json",          # ← forces structured JSON output
        "options": {
            "temperature": 0.1,    # near-zero for referee rigidity
            "top_p": 0.8,
            "num_predict": 512,
        },
        "messages": [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": user_message,
                # Ollama vision models accept images as a list of base64 strings
                "images": [f["b64_jpeg"] for f in frames],
            },
        ],
    }

    log.info("Calling Ollama %s @ %s with %d frames …", model, url, len(frames))

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
        except httpx.ConnectError:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Cannot connect to Ollama at {OLLAMA_BASE_URL}. "
                    "Make sure 'ollama serve' is running and llama3.2-vision is pulled."
                ),
            )
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Ollama returned {exc.response.status_code}: {exc.response.text[:300]}",
            )
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail=f"Ollama timed out after {timeout}s. Try a shorter video clip.",
            )

    data = resp.json()
    content: str = data.get("message", {}).get("content", "").strip()
    if not content:
        raise HTTPException(status_code=502, detail="Ollama returned an empty response.")

    log.info("Ollama raw response: %s", content[:200])
    return content


# ─── JSON parsing / validation ─────────────────────────────────────────────────
def parse_and_validate(raw: str, sport: str, num_frames: int) -> AnalysisResponse:
    # Strip accidental markdown fences
    cleaned = raw
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip().rstrip("`").strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        log.error("JSON parse error. Raw: %s", raw[:400])
        raise HTTPException(
            status_code=422,
            detail=f"AI returned invalid JSON: {e}. Raw: {raw[:200]}",
        )

    required = {"verdict", "confidence", "play_description", "rule_based_reasoning"}
    missing  = required - parsed.keys()
    if missing:
        # Attempt field aliasing before failing
        aliases = {
            "reasoning": "rule_based_reasoning",
            "rule_reasoning": "rule_based_reasoning",
            "description": "play_description",
        }
        for alias, canonical in aliases.items():
            if alias in parsed and canonical not in parsed:
                parsed[canonical] = parsed.pop(alias)
        missing = required - parsed.keys()
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"AI response missing required fields: {missing}. Got: {list(parsed.keys())}",
            )

    result = AnalysisResult(**{k: str(v) for k, v in parsed.items() if k in required})

    return AnalysisResponse(
        success=True,
        analysis=result,
        metadata={
            "sport": resolve_sport(sport),
            "model": OLLAMA_MODEL,
            "frames_analyzed": num_frames,
            "ollama_url": OLLAMA_BASE_URL,
        },
    )


# ─── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="RefCheck AI — Ollama Backend",
    description="Frame-based sports officiating analysis using llama3.2-vision via Ollama.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Ping Ollama and confirm the model is available."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            models = [m["name"] for m in r.json().get("models", [])]
            vision_ready = any(OLLAMA_MODEL.split(":")[0] in m for m in models)
        return {
            "status": "ok",
            "ollama": "connected",
            "model": OLLAMA_MODEL,
            "model_ready": vision_ready,
            "available_models": models,
        }
    except Exception as exc:
        return {"status": "degraded", "ollama": "unreachable", "error": str(exc)}


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze(
    video: UploadFile = File(..., description="Short sports video clip (MP4/MOV/WebM)"),
    sport: str        = Form("basketball", description="Sport name or alias (nba, nfl, mlb…)"),
    original_call: Optional[str] = Form(None, description="Referee's original call (optional)"),
    num_frames: int   = Form(NUM_FRAMES, ge=1, le=20, description="Frames to extract (1-20)"),
):
    """
    Upload a sports video clip and receive a rule-based officiating verdict.

    Pipeline:
    1. Save upload to a temp file.
    2. Extract `num_frames` evenly-spaced frames with OpenCV.
    3. Build Professional Referee system prompt with sport rulebook.
    4. Send frames + prompt to llama3.2-vision via Ollama /api/chat.
    5. Parse and validate the strict JSON response.
    6. Return structured verdict.
    """
    # ── Validate file type ──────────────────────────────────────────────────
    allowed_types = {
        "video/mp4", "video/quicktime", "video/webm",
        "video/x-msvideo", "video/mpeg", "video/mov",
    }
    ct = video.content_type or ""
    if ct and ct not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ct}'. Upload MP4, MOV, or WebM.",
        )

    log.info("▶ /analyze  sport=%s  file=%s  frames=%d", sport, video.filename, num_frames)

    # ── Save to temp file ───────────────────────────────────────────────────
    suffix = Path(video.filename or "clip.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await video.read())
        tmp_path = tmp.name

    try:
        # ── Extract frames ──────────────────────────────────────────────────
        log.info("Extracting %d frames from %s …", num_frames, tmp_path)
        try:
            frames = extract_frames_b64(tmp_path, num_frames=num_frames)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        log.info("Extracted %d frames successfully.", len(frames))

        # ── Build prompts ───────────────────────────────────────────────────
        system_prompt = build_system_prompt(sport)
        user_message  = build_user_message(frames, original_call)

        # ── Call Ollama ─────────────────────────────────────────────────────
        raw_response = await call_ollama(
            system_prompt=system_prompt,
            user_message=user_message,
            frames=frames,
        )

        # ── Parse & return ──────────────────────────────────────────────────
        return parse_and_validate(raw_response, sport, len(frames))

    finally:
        # Always clean up the temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.get("/sports")
async def list_sports():
    """List all supported sports and their aliases."""
    return {
        "sports": list(SPORT_RULES.keys()),
        "aliases": _ALIASES,
    }
