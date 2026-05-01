# RefCheck AI ⚖️
https://refcheck-du5d9kdo6-tolstois-projects.vercel.app/
> AI-powered sports officiating analysis — Upload a clip, get a rule-based verdict.

Built for **GDG BorderHack 2026** ($2,000 Bounty Challenge)

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Gemini](https://img.shields.io/badge/Gemini-1.5_Flash-blue)](https://ai.google.dev)

---

## 🎯 What It Does

RefCheck AI lets users upload a short sports video clip and receive an **objective, rule-based verdict** on whether the referee's call was correct — powered by **Gemini 1.5 Flash** multimodal AI.

**Supported Sports:** Basketball · Soccer · American Football · Baseball · Hockey · Tennis

**Output includes:**
- **Verdict:** `Fair Call` | `Bad Call` | `Inconclusive`
- **Confidence:** Low / Medium / High
- **Play Description:** Objective visual summary
- **Reasoning:** Rule-cited explanation grounded in official sport rules
- **Relevant Rule:** The specific rule or category applied

---

## 🏗️ Architecture

```
┌─────────────────────┐     FormData (video + sport)     ┌──────────────────────────┐
│   Next.js Frontend  │ ─────────────────────────────▶  │  Next.js API Route        │
│   (React / CSS)     │                                  │  /api/analyze             │
│                     │ ◀───────────────────────────── │  • Gemini Files API upload │
│  - Sport selector   │     JSON { verdict, reasoning }  │  • Rulebook injection      │
│  - Video upload     │                                  │  • Gemini 1.5 Flash       │
│  - Results display  │                                  │  • Structured JSON output │
└─────────────────────┘                                  └──────────────────────────┘
```

**Key Design Decisions:**
- **Rulebook Injection:** Sport-specific official rules are prepended to the prompt so Gemini reasons against real rules, not hallucinated ones.
- **Temperature 0.15:** Forces the model to be a strict "referee" rather than a creative storyteller.
- **Files API:** Video is uploaded to Gemini's Files API (not base64 inline) to handle real-world clip sizes.
- **Inconclusive verdict:** The model is explicitly instructed to use `Inconclusive` when video quality or camera angle is insufficient — accuracy over false confidence.

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- A **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/app/apikey)

### 1. Clone & Install
```bash
git clone https://github.com/YOUR_USERNAME/refcheck-ai.git
cd refcheck-ai
npm install
```

### 2. Configure Environment
```bash
cp .env.local.example .env.local
```
Edit `.env.local`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

### 3. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000)

---

## ☁️ Deploy to Vercel

```bash
npm install -g vercel
vercel
```

Set `GEMINI_API_KEY` in your Vercel project environment variables.

> **Note:** Set the Vercel function timeout to 60s for video processing: add `"functions": { "app/api/analyze/route.ts": { "maxDuration": 60 } }` to `vercel.json`.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| AI Backend | Gemini 1.5 Flash (via `@google/generative-ai`) |
| Video Processing | Gemini Files API |
| Deployment | Vercel / Google Cloud Run |

---

## ⚙️ How the AI Works

1. **Video Upload:** The clip is uploaded to Gemini's Files API and polled until `ACTIVE`.
2. **Prompt Engineering:** A structured prompt injects the sport's official rulebook excerpts and the referee's original call (if provided).
3. **Multimodal Analysis:** Gemini 1.5 Flash processes video frames alongside the text prompt.
4. **JSON Output:** The model returns a strict JSON structure parsed and validated server-side.
5. **Cleanup:** The uploaded file is deleted from Gemini's Files API after analysis.

---

## 🧠 Supported Rules (Injected per Sport)

- **Basketball:** NBA Rule 12B (Blocking/Charging), Verticality, Flagrant Fouls, Travels
- **Soccer:** FIFA Law 12 (Fouls), Law 11 (Offside), Handball, DOGSO
- **American Football:** Pass Interference, Roughing the Passer, Catch/No-Catch, Targeting
- **Baseball:** Strike Zone, Tag vs Force, Infield Fly, Balk, Obstruction
- **Hockey:** Goalie Interference, Icing, High-Sticking, Offside
- **Tennis:** Ball In/Out, Let, Foot Fault, Hawkeye Line Calls

---

## ⚠️ Limitations

- AI analysis depends on video quality and camera angle
- Not a substitute for certified officiating
- Gemini may not catch very subtle rule nuances
- Max video size: 100MB

---

## 📄 License

MIT License — see [LICENSE](LICENSE)

---

*Built with ❤️ for GDG BorderHack 2026*
