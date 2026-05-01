# RefCheck AI — FastAPI + Ollama Backend

Local AI officiating analysis using **llama3.2-vision** running via Ollama.  
No cloud API key required — fully offline after model download.

---

## Architecture

```
POST /analyze
      │
      ├─ 1. Save upload to temp file
      ├─ 2. Extract N frames with OpenCV  (evenly spaced via linspace)
      ├─ 3. Build system prompt           (Professional Referee + sport rules)
      ├─ 4. POST to Ollama /api/chat      (llama3.2-vision, format: json, temp: 0.1)
      ├─ 5. Parse + validate JSON         (field aliasing + Pydantic validation)
      └─ 6. Return AnalysisResponse
```

---

## Setup

### 1. Start Ollama and pull the vision model

```bash
# Start the Ollama server (background)
ollama serve &

# Pull llama3.2-vision (~7 GB, one-time download)
ollama pull llama3.2-vision
```

### 2. Create venv and install dependencies

```bash
cd backend/
python3 -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Run the server

```bash
uvicorn main:app --reload --port 8000
```

The server starts at **http://localhost:8000**  
Interactive docs at **http://localhost:8000/docs**

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Check Ollama connection + model availability |
| `POST` | `/analyze` | Analyze a video clip |
| `GET` | `/sports` | List supported sports and aliases |

---

## POST /analyze

**Form fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `video` | file | ✅ | — | MP4 / MOV / WebM clip |
| `sport` | string | — | `basketball` | Sport name or alias |
| `original_call` | string | — | `null` | Referee's original call |
| `num_frames` | int | — | `10` | Frames to extract (1–20) |

**Example with curl:**

```bash
curl -X POST http://localhost:8000/analyze \
  -F "video=@clip.mp4" \
  -F "sport=basketball" \
  -F "original_call=Blocking foul on #23" \
  -F "num_frames=10"
```

**Response:**

```json
{
  "success": true,
  "analysis": {
    "verdict": "Bad Call",
    "confidence": "High",
    "play_description": "The defender is still moving laterally at the moment of contact...",
    "rule_based_reasoning": "Per NBA Rule 12B, the defender had not established legal guarding position before the offensive player's upward motion. The defender's feet were not set and the body was still in lateral motion at the time of contact, which satisfies the definition of a Blocking foul (defensive foul), not a Charge."
  },
  "metadata": {
    "sport": "basketball",
    "model": "llama3.2-vision",
    "frames_analyzed": 10,
    "ollama_url": "http://localhost:11434"
  }
}
```

---

## How JSON enforcement works

The request to Ollama uses two mechanisms:

1. **`"format": "json"`** — Ollama grammar-based forcing: the model's token sampling is constrained to only produce valid JSON.
2. **System prompt schema** — The Professional Referee system instruction explicitly shows the required JSON structure and says *"No markdown, no prose, no code fences."*

The response is then validated by Pydantic `AnalysisResult` with field aliasing (e.g. `reasoning` → `rule_based_reasoning`) and verdict normalization.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server address |
| `OLLAMA_MODEL` | `llama3.2-vision` | Vision model to use |
| `NUM_FRAMES` | `10` | Default frames to extract |
| `OLLAMA_TIMEOUT` | `120` | Request timeout in seconds |

---

## Supported Sports

| Sport | Aliases | Rules Source |
|-------|---------|--------------|
| basketball | nba | NBA Official Rules |
| soccer | futbol | FIFA Laws of the Game |
| americanfootball | nfl, football | NFL Official Rules |
| baseball | mlb | Official Baseball Rules |
| hockey | nhl | NHL Official Rules |
| tennis | — | ITF Rules / ATP-WTA Code |
