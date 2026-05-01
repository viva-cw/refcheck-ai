"""
refcheck_simple.py  — Gemini 2.5 Flash VAR Analyzer  (FastAPI edition)
-----------------------------------------------------------------------
Runs as a FastAPI web server.  The core Gemini 2.5 Flash logic (frame
extraction, multimodal payload, generation config) is unchanged.

Run as server:
  uvicorn refcheck_simple:app --reload --port 8000

Still works as a CLI script:
  python refcheck_simple.py [path/to/clip.mp4]

Setup:
  pip install opencv-python-headless google-genai python-dotenv
              fastapi uvicorn python-multipart
  # Add GEMINI_API_KEY="..." to .env.local
"""

import base64
import gc
import json
import logging
import os
import pathlib
import sys
import tempfile
import time

import cv2
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("refcheck")

# ── Load .env.local from the script's own directory ───────────────────────────
_script_dir = pathlib.Path(__file__).parent.resolve()
load_dotenv(_script_dir / ".env.local")

# ── Load official IFAB Law 12 rulebook at startup ─────────────────────────────
try:
    _law_12_path = _script_dir / "data" / "soccer_law_12.txt"
    LAW_12_TEXT  = _law_12_path.read_text(encoding="utf-8")
    log.info("Loaded IFAB Law 12 rulebook (%d chars) from %s", len(LAW_12_TEXT), _law_12_path)
except OSError as _e:
    LAW_12_TEXT = "(IFAB Law 12 rulebook not found — ruling based on general knowledge.)"
    log.warning("Could not load soccer_law_12.txt: %s", _e)

# ── Load referee database at startup ──────────────────────────────────────
try:
    _ref_db_path = _script_dir / "data" / "referee_db.json"
    REFEREE_DB_DICT = json.loads(_ref_db_path.read_text(encoding="utf-8"))
    log.info("Loaded referee database from %s", _ref_db_path)
except Exception as _e:
    REFEREE_DB_DICT = {"referees": {}}
    log.warning("Could not load referee_db.json: %s", _e)

# ── Configuration (unchanged) ─────────────────────────────────────────────────
VIDEO_PATH      = "clip.mp4"
MODEL_NAME      = "gemini-2.5-flash"
NUM_FRAMES      = 30         # more frames → richer temporal context
MAX_WIDTH       = 512        # pixels — keeps payload manageable
JPEG_QUALITY    = 75         # slight quality bump now that we're not per-frame
MAX_OUT_TOKENS  = 4096       # gemini-2.5-flash uses thinking tokens; needs headroom
THINKING_BUDGET = 512        # cap chain-of-thought so output tokens aren't starved

VALID_VERDICTS = ["Fair Call", "Bad Call", "Inconclusive"]

# ── System prompt builder — accepts specific referee context ────────────────
def _build_system_prompt(referee_name: str = "", referee_data: str = "") -> str:
    referee_ctx_block = (
        f"The user has identified the referee for this play as {referee_name.strip()}.\n"
        f"Their historical tendencies are:\n{referee_data}\n"
        "Factor these tendencies into your analysis of the play.\n\n"
        if referee_name and referee_data
        else "REFEREE CONTEXT: Not provided or not found in database.\n\n"
    )
    return (
        "You are a professional FIFA Video Assistant Referee (VAR) and sports analytics expert.\n"
        "You will be shown a sequence of frames sampled evenly from a football (soccer) clip.\n"
        "Analyze the SEQUENCE for physical contact, dangerous play, holding, pushing, tripping, "
        "or any act that constitutes a foul or misconduct.\n\n"
        + referee_ctx_block +
        "You have also been provided with the official IFAB Law 12 (Fouls and Misconduct) below. "
        "When determining the verdict and providing reasoning, you MUST base your decision "
        "strictly on these provided rules. Quote or reference specific rule clauses "
        "(e.g., 'Law 12 Part 1 — Careless charge', 'VAR Protocol Part 6 — point of contact') "
        "in your reasoning.\n\n"
        "--- OFFICIAL IFAB LAW 12 ---\n"
        f"{LAW_12_TEXT}\n"
        "--- END OF RULEBOOK ---\n\n"
        "Respond with ONLY a valid JSON object — no markdown, no code fences, no extra text.\n"
        'The JSON must contain exactly eight keys: "verdict", "confidence_score", "reasoning", "referee_stats", '
        '"foul_frames", "detected_entities", "rule_alignment_score", and "visual_clarity_index".\n'
        '"verdict" must be exactly one of: "Fair Call", "Bad Call", or "Inconclusive".\n'
        '"confidence_score", "rule_alignment_score", and "visual_clarity_index" must be integers between 0 and 100.\n'
        '"reasoning" must be 2-3 sentences describing the motion sequence, '
        "citing specific visual evidence AND referencing the exact IFAB Law 12 clause (e.g. 'Law 12 Part 1') that supports your verdict.\n"
        '"referee_stats" must be an object with two string keys: "historical_bias" (1 sentence summary) and "accuracy_rating" (e.g. "High", "Medium", "Low").\n'
        '"foul_frames" must be an array of integers representing the specific frame numbers (1-30) where the focal action/foul occurs.\n'
        '"detected_entities" must be an array of strings like "[Player 42: Blue]", "[Player 4: White]", "[Ball: In Play]" identifying key objects.'
    )


