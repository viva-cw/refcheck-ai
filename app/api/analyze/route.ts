import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 120;

const FASTAPI_URL = process.env.FASTAPI_URL || "http://localhost:8000";

// Try to extract a rule name from the reasoning text
function inferRelevantRule(reasoning: string, sport: string): string {
  const patterns = [
    /(?:NBA|NFL|FIFA|NHL|MLB|ITF)\s+Rule\s+[\w\d]+[^.,;\n]*/i,
    /Rule\s+\d+[A-Z]?[^.,;\n]*/i,
    /Law\s+\d+[^.,;\n]*/i,
    /Section\s+[\w\d]+[^.,;\n]*/i,
  ];
  for (const p of patterns) {
    const m = reasoning.match(p);
    if (m) return m[0].trim().slice(0, 100);
  }
  const defaults: Record<string, string> = {
    basketball: "NBA Rule 12B — Personal Fouls",
    soccer: "FIFA Law 12 — Fouls and Misconduct",
    americanfootball: "NFL Official Rules — Contact Rules",
    baseball: "MLB Official Rules — Play Rulings",
    hockey: "NHL Official Rules — On-Ice Conduct",
    tennis: "ITF Rules of Tennis",
  };
  return defaults[sport.toLowerCase()] || "Official Sport Rules";
}

export async function POST(req: NextRequest) {
  // Forward the incoming FormData straight to FastAPI
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const sport = (formData.get("sport") as string) || "basketball";

  let res: Response;
  try {
    res = await fetch(`${FASTAPI_URL}/analyze`, {
      method: "POST",
      body: formData,
      // Note: do NOT set Content-Type — the browser sets the multipart boundary
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isClosed = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("connect");
    return NextResponse.json(
      {
        error: isClosed
          ? `FastAPI backend is not reachable at ${FASTAPI_URL}. Run: cd backend && uvicorn main:app --port 8000`
          : msg,
      },
      { status: 503 }
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "FastAPI returned an error." }));
    return NextResponse.json(
      { error: body.detail || "Analysis failed." },
      { status: res.status }
    );
  }

  const data = await res.json();
  const a = data.analysis;

  // Normalize FastAPI schema → frontend schema
  // FastAPI:  { verdict, confidence, play_description, rule_based_reasoning }
  // Frontend: { verdict, confidence, play_description, reasoning, relevant_rule }
  const normalized = {
    verdict: a.verdict,
    confidence: a.confidence,
    play_description: a.play_description,
    reasoning: a.rule_based_reasoning ?? a.reasoning ?? "",
    relevant_rule:
      a.relevant_rule ?? inferRelevantRule(a.rule_based_reasoning ?? "", sport),
  };

  return NextResponse.json({ success: true, analysis: normalized });
}
