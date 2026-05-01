# RefCheck AI — Python Backend

Frame extraction and AI analysis engine for the GDG BorderHack 2026 challenge.

## What this does

1. **Frame Extraction** — uses `OpenCV` to sample exactly N frames (default: 10) evenly distributed across the video duration
2. **Gemini Analysis** — sends the frames to `Gemini 1.5 Flash` with:
   - A system instruction that acts as a professional referee
   - Sport-specific official rulebook text injected as context
   - Strict JSON output enforced via `response_mime_type`
3. **Structured Output** — returns a validated JSON verdict matching the frontend API contract

---

## Setup

```bash
cd python/

# Create a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

Set your API key:

```bash
export GEMINI_API_KEY="your_gemini_api_key_here"
```

---

## Usage

### Basic

```bash
python frame_analyzer.py clip.mp4 --sport basketball
```

### With the original referee call

```bash
python frame_analyzer.py play.mov --sport soccer --call "Penalty kick awarded for handball"
```

### Save extracted frames + write result to file

```bash
python frame_analyzer.py game.mp4 --sport nba \
  --frames 10 \
  --save-frames ./extracted_frames \
  --output result.json \
  --verbose
```

### Use a different Gemini model

```bash
python frame_analyzer.py clip.mp4 --sport hockey --model gemini-1.5-pro
```

### List supported sports

```bash
python frame_analyzer.py --list-sports
```

---

## Supported Sports

| Name | Alias(es) | Rules Source |
|------|-----------|--------------|
| `basketball` | `nba` | NBA Official Rules |
| `soccer` | `futbol` | FIFA Laws of the Game |
| `americanfootball` | `nfl`, `football` | NFL Official Rules |
| `baseball` | `mlb` | Official Baseball Rules |
| `hockey` | `nhl` | NHL Official Rules |
| `tennis` | — | ITF Rules / ATP-WTA Code |

---

## Output Format

```json
{
  "verdict": "Fair Call | Bad Call | Inconclusive",
  "confidence": "Low | Medium | High",
  "play_description": "Objective summary of visual evidence.",
  "reasoning": "Rule-cited explanation referencing specific frame observations.",
  "relevant_rule": "NBA Rule 12B — Blocking vs Charging",
  "key_frames": [3, 5, 7],
  "metadata": {
    "video_path": "/absolute/path/to/clip.mp4",
    "sport": "basketball",
    "model": "gemini-1.5-flash",
    "temperature": 0.15,
    "frames_extracted": 10,
    "frame_timestamps": ["00:00.000", "00:01.200", "..."],
    "original_call": "Blocking foul on #23"
  }
}
```

---

## How Frame Extraction Works

```
Video (N total frames)
│
├── frame 0        ← extracted (index 0)
├── ...
├── frame N/9      ← extracted (index 1)
├── ...
├── frame 2×N/9   ← extracted (index 2)
├── ...            (evenly spaced using linspace)
└── frame N-1      ← extracted (index 9)
```

`cv2.CAP_PROP_POS_FRAMES` is used to seek directly to each target frame, avoiding sequential reads.  
Frames are converted from BGR (OpenCV default) to RGB before encoding.

---

## Running Tests

```bash
python -m pytest test_frame_analyzer.py -v
```

Tests cover:
- Sport name resolution and aliases
- System instruction content validation  
- Frame structure and ordering
- Disk-save behavior
- Mocked Gemini integration (no real API calls needed)

---

## Integration with Next.js Backend

This Python script is a **standalone companion** to the Next.js API route at  
`app/api/analyze/route.ts`. Both implement the same analysis pipeline:

| Layer | Tool | Approach |
|-------|------|----------|
| Next.js API | `@google/generative-ai` | Uploads full video via Files API |
| Python script | `google-generativeai` + OpenCV | Extracts frames, sends as images |

The Python approach gives you finer control over which frames are selected and lets you run analysis without a browser or Next.js server.
