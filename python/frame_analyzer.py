"""
RefCheck AI — Python Frame Extraction & Analysis Engine
=======================================================
Extracts 10 key frames evenly distributed across a video clip using OpenCV,
then sends them to Gemini 1.5 Flash for rule-based officiating analysis.

Usage:
    python frame_analyzer.py <video_path> --sport basketball [--call "Blocking foul"]
    python frame_analyzer.py clip.mp4 --sport soccer --call "Offside"
    python frame_analyzer.py clip.mp4 --sport nba --frames 10 --output result.json
"""

import cv2
import os
import sys
import json
import base64
import argparse
import tempfile
import logging
from pathlib import Path
from typing import Optional
from io import BytesIO

import google.genai as genai
from google.genai import types
from PIL import Image

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("refcheck")

# ─── Sport Rulebook Context ────────────────────────────────────────────────────
# Each entry provides the official rules injected into the AI prompt.
# Extend this dict to add new sports.

SPORT_RULES: dict[str, str] = {
    "basketball": """
NBA Official Rules — Key Officiating Sections:
- Rule 12B (Personal Fouls): Illegal physical contact with an opponent.
- Blocking vs Charging: A defender who establishes legal guarding position
  (both feet on the floor, facing the opponent, torso in the path of travel)
  BEFORE the offensive player begins their upward shooting motion earns a
  CHARGE (offensive foul). If the defender is still moving laterally or has
  not established position, it is a BLOCK (defensive foul).
- Restricted Area Arc: Inside the arc directly under the basket, a defender
  cannot draw a charge unless they are clearly outside the arc.
- Verticality Rule: A defender has the right to hold their vertical plane;
  if an offensive player leans into a vertically jumping defender, the foul
  is on the offense.
- Rule 10 (Violations): Traveling = moving without dribbling (gather step +
  2 steps). Double dribble = resuming a dribble after it has stopped.
- Flagrant Fouls: Unnecessary (FF1) or excessive (FF2) contact — FF2 = ejection.
""",
    "soccer": """
FIFA Laws of the Game — Key Officiating Sections:
- Law 12 (Fouls and Misconduct): Direct free-kick offenses: charging, jumping
  at, kicking, pushing, striking, tackling/challenging carelessly/recklessly/
  with disproportionate force, or tripping an opponent.
- Handball: A deliberate handball is always an offense. An accidental handball
  that directly creates a goal or clear goal-scoring opportunity is also an
  offense. Arms above shoulder height or making the body unnaturally bigger
  are typically penalized.
- Offside (Law 11): Player is in offside POSITION if any part of their head,
  body, or feet (not arms) is nearer to the goal line than both the ball and
  the second-to-last opponent at the moment the ball is played to them.
- DOGSO: Denying an Obvious Goal-Scoring Opportunity = red card.
- Advantage: Referee may play advantage if the non-offending team benefits.
- VAR Protocol: Video review used for goals, penalties, red cards, mistaken identity.
""",
    "americanfootball": """
NFL Official Playing Rules — Key Officiating Sections:
- Pass Interference: A defender cannot significantly hinder an eligible
  receiver's ability to catch the ball after it is in the air. Contact within
  1 yard of the line of scrimmage is legal. Incidental contact is not a foul.
- Roughing the Passer: Forcible contact to the QB after clearly releasing the
  ball. Defenders must make a reasonable effort to avoid the passer; landing
  with full weight on the QB is a foul.
- Holding: Using hands/arms to materially restrict an opponent's movement.
  Defensive holding on pass plays = 5-yard penalty + automatic first down.
- Targeting: Initiating forcible contact with the helmet to the head/neck area
  of a defenseless player, or lowering the head to initiate contact.
- Catch Definition: (1) Control the ball with hands/arms before touching ground,
  (2) both feet or one knee in-bounds, (3) perform a football move or survive contact.
""",
    "baseball": """
Official Baseball Rules (MLB) — Key Officiating Sections:
- Strike Zone: The area over home plate from the midpoint of the batter's
  torso to the hollow below the kneecap, in the batter's natural stance.
- Checked Swing: A half swing is a strike if the bat head passes the front of
  the plate; breaking the wrist is the common on-field indicator.
- Tag Play vs Force Play: Force play — fielder touches base with ball before
  runner. Tag play — fielder must tag the runner with the ball before they
  reach the base.
- Infield Fly Rule: Fair fly ball catchable by an infielder with ordinary
  effort, runners on 1st & 2nd (or loaded), fewer than 2 outs — batter is
  automatically out, runners need not advance.
- Balk: Illegal motion by the pitcher with runners on base; all runners
  advance one base.
""",
    "hockey": """
NHL Official Rules — Key Officiating Sections:
- Goaltender Interference: A player cannot contact the goaltender in the
  crease or impair their ability to defend. Incidental contact alone does NOT
  automatically void a goal.
- Icing: Shooting the puck from one's own side of center ice past the
  opposing goal line without it being touched — hybrid icing stops play at the
  faceoff dot. Exception: shorthanded team.
- High-Sticking: Carrying the stick above opponent shoulder height and making
  contact is a penalty; a goal scored via high-stick is disallowed.
- Offside: Both skates must be completely over the attacking blue line before
  the puck — assessed by skate position, not stick position.
- Boarding/Charging: Checking an opponent violently into the boards, or using
  excessive strides to build momentum before contact.
""",
    "tennis": """
ITF Rules of Tennis / ATP-WTA Code — Key Officiating Sections:
- Ball In/Out: A ball is "in" if ANY part touches the court lines.
- Let: A serve that clips the net cord and lands correctly in the service box
  — serve is retaken. Any other ball clipping the net and landing in is live.
- Foot Fault: Server must not touch the baseline or the area inside it with
  either foot before striking the ball, nor change position by running.
- Hindrance: A player may stop play if hindered by something outside their
  control. Deliberate hindrance = loss of point.
- Hawkeye: Electronic line-calling measures the ball's contact mark on the
  playing surface; call is based on landing contact, not bounce trajectory.
""",
}

