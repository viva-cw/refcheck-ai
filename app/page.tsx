"use client";

import { useRef, useState } from "react";

type Verdict = "Fair Call" | "Bad Call" | "Inconclusive";
interface AnalysisResult { verdict: Verdict; reasoning: string; referee_analysis: string; }

const REFEREES = ["Unknown / Not Listed", "Alex Mercer", "Sarah Jenkins"];
interface ChatMessage { role: "user" | "var"; text: string; }

const SPORTS = ["Soccer", "Basketball", "Football", "Baseball", "Hockey", "Tennis"];

function verdictStyle(v: Verdict) {
  if (v === "Fair Call")    return "verdict-fair";
  if (v === "Bad Call")     return "verdict-bad";
  return "verdict-inconclusive";
}
function verdictIcon(v: Verdict) {
  if (v === "Fair Call")    return "✓";
  if (v === "Bad Call")     return "✗";
  return "~";
}

export default function Home() {
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const fileRef = useRef<HTMLInputElement>(null);

  // Form state
  const [file, setFile]             = useState<File | null>(null);
  const [sport, setSport]           = useState("Soccer");
  const [originalCall, setOrigCall] = useState("");
  const [refereeName, setRefName]   = useState("Unknown / Not Listed");
  const [dragging, setDragging]     = useState(false);

  // Request state
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [result, setResult]         = useState<AnalysisResult | null>(null);

  // Chat state
  const [chatInput, setChatInput]   = useState("");
  const [chatLoading, setChatLoad]  = useState(false);
  const [chatHistory, setChatHist]  = useState<ChatMessage[]>([]);

  // ── File handlers ────────────────────────────────────────────────────────────
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f); setResult(null); setError(null); setChatHist([]);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f?.type.startsWith("video/")) { setFile(f); setResult(null); setError(null); setChatHist([]); }
  }

  // ── Analyze ──────────────────────────────────────────────────────────────────
  async function handleAnalyze(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true); setError(null); setResult(null); setChatHist([]);
    const form = new FormData();
    form.append("video", file);
    form.append("sport", sport.toLowerCase());
    if (originalCall.trim()) form.append("original_call", originalCall.trim());
    if (refereeName !== "Unknown / Not Listed") form.append("referee_name", refereeName);
    form.append("game_context", sport + (refereeName !== "Unknown / Not Listed" ? ` officiated by ${refereeName}` : ""));
    try {
      const res = await fetch(`${API_URL}/analyze`, { method: "POST", body: form });
      if (!res.ok) {
        const b = await res.json().catch(() => ({ detail: "Unknown error" }));
        throw new Error(b.detail ?? `Server error ${res.status}`);
      }
      setResult(await res.json());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes("fetch") ? `Cannot reach backend at ${API_URL}. Is uvicorn running?` : msg);
    } finally { setLoading(false); }
  }

  // ── Chat ─────────────────────────────────────────────────────────────────────
  async function handleChat(e: React.FormEvent) {
    e.preventDefault();
    const q = chatInput.trim();
    if (!q || !result) return;

    // Append user message immediately (optimistic)
    setChatHist(h => [...h, { role: "user", text: q }]);
    setChatInput("");
    setChatLoad(true);

    // Build a human-readable context string for the backend
    const context = `Verdict: ${result.verdict}. Reasoning: ${result.reasoning}`;

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, context }),
      });

      if (!res.ok) {
        const b = await res.json().catch(() => ({ detail: "Unknown error." }));
        throw new Error(b.detail ?? `Server error ${res.status}`);
      }

      const data = await res.json();
      setChatHist(h => [...h, { role: "var", text: data.answer ?? "No response." }]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendlyMsg = msg.includes("fetch")
        ? "Cannot reach backend — is uvicorn running on port 8000?"
        : msg;
      setChatHist(h => [...h, { role: "var", text: `⚠️ ${friendlyMsg}` }]);
    } finally {
      setChatLoad(false);
      // Scroll chat history to bottom
      setTimeout(() => {
        const el = document.getElementById("chat-history");
        if (el) el.scrollTop = el.scrollHeight;
      }, 50);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="orb orb-1" />
      <div className="orb orb-2" />

      {/* ── Nav ── */}
      <header style={{ position:"relative", zIndex:10, borderBottom:"1px solid var(--border)", background:"rgba(6,6,15,0.8)", backdropFilter:"blur(12px)" }}>
        <div style={{ maxWidth:900, margin:"0 auto", padding:"0 24px", height:56, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ width:28, height:28, borderRadius:8, background:"linear-gradient(135deg,#7c6af7,#4f8ef7)", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, color:"#fff", fontSize:14 }}>R</span>
            <span style={{ fontWeight:700, fontSize:15, letterSpacing:"-0.02em" }}>RefCheck <span className="gradient-text">AI</span></span>
          </div>
          <span className="tag-chip">GDG BorderHack 2026 · Gemini 2.5 Flash</span>
        </div>
      </header>

      <main style={{ position:"relative", zIndex:1, maxWidth:680, margin:"0 auto", padding:"48px 24px 80px" }}>

        {/* ── Hero ── */}
        <div className="animate-fade-in-1" style={{ textAlign:"center", marginBottom:40 }}>
          <div className="tag-chip" style={{ display:"inline-block", marginBottom:14 }}>⚽ AI-Powered Sports Officiating</div>
          <h1 style={{ fontSize:"clamp(28px,5vw,42px)", fontWeight:800, letterSpacing:"-0.03em", lineHeight:1.1, marginBottom:12 }}>
            Was it a <span className="gradient-text">Fair Call?</span>
          </h1>
          <p style={{ color:"var(--text-secondary)", fontSize:15, lineHeight:1.6, maxWidth:480, margin:"0 auto" }}>
            Upload a short clip, pick your sport, and our AI VAR will rule on the play against the official rulebook — instantly.
          </p>
        </div>

        {/* ── Form Card ── */}
        <div className="glass animate-fade-in-2" style={{ borderRadius:20, padding:32, marginBottom:24 }}>
          <form onSubmit={handleAnalyze} style={{ display:"flex", flexDirection:"column", gap:20 }}>

            {/* Sport selector */}
            <div>
              <label style={{ display:"block", fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>
                Sport
              </label>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                {SPORTS.map(s => (
                  <button
                    key={s} type="button"
                    className={`sport-pill${sport === s ? " active" : ""}`}
                    onClick={() => setSport(s)}
                    style={{ padding:"7px 16px", borderRadius:99, fontSize:13, fontWeight:500, border:"1px solid var(--border)", background:"none", cursor:"pointer" }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Referee selector */}
            <div>
              <label htmlFor="referee-select" style={{ display:"block", fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>
                Select Referee <span style={{ fontWeight:400, textTransform:"none", letterSpacing:"normal", color:"var(--text-muted)" }}>(Optional)</span>
              </label>
              <select
                id="referee-select"
                value={refereeName}
                onChange={e => setRefName(e.target.value)}
                style={{
                  width:"100%", padding:"11px 14px", borderRadius:10,
                  background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)",
                  color:"var(--text-primary)", fontSize:14, outline:"none",
                  cursor:"pointer", appearance:"none",
                  backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237878a0' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                  backgroundRepeat:"no-repeat", backgroundPosition:"right 14px center",
                }}
                onFocus={e => (e.target.style.borderColor = "rgba(124,106,247,0.5)")}
                onBlur={e  => (e.target.style.borderColor = "var(--border)")}
              >
                {REFEREES.map(r => <option key={r} value={r} style={{ background:"#0d0d1f" }}>{r}</option>)}
              </select>
            </div>

            {/* Original call */}
            <div>
              <label htmlFor="original-call-input" style={{ display:"block", fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>
                Original Referee Call <span style={{ fontWeight:400, textTransform:"none", letterSpacing:"normal", color:"var(--text-muted)" }}>(optional)</span>
              </label>
              <input
                id="original-call-input"
                type="text"
                value={originalCall}
                onChange={e => setOrigCall(e.target.value)}
                placeholder='e.g. "Yellow card for simulation"'
                style={{
                  width:"100%", padding:"11px 14px", borderRadius:10,
                  background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)",
                  color:"var(--text-primary)", fontSize:14, outline:"none",
                  transition:"border-color 0.2s",
                }}
                onFocus={e => (e.target.style.borderColor = "rgba(124,106,247,0.5)")}
                onBlur={e  => (e.target.style.borderColor = "var(--border)")}
              />
            </div>

            {/* Drop zone */}
            <div>
              <label style={{ display:"block", fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>
                Video Clip
              </label>
              <div
                id="upload-zone"
                className={`upload-zone${dragging ? " dragging" : ""}`}
                style={{ borderRadius:14, padding:"28px 24px", textAlign:"center", cursor:"pointer" }}
                onClick={() => fileRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input ref={fileRef} id="video-file-input" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onChange={onFileChange} style={{ display:"none" }} />
                {file ? (
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:32 }}>🎬</span>
                    <p style={{ fontWeight:600, fontSize:14 }}>{file.name}</p>
                    <p style={{ fontSize:12, color:"var(--text-muted)" }}>{(file.size/1024/1024).toFixed(1)} MB · click to change</p>
                  </div>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:36 }}>📹</span>
                    <p style={{ fontWeight:600, fontSize:14 }}>Drop your clip here</p>
                    <p style={{ fontSize:12, color:"var(--text-muted)" }}>or <span style={{ color:"var(--accent)" }}>browse</span> · MP4, MOV, WebM</p>
                  </div>
                )}
              </div>
            </div>

            {/* Submit */}
            <button id="analyze-btn" type="submit" disabled={!file || loading} className="btn-analyze"
              style={{ padding:"14px 0", borderRadius:12, border:"none", fontSize:15, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, cursor: file && !loading ? "pointer" : "not-allowed" }}>
              {loading
                ? (<><div className="loading-spinner" style={{ width:18, height:18, borderWidth:2 }} /><span className="shimmer-text">VAR is reviewing the play…</span></>)
                : "⚡ Analyze Play"}
            </button>
          </form>

          {/* Error */}
          {error && (
            <div id="error-message" className="animate-fade-in" style={{ marginTop:20, padding:"14px 16px", borderRadius:12, background:"var(--red-dim)", border:"1px solid rgba(244,63,94,0.3)", color:"var(--red)", fontSize:13, lineHeight:1.5 }}>
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        {/* ── Loading card ── */}
        {loading && (
          <div className="glass animate-fade-in" style={{ borderRadius:16, padding:"28px 32px", textAlign:"center", position:"relative", overflow:"hidden", marginBottom:24 }}>
            <div className="scan-line" />
            <p style={{ fontWeight:600, fontSize:14, marginBottom:6 }}>Extracting frames &amp; sending to Gemini 2.5 Flash…</p>
            <p style={{ fontSize:12, color:"var(--text-muted)" }}>Analyzing {sport} play under official rulebook · ~10–30s</p>
          </div>
        )}

        {/* ── Result card ── */}
        {result && !loading && (
          <div id="result-card" className="glass animate-slide-up" style={{ borderRadius:20, overflow:"hidden", marginBottom:24 }}>

            {/* Verdict badge */}
            <div style={{ padding:"32px 32px 24px", textAlign:"center", borderBottom:"1px solid var(--border)" }}>
              <div id="verdict-badge" className={verdictStyle(result.verdict)}
                style={{ display:"inline-flex", alignItems:"center", gap:10, padding:"10px 28px", borderRadius:99, fontSize:22, fontWeight:800, letterSpacing:"-0.02em", marginBottom:8 }}>
                <span style={{ width:32, height:32, borderRadius:"50%", background:"rgba(255,255,255,0.12)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:900 }}>
                  {verdictIcon(result.verdict)}
                </span>
                {result.verdict.toUpperCase()}
              </div>
              <p style={{ fontSize:11, color:"var(--text-muted)", letterSpacing:"0.08em", textTransform:"uppercase" }}>VAR Final Decision · {sport}</p>
            </div>

            {/* Reasoning + Referee Accountability */}
            <div style={{ padding:"24px 32px", display:"flex", flexDirection:"column", gap:20 }}>

              <div>
                <p style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:10 }}>Reasoning</p>
                <div className="result-section">
                  <p id="reasoning-text" style={{ fontSize:14, lineHeight:1.8, color:"var(--text-secondary)" }}>{result.reasoning}</p>
                </div>
              </div>

              {result.referee_analysis && (
                <div>
                  <p style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:10 }}>🕵️ Referee Accountability &amp; Stats</p>
                  <div style={{
                    background:"var(--accent-dim)",
                    border:"1px solid rgba(124,106,247,0.25)",
                    borderRadius:12,
                    padding:"16px 18px",
                    display:"flex",
                    gap:12,
                    alignItems:"flex-start",
                  }}>
                    <span style={{ fontSize:22, flexShrink:0, marginTop:2 }}>📋</span>
                    <p id="referee-analysis-text" style={{ fontSize:14, lineHeight:1.75, color:"var(--text-secondary)" }}>
                      {result.referee_analysis}
                    </p>
                  </div>
                </div>
              )}

            </div>
          </div>
        )}

        {/* ── Chat card ── */}
        {result && !loading && (
          <div className="glass animate-fade-in-3" style={{ borderRadius:20, overflow:"hidden", marginBottom:24 }}>
            <div style={{ padding:"20px 28px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:18 }}>💬</span>
              <div>
                <p style={{ fontWeight:700, fontSize:14, letterSpacing:"-0.01em" }}>Ask the VAR</p>
                <p style={{ fontSize:12, color:"var(--text-muted)" }}>Follow-up questions about this ruling</p>
              </div>
            </div>

            {/* Chat history */}
            <div id="chat-history" style={{ padding:"16px 28px", display:"flex", flexDirection:"column", gap:12, minHeight: chatHistory.length ? "auto" : 72, maxHeight:320, overflowY:"auto" }}>
              {chatHistory.length === 0 && (
                <p style={{ fontSize:13, color:"var(--text-muted)", textAlign:"center", padding:"16px 0" }}>
                  Ask anything — "Did you consider the defender's arm position?"
                </p>
              )}
              {chatHistory.map((msg, i) => (
                <div key={i} style={{ display:"flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{
                    maxWidth:"80%", padding:"10px 14px", borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                    background: msg.role === "user" ? "linear-gradient(135deg,#7c6af7,#4f8ef7)" : "rgba(255,255,255,0.05)",
                    border: msg.role === "var" ? "1px solid var(--border)" : "none",
                    fontSize:13, lineHeight:1.6, color: msg.role === "user" ? "#fff" : "var(--text-secondary)",
                  }}>
                    {msg.text}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div style={{ display:"flex", justifyContent:"flex-start" }}>
                  <div style={{ padding:"10px 14px", borderRadius:"14px 14px 14px 4px", background:"rgba(255,255,255,0.05)", border:"1px solid var(--border)", fontSize:13, color:"var(--text-muted)" }}>
                    VAR is thinking…
                  </div>
                </div>
              )}
            </div>

            {/* Chat input */}
            <form onSubmit={handleChat} style={{ padding:"12px 20px", borderTop:"1px solid var(--border)", display:"flex", gap:10 }}>
              <input
                id="chat-input"
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Ask a follow-up question…"
                disabled={chatLoading}
                style={{
                  flex:1, padding:"10px 14px", borderRadius:10,
                  background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)",
                  color:"var(--text-primary)", fontSize:13, outline:"none",
                }}
                onFocus={e => (e.target.style.borderColor = "rgba(124,106,247,0.5)")}
                onBlur={e  => (e.target.style.borderColor = "var(--border)")}
              />
              <button id="chat-send-btn" type="submit" disabled={!chatInput.trim() || chatLoading}
                style={{ padding:"10px 18px", borderRadius:10, border:"none", background:"linear-gradient(135deg,#7c6af7,#4f8ef7)", color:"#fff", fontWeight:600, fontSize:13, cursor: chatInput.trim() && !chatLoading ? "pointer" : "not-allowed", opacity: chatInput.trim() && !chatLoading ? 1 : 0.5 }}>
                Send
              </button>
            </form>
          </div>
        )}

        {/* ── Reset ── */}
        {result && !loading && (
          <div style={{ textAlign:"center" }}>
            <button id="analyze-another-btn"
              onClick={() => { setResult(null); setFile(null); setError(null); setChatHist([]); setOrigCall(""); }}
              style={{ padding:"10px 24px", borderRadius:10, border:"1px solid var(--border-bright)", background:"transparent", color:"var(--text-secondary)", fontSize:13, fontWeight:500, cursor:"pointer" }}>
              Analyze another clip →
            </button>
          </div>
        )}

        {/* ── How it Works ── */}
        <div className="glass animate-fade-in-5" style={{ borderRadius:16, padding:"24px 28px", marginTop:48 }}>
          <p style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:14 }}>How it Works</p>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:16 }}>
            {[
              { icon:"🎞️", title:"Frame Extraction", desc:"OpenCV samples 6 evenly-spaced frames from your clip." },
              { icon:"🤖", title:"Gemini Multimodal", desc:"All frames are sent in one payload to Gemini 2.5 Flash for temporal reasoning." },
              { icon:"📋", title:"Official Rulebook", desc:"The verdict is grounded in the official rulebook for your selected sport." },
            ].map(({ icon, title, desc }) => (
              <div key={title} style={{ display:"flex", flexDirection:"column", gap:6 }}>
                <span style={{ fontSize:24 }}>{icon}</span>
                <p style={{ fontWeight:600, fontSize:13, color:"var(--text-primary)" }}>{title}</p>
                <p style={{ fontSize:12, color:"var(--text-muted)", lineHeight:1.6 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