SYSTEM_PROMPT = _build_system_prompt()   # default (no game context) for CLI use

USER_PROMPT = (
    "Analyze this sequence of frames under the provided IFAB Law 12 rulebook "
    "and return your JSON verdict with referee analysis, citing the specific rule clause."
)


# ── Gemini client (module-level singleton, initialised once at startup) ────────
def _build_client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        log.error("GEMINI_API_KEY not found in .env.local or environment.")
        log.error("Expected file: %s", _script_dir / ".env.local")
        # Don't hard-exit here — let FastAPI start and surface the error per-request
        return None  # type: ignore[return-value]
    return genai.Client(api_key=api_key)


_gemini_client: genai.Client | None = _build_client()


def get_client() -> genai.Client:
    """Return the module-level Gemini client, raising 503 if unconfigured."""
    if _gemini_client is None:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured. Add it to .env.local and restart.",
        )
    return _gemini_client


# ── Frame extraction (unchanged logic) ────────────────────────────────────────
def extract_frames(video_path: str, num_frames: int = NUM_FRAMES) -> list[bytes]:
    log.info("Opening video: %s", video_path)
    vidcap = cv2.VideoCapture(video_path)

    if not vidcap.isOpened():
        raise ValueError(f"Cannot open video file: '{video_path}'")

    total_frames = int(vidcap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps          = vidcap.get(cv2.CAP_PROP_FPS)
    duration     = total_frames / fps if fps > 0 else 0
    log.info("  Frames: %d | FPS: %.2f | Duration: %.2fs", total_frames, fps, duration)

    if total_frames <= 0:
        vidcap.release()
        raise ValueError("Video has no readable frames.")

    # Evenly space sample points; offset by half-step to avoid edge frames
    if total_frames <= num_frames:
        indices = list(range(total_frames))
    else:
        step    = total_frames / num_frames
        indices = [int(step * i + step / 2) for i in range(num_frames)]

    frame_bytes: list[bytes] = []
    for idx in indices:
        vidcap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = vidcap.read()
        if not ok:
            log.warning("  Could not read frame %d, skipping.", idx)
            continue

        h, w = frame.shape[:2]
        if w > MAX_WIDTH:
            scale = MAX_WIDTH / w
            frame = cv2.resize(
                frame, (MAX_WIDTH, int(h * scale)),
                interpolation=cv2.INTER_AREA,
            )

        encode_ok, buf = cv2.imencode(
            ".jpg", frame,
            [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY],
        )
        if encode_ok:
            frame_bytes.append(bytes(buf))

        frame = None  # drop raw frame immediately

    vidcap.release()
    cv2.destroyAllWindows()
    gc.collect()

    sizes_kb = [round(len(b) / 1024, 1) for b in frame_bytes]
    log.info("  Extracted %d frames. Sizes (KB): %s", len(frame_bytes), sizes_kb)

    if not frame_bytes:
        raise ValueError("No frames could be extracted from the video.")

    return frame_bytes


# ── Gemini inference (unchanged generation config) ────────────────────────────
def analyze_sequence(client: genai.Client, frame_bytes: list[bytes], referee_name: str = "") -> dict:
    """
    Send ALL frames in one multimodal payload so Gemini can reason about
    motion across the entire sequence, then return a parsed Python dict.
    Extracts specific referee data from the database to inject.
    """
    referee_data_str = ""
    if referee_name:
        referees = REFEREE_DB_DICT.get("referees", {})
        if referee_name in referees:
            referee_data_str = json.dumps(referees[referee_name], indent=2)
        else:
            log.warning("Referee '%s' not found in database.", referee_name)
    log.info("Sending %d frames to %s …", len(frame_bytes), MODEL_NAME)

    parts: list[types.Part] = [
        types.Part.from_bytes(data=fb, mime_type="image/jpeg")
        for fb in frame_bytes
    ]
    parts.append(types.Part.from_text(text=USER_PROMPT))

    try:
        start_time = time.time()
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=_build_system_prompt(referee_name, referee_data_str),
                temperature=0.2,
                max_output_tokens=MAX_OUT_TOKENS,
                thinking_config=types.ThinkingConfig(
                    thinking_budget=THINKING_BUDGET,
                ),
            ),
        )
        inference_time_seconds = round(time.time() - start_time, 2)

        raw = response.text.strip()
        log.info("Gemini response received in %.2fs (%d chars).", inference_time_seconds, len(raw))
        return parse_response(raw, inference_time_seconds)
    except Exception as e:
        log.error("Error calling Gemini API: %s", e)
        return {
            "verdict": "Inconclusive", 
            "confidence_score": 0,
            "reasoning": f"Gemini API error: {e}", 
            "referee_stats": {"historical_bias": "N/A", "accuracy_rating": "N/A"},
            "foul_frames": [],
            "detected_entities": [],
            "rule_alignment_score": 0,
            "visual_clarity_index": 0,
            "inference_time_seconds": 0
        }