# Normalize alternate sport names to canonical keys
_SPORT_ALIASES: dict[str, str] = {
    "nba": "basketball",
    "nfl": "americanfootball",
    "football": "americanfootball",
    "mlb": "baseball",
    "nhl": "hockey",
    "futbol": "soccer",
    "football_american": "americanfootball",
}


def resolve_sport(sport: str) -> str:
    """Normalize sport name to a canonical key."""
    key = sport.lower().strip().replace(" ", "")
    return _SPORT_ALIASES.get(key, key)


# ─── Frame Extraction ──────────────────────────────────────────────────────────

def extract_frames(
    video_path: str,
    num_frames: int = 10,
    output_dir: Optional[str] = None,
    quality: int = 90,
) -> list[dict]:
    """
    Extract `num_frames` key frames evenly distributed across a video.

    Args:
        video_path:  Path to the input video file.
        num_frames:  Number of frames to extract (default: 10).
        output_dir:  If provided, save JPEG frames to this directory.
                     If None, frames are kept in memory only.
        quality:     JPEG quality for saved/encoded frames (1-100).

    Returns:
        List of dicts, each containing:
            {
                "index":       frame index in the extraction sequence (0-based),
                "frame_number": actual frame number in the video,
                "timestamp_s": timestamp in seconds,
                "timestamp_str": "MM:SS.mmm" human-readable timestamp,
                "image_bytes": JPEG bytes (in-memory),
                "file_path":  path to saved file (if output_dir was given),
            }

    Raises:
        FileNotFoundError: If video_path does not exist.
        RuntimeError:      If the video cannot be opened or has no frames.
    """
    path = Path(video_path)
    if not path.exists():
        raise FileNotFoundError(f"Video file not found: {video_path}")

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video file: {video_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    if total_frames <= 0:
        cap.release()
        raise RuntimeError(f"Video has no readable frames: {video_path}")

    num_frames = min(num_frames, total_frames)
    log.info(
        "Video: %s | Frames: %d | FPS: %.2f | Duration: %.2fs",
        path.name, total_frames, fps, total_frames / fps,
    )

    # Evenly space frame indices across the video duration.
    # Use linspace so first frame ≈ start and last frame ≈ end.
    if num_frames == 1:
        indices = [total_frames // 2]
    else:
        step = (total_frames - 1) / (num_frames - 1)
        indices = [round(i * step) for i in range(num_frames)]

    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    extracted: list[dict] = []
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, quality]

    for seq_idx, frame_num in enumerate(indices):
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
        success, frame_bgr = cap.read()

        if not success or frame_bgr is None:
            log.warning("Could not read frame %d — skipping.", frame_num)
            continue

        # Convert BGR → RGB for correct color representation
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

        # Encode to JPEG in memory
        success_enc, buffer = cv2.imencode(".jpg", frame_bgr, encode_params)
        if not success_enc:
            log.warning("Could not encode frame %d — skipping.", frame_num)
            continue

        image_bytes = buffer.tobytes()
        timestamp_s = frame_num / fps
        minutes = int(timestamp_s // 60)
        seconds = timestamp_s % 60
        timestamp_str = f"{minutes:02d}:{seconds:06.3f}"

        record: dict = {
            "index": seq_idx,
            "frame_number": frame_num,
            "timestamp_s": round(timestamp_s, 3),
            "timestamp_str": timestamp_str,
            "image_bytes": image_bytes,
            "file_path": None,
        }

        if output_dir:
            filename = f"frame_{seq_idx:02d}_t{timestamp_str.replace(':', '-')}.jpg"
            file_path = os.path.join(output_dir, filename)
            with open(file_path, "wb") as f:
                f.write(image_bytes)
            record["file_path"] = file_path
            log.debug("  Saved frame %02d → %s", seq_idx, file_path)

        extracted.append(record)
        log.info(
            "  [%02d/%02d] Frame #%d @ %s",
            seq_idx + 1, num_frames, frame_num, timestamp_str,
        )

    cap.release()

    if not extracted:
        raise RuntimeError("No frames could be extracted from the video.")

    log.info("Extracted %d frames successfully.", len(extracted))
    return extracted


# ─── Gemini Analysis ───────────────────────────────────────────────────────────

def build_system_instruction(sport: str) -> str:
    """
    Build the system instruction for Gemini, injecting the sport-specific
    rulebook. The AI is instructed to behave as a strict, neutral referee.
    """
    sport_key = resolve_sport(sport)
    rules = SPORT_RULES.get(sport_key, f"Apply the standard official rules for {sport_key}.")

    return f"""You are a Professional Sports Officiating Consultant and Rules Analyst \
with 20+ years of experience as a certified referee. Your sole responsibility \
is to provide objective, rule-based verdicts on sports plays.

SPORT BEING ANALYZED: {sport_key.upper()}

OFFICIAL RULEBOOK REFERENCE:
{rules}

BEHAVIORAL DIRECTIVES (follow strictly):
1. Analyze the provided frames in chronological order.
2. Pay close attention to: player body position, feet placement, arm/hand \
position, timing of contact, and trajectory of movement.
3. Compare your visual observations ONLY against the rules provided above.
4. Do NOT speculate or invent facts not visible in the frames.
5. If evidence is ambiguous or frames are insufficient, choose "Inconclusive" \
— never force a verdict you cannot justify visually.
6. Your temperature is set to near-zero: be precise, rigid, and factual.
7. Always cite the specific rule name/number in your reasoning.

OUTPUT FORMAT: You must respond with ONLY a valid JSON object — no markdown, \
no prose, no code fences. Use this exact structure:
{{
  "verdict": "Fair Call | Bad Call | Inconclusive",
  "confidence": "Low | Medium | High",
  "play_description": "Objective summary of what is visually observed across the frames.",
  "reasoning": "Detailed rule-cited explanation referencing specific frame observations.",
  "relevant_rule": "Exact rule name or category, e.g. NBA Rule 12B — Blocking vs Charging",
  "key_frames": [frame indices (0-based) that were most decisive for the verdict]
}}"""


def build_user_prompt(num_frames: int, original_call: Optional[str]) -> str:
    """Build the per-request user message."""
    call_context = (
        f'The referee\'s original call was: "{original_call}". '
        f"Evaluate whether this call was correct."
        if original_call and original_call.strip()
        else "No original call was provided. Determine whether any violation or foul occurred."
    )

    return (
        f"I am providing {num_frames} frames extracted evenly across the video clip, "
        f"listed in chronological order (earliest → latest).\n\n"
        f"{call_context}\n\n"
        f"Analyze each frame carefully, then provide your officiating verdict as a JSON object."
    )


def analyze_play(
    video_path: str,
    sport: str,
    original_call: Optional[str] = None,
    num_frames: int = 10,
    api_key: Optional[str] = None,
    model_name: str = "gemini-1.5-flash",
    temperature: float = 0.15,
    save_frames_dir: Optional[str] = None,
) -> dict:
    """
    Full pipeline: extract frames → send to Gemini → return structured verdict.

    Args:
        video_path:      Path to the video clip.
        sport:           Sport name (e.g. "basketball", "soccer", "nba").
        original_call:   The referee's original call (optional).
        num_frames:      Number of frames to extract (default: 10).
        api_key:         Gemini API key. Falls back to GEMINI_API_KEY env var.
        model_name:      Gemini model to use (default: gemini-1.5-flash).
        temperature:     Model temperature; keep very low for rigidity.
        save_frames_dir: Directory to save extracted frames as JPEG files.

    Returns:
        dict with keys: verdict, confidence, play_description, reasoning,
                        relevant_rule, key_frames, metadata
    """
    # ── API key ──────────────────────────────────────────────────────────────
    resolved_key = api_key or os.environ.get("GEMINI_API_KEY", "")
    if not resolved_key:
        raise EnvironmentError(
            "Gemini API key not found. Set GEMINI_API_KEY env var or pass api_key=."
        )
    client = genai.Client(api_key=resolved_key)

    # ── Step 1: Extract frames ────────────────────────────────────────────────
    log.info("── Step 1: Extracting %d frames from '%s' ──", num_frames, video_path)
    frames = extract_frames(video_path, num_frames=num_frames, output_dir=save_frames_dir)

    if not frames:
        raise RuntimeError("Frame extraction produced no results.")

    # ── Step 2: Build Gemini request content ──────────────────────────────────
    log.info("── Step 2: Building Gemini request ──")

    sport_canonical = resolve_sport(sport)
    system_instruction = build_system_instruction(sport_canonical)
    user_prompt = build_user_prompt(len(frames), original_call)

    # Build content parts: text prompt + one image per frame
    content_parts: list = [user_prompt]

    for frame in frames:
        img_pil = Image.open(BytesIO(frame["image_bytes"]))
        content_parts.append(
            f"[Frame {frame['index'] + 1}/{len(frames)} — {frame['timestamp_str']}]"
        )
        content_parts.append(img_pil)

    # ── Step 3: Configure model ───────────────────────────────────────────────
    log.info("── Step 3: Calling Gemini %s (temp=%.2f) ──", model_name, temperature)

    response = client.models.generate_content(
        model=model_name,
        contents=content_parts,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            top_p=0.8,
            max_output_tokens=1024,
            response_mime_type="application/json",
        ),
    )
    raw_text = response.text.strip()

    log.info("── Step 4: Parsing response ──")
    log.debug("Raw response:\n%s", raw_text)

    # ── Step 4: Parse + validate JSON ─────────────────────────────────────────
    # Strip markdown code fences if the model wraps them despite instructions
    cleaned = raw_text
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    if cleaned.endswith("```"):
        cleaned = cleaned[: cleaned.rfind("```")].strip()

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError as e:
        log.error("JSON parse error: %s\nRaw text: %s", e, raw_text)
        raise ValueError(f"Gemini returned invalid JSON: {e}") from e

    required_fields = ["verdict", "confidence", "play_description", "reasoning", "relevant_rule"]
    missing = [f for f in required_fields if f not in result]
    if missing:
        raise ValueError(f"Gemini response missing required fields: {missing}")

    valid_verdicts = {"Fair Call", "Bad Call", "Inconclusive"}
    if result["verdict"] not in valid_verdicts:
        log.warning(
            "Unexpected verdict value '%s' — forcing 'Inconclusive'.", result["verdict"]
        )
        result["verdict"] = "Inconclusive"

    # Attach extraction metadata
    result["metadata"] = {
        "video_path": str(Path(video_path).resolve()),
        "sport": sport_canonical,
        "model": model_name,
        "temperature": temperature,
        "frames_extracted": len(frames),
        "frame_timestamps": [f["timestamp_str"] for f in frames],
        "original_call": original_call,
    }

    log.info(
        "✓ Verdict: %s (Confidence: %s)",
        result["verdict"],
        result["confidence"],
    )
    return result


# ─── CLI Entry Point ───────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="frame_analyzer",
        description="RefCheck AI — Extract video frames and analyze a sports play with Gemini.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python frame_analyzer.py clip.mp4 --sport basketball
  python frame_analyzer.py play.mov --sport soccer --call "Penalty kick awarded"
  python frame_analyzer.py game.mp4 --sport nba --frames 12 --save-frames ./frames --output result.json
  python frame_analyzer.py clip.mp4 --sport hockey --verbose
        """,
    )
    parser.add_argument("video", help="Path to the video clip to analyze.")
    parser.add_argument(
        "--sport",
        required=True,
        help="Sport name: basketball, soccer, americanfootball, baseball, hockey, tennis, or alias (nba, nfl, mlb, nhl).",
    )
    parser.add_argument(
        "--call",
        default=None,
        metavar="ORIGINAL_CALL",
        help='The referee\'s original call (optional). E.g. "Blocking foul on #23".',
    )
    parser.add_argument(
        "--frames",
        type=int,
        default=10,
        metavar="N",
        help="Number of frames to extract (default: 10).",
    )
    parser.add_argument(
        "--save-frames",
        default=None,
        metavar="DIR",
        help="Directory to save extracted JPEG frames.",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="FILE",
        help="Write the JSON result to this file (default: print to stdout).",
    )
    parser.add_argument(
        "--model",
        default="gemini-1.5-flash",
        help="Gemini model to use (default: gemini-1.5-flash).",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.15,
        help="Model temperature 0.0–1.0 (default: 0.15).",
    )
    parser.add_argument(
        "--api-key",
        default=None,
        help="Gemini API key (defaults to GEMINI_API_KEY env var).",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug logging.",
    )
    parser.add_argument(
        "--list-sports",
        action="store_true",
        help="Print all supported sports and exit.",
    )

    args = parser.parse_args()

    if args.list_sports:
        print("\nSupported sports:")
        for name in SPORT_RULES:
            print(f"  {name}")
        print("\nAliases:")
        for alias, canon in _SPORT_ALIASES.items():
            print(f"  {alias} → {canon}")
        sys.exit(0)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    try:
        result = analyze_play(
            video_path=args.video,
            sport=args.sport,
            original_call=args.call,
            num_frames=args.frames,
            api_key=args.api_key,
            model_name=args.model,
            temperature=args.temperature,
            save_frames_dir=args.save_frames,
        )
    except (FileNotFoundError, RuntimeError, ValueError, EnvironmentError) as exc:
        log.error("Analysis failed: %s", exc)
        sys.exit(1)

    # ── Output ────────────────────────────────────────────────────────────────
    output_json = json.dumps(result, indent=2, ensure_ascii=False)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output_json, encoding="utf-8")
        log.info("Result written to: %s", out_path)
    else:
        print("\n" + "─" * 60)
        print("REFCHECK AI — ANALYSIS RESULT")
        print("─" * 60)
        print(output_json)
        print("─" * 60)


if __name__ == "__main__":
    main()