# ── JSON parsing / validation ───────────────────────────────────────────────
def parse_response(raw: str, inference_time_seconds: float) -> dict:
    cleaned = raw.strip()

    # Strip any accidental markdown code fences
    if cleaned.startswith("```"):
        cleaned = "\n".join(
            ln for ln in cleaned.splitlines() if not ln.strip().startswith("```")
        ).strip()

    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError:
        log.warning("Model returned invalid JSON. Raw (%d chars): %s", len(raw), raw[:300])
        return {
            "verdict": "Inconclusive", 
            "confidence_score": 0, 
            "reasoning": "Could not parse model response.", 
            "referee_stats": {"historical_bias": "N/A", "accuracy_rating": "N/A"},
            "inference_time_seconds": inference_time_seconds
        }

    verdict          = str(obj.get("verdict",          "")).strip()
    reasoning        = str(obj.get("reasoning",        "")).strip()
    
    # Safely parse confidence_score
    try:
        confidence_score = int(obj.get("confidence_score", 0))
    except (ValueError, TypeError):
        confidence_score = 0
        
    try:
        rule_alignment_score = int(obj.get("rule_alignment_score", 0))
    except (ValueError, TypeError):
        rule_alignment_score = 0
        
    try:
        visual_clarity_index = int(obj.get("visual_clarity_index", 0))
    except (ValueError, TypeError):
        visual_clarity_index = 0
        
    foul_frames = obj.get("foul_frames", [])
    if not isinstance(foul_frames, list): foul_frames = []
    
    detected_entities = obj.get("detected_entities", [])
    if not isinstance(detected_entities, list): detected_entities = []

    # Safely parse referee_stats
    raw_stats = obj.get("referee_stats", {})
    if not isinstance(raw_stats, dict):
        raw_stats = {}
        
    referee_stats = {
        "historical_bias": str(raw_stats.get("historical_bias", "N/A")).strip(),
        "accuracy_rating": str(raw_stats.get("accuracy_rating", "N/A")).strip()
    }

    if verdict not in VALID_VERDICTS:
        log.warning("Unexpected verdict '%s' → defaulting to 'Inconclusive'.", verdict)
        verdict = "Inconclusive"

    return {
        "verdict": verdict, 
        "confidence_score": confidence_score, 
        "reasoning": reasoning, 
        "referee_stats": referee_stats,
        "foul_frames": foul_frames,
        "detected_entities": detected_entities,
        "rule_alignment_score": rule_alignment_score,
        "visual_clarity_index": visual_clarity_index,
        "inference_time_seconds": inference_time_seconds
    }


# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="RefCheck AI — Gemini VAR Backend",
    description="Upload a soccer clip and receive a rule-based VAR verdict powered by Gemini 2.5 Flash.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Confirm the server and Gemini client are ready."""
    api_key_set = bool(os.environ.get("GEMINI_API_KEY"))
    return {
        "status": "ok" if api_key_set else "degraded",
        "model": MODEL_NAME,
        "api_key_configured": api_key_set,
    }


@app.post("/analyze")
async def analyze(
    video:        UploadFile = File(..., description="Soccer video clip (MP4/MOV/WebM)"),
    referee_name: str        = Form("", description='Optional referee name from frontend'),
):
    """
    Upload a short soccer clip and receive a VAR verdict.

    Pipeline:
      1. Save upload to a temp file on disk.
      2. Extract NUM_FRAMES evenly-spaced frames with OpenCV.
      3. Send all frames in one multimodal request to Gemini 2.5 Flash.
      4. Parse and validate the JSON verdict.
      5. Delete the temp file.
      6. Return { verdict, reasoning }.
    """
    client = get_client()

    # ── Validate MIME type ────────────────────────────────────────────────────
    # Only hard-reject explicitly non-video types (image/*, text/*, etc.).
    # application/octet-stream is allowed because curl and some browsers send
    # that instead of video/mp4 for binary uploads.
    ct = video.content_type or ""
    if ct and not ct.startswith("video/") and ct not in ("application/octet-stream", ""):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ct}'. Upload MP4, MOV, or WebM.",
        )

    log.info("▶ /analyze  file=%s  content_type=%s", video.filename, ct)

    # ── Save to temp file ─────────────────────────────────────────────────────
    suffix  = pathlib.Path(video.filename or "clip.mp4").suffix or ".mp4"
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await video.read())
            tmp_path = tmp.name
        log.info("  Saved upload to %s", tmp_path)

        # ── Extract frames ────────────────────────────────────────────────────
        try:
            frame_bytes = extract_frames(tmp_path, NUM_FRAMES)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        # ── Run Gemini inference ──────────────────────────────────────────────
        try:
            result = analyze_sequence(client, frame_bytes, referee_name)
            # Encode frames as Base64 so the frontend can display them
            result["frames"] = [base64.b64encode(fb).decode("utf-8") for fb in frame_bytes]
        except Exception as exc:
            log.error("Gemini error: %s", exc)
            raise HTTPException(
                status_code=502,
                detail=f"Gemini inference failed: {type(exc).__name__}: {exc}",
            )
        finally:
            del frame_bytes
            gc.collect()

    finally:
        # Always delete the temp file regardless of success or failure
        if tmp_path:
            try:
                os.unlink(tmp_path)
                log.info("  Deleted temp file %s", tmp_path)
            except OSError:
                pass

    log.info("  Result: %s", result)
    return result


# ── /chat endpoint ────────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    question: str
    context: str  # The verdict + reasoning from /analyze, serialised as a string


def _build_chat_system(context: str) -> str:
    return (
        "You are a professional FIFA Video Assistant Referee (VAR).\n"
        "You just issued the following ruling on a play:\n\n"
        f"{context}\n\n"
        "You have been provided with the official IFAB Law 12 below. "
        "When defending or clarifying your ruling, you MUST reference specific rule clauses "
        "from this document to justify your decision.\n\n"
        "--- OFFICIAL IFAB LAW 12 ---\n"
        f"{LAW_12_TEXT}\n"
        "--- END OF RULEBOOK ---\n\n"
        "A viewer is asking you a follow-up question. "
        "Answer in 1-2 short, conversational sentences, citing the specific IFAB Law 12 clause "
        "that supports your call. Be direct and confident."
    )


@app.post("/chat")
async def chat(req: ChatRequest):
    """
    Follow-up Q&A about a previous /analyze ruling.
    Receives { question, context } and returns { answer }.
    """
    client = get_client()

    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty.")

    system_prompt = _build_chat_system(req.context.strip() or "No ruling context provided.")

    log.info("▶ /chat  question=%r", req.question[:80])

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=req.question,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.4,
                max_output_tokens=256,
                thinking_config=types.ThinkingConfig(thinking_budget=128),
            ),
        )
        answer = response.text.strip()
    except Exception as exc:
        log.error("Gemini chat error: %s", exc)
        raise HTTPException(status_code=502, detail=f"Gemini error: {exc}")

    log.info("  Chat answer: %s", answer[:120])
    return {"answer": answer}


# ── CLI entry-point (unchanged behaviour) ─────────────────────────────────────
def main():
    video_path = sys.argv[1] if len(sys.argv) > 1 else VIDEO_PATH

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print(f"ERROR: GEMINI_API_KEY not found. Add it to {_script_dir / '.env.local'}")
        sys.exit(1)

    client = genai.Client(api_key=api_key)
    print(f"[0/3] Gemini client configured → model: {MODEL_NAME}\n")

    frame_bytes = extract_frames(video_path, NUM_FRAMES)

    print(f"[2/3] Sending {len(frame_bytes)} frames to {MODEL_NAME} …", end=" ", flush=True)
    final = analyze_sequence(client, frame_bytes)
    print("OK\n")

    del frame_bytes
    gc.collect()

    print("[3/3] VAR decision received.\n")
    print("=" * 62)
    print("  VAR FINAL DECISION")
    print("=" * 62)
    print(f"  Verdict  : {final['verdict']}")
    print(f"  Reasoning: {final['reasoning']}")
    print("=" * 62)
    print("\nJSON output:")
    print(json.dumps(final, indent=2))


if __name__ == "__main__":
    main()
