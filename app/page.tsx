"use client";

import { useEffect, useRef, useState } from "react";

type Verdict = "Fair Call" | "Bad Call" | "Inconclusive";
interface AnalysisResult { 
  verdict: Verdict; 
  reasoning: string; 
  confidence_score: number;
  referee_stats: { historical_bias: string; accuracy_rating: string; };
  foul_frames: number[];
  detected_entities: string[];
  rule_alignment_score: number;
  visual_clarity_index: number;
  inference_time_seconds: number;
  frames?: string[]; 
}

const LOADING_STEPS = [
  "Extracting 30 frames...",
  "Consulting IFAB Law 12...",
  "Checking Referee Bias...",
  "Finalizing Verdict"
];

const LAW_12_SNIPPET = `PART 1: DIRECT FREE KICKS
A direct free kick is awarded if a player commits any of the following offences against an opponent in a manner considered by the referee to be careless, reckless or using excessive force:
• charges
• jumps at
• kicks or attempts to kick
• pushes
• strikes or attempts to strike (including head-butt)
• tackles or challenges
• trips or attempts to trip`;

const REFEREES = [
  "Unknown / Not Listed",
  "Alex Mercer",
  "Sarah Jenkins",
  "Ismail Elfath",
  "Allen Chapman",
  "Drew Fischer",
  "José Carlos Rivero"
];
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

function CircularGauge({ score, label, colorOverride }: { score: number, label: string, colorOverride?: string }) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (score / 100) * circumference;
  
  const color = colorOverride || (score >= 80 ? "#10b981" : score >= 50 ? "#3b82f6" : "#f59e0b");

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
      <div style={{ position:"relative", display:"flex", alignItems:"center", justifyContent:"center", width:72, height:72 }}>
        <svg width="72" height="72" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="36" cy="36" r={radius} stroke="rgba(255,255,255,0.05)" strokeWidth="6" fill="transparent" />
          <circle 
            cx="36" cy="36" r={radius} 
            stroke={color} 
            strokeWidth="6" 
            fill="transparent" 
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 1.5s cubic-bezier(0.4, 0, 0.2, 1), stroke 1s ease", filter:`drop-shadow(0 0 4px ${color}80)` }}
          />
        </svg>
        <div style={{ position:"absolute", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
          <span style={{ fontSize:16, fontWeight:900, color:"#fff" }}>{score}</span>
        </div>
      </div>
      <span style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.05em", color:"var(--text-muted)", fontWeight:700, textAlign:"center" }}>
        {label}
      </span>
    </div>
  );
}

export default function Home() {
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const fileRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Form state
  const [file, setFile]             = useState<File | null>(null);
  const [sport, setSport]           = useState("Soccer");
  const [originalCall, setOrigCall] = useState("");
  const [refereeName, setRefName]   = useState("Unknown / Not Listed");
  const [dragging, setDragging]     = useState(false);

  // Request state
  const [loading, setLoading]         = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError]             = useState<string | null>(null);
  const [result, setResult]           = useState<AnalysisResult | null>(null);

  useEffect(() => {
    if (!loading) {
      setLoadingStep(0);
      return;
    }
    const timer = setInterval(() => {
      setLoadingStep(s => (s < LOADING_STEPS.length - 1 ? s + 1 : s));
    }, 1500);
    return () => clearInterval(timer);
  }, [loading]);

  // Chat state
  const [chatInput, setChatInput]   = useState("");
  const [chatLoading, setChatLoad]  = useState(false);
  const [chatHistory, setChatHist]  = useState<ChatMessage[]>([]);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function renderWithCitations(text: string) {
    const parts = text.split(/(Law 12\b[^,.]*|Part \d+)/i);
    return parts.map((part, i) => {
      if (/Law 12\b/i.test(part) || /Part \d+/i.test(part)) {
        return (
          <span 
            key={i} 
            onClick={() => {
              const panel = document.getElementById("reference-panel") as HTMLDetailsElement;
              if (panel) {
                panel.open = true;
                panel.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }}
            style={{ color: "#4f8ef7", fontWeight: 600, borderBottom: "1px dashed #4f8ef7", cursor:"pointer", transition:"color 0.2s" }} 
            onMouseOver={e => e.currentTarget.style.color = "#fff"}
            onMouseOut={e => e.currentTarget.style.color = "#4f8ef7"}
            title="Click to view rulebook text"
          >
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  }

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

    setChatHist(h => [...h, { role: "user", text: q }]);
    setChatInput("");
    setChatLoad(true);

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
      const friendlyMsg = msg.includes("fetch") ? "Cannot reach backend — is uvicorn running?" : msg;
      setChatHist(h => [...h, { role: "var", text: `⚠️ ${friendlyMsg}` }]);
    } finally {
      setChatLoad(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
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
          <span className="tag-chip" style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)", color:"#a0a0b0" }}>Advanced Diagnostics</span>
        </div>
      </header>

      <main style={{ position:"relative", zIndex:1, maxWidth:800, margin:"0 auto", padding:"48px 24px 80px" }}>

        {/* ── Hero ── */}
        {!result && !loading && (
          <div className="animate-fade-in-1" style={{ textAlign:"center", marginBottom:40 }}>
            <h1 style={{ fontSize:"clamp(28px,5vw,42px)", fontWeight:800, letterSpacing:"-0.03em", lineHeight:1.1, marginBottom:12 }}>
              VAR <span className="gradient-text">Analysis Protocol</span>
            </h1>
            <p style={{ color:"var(--text-secondary)", fontSize:15, lineHeight:1.6, maxWidth:480, margin:"0 auto" }}>
              Upload video evidence. Our deterministic AI applies official rulebooks and historical referee bias to deliver clinical, auditable verdicts.
            </p>
          </div>
        )}

        {/* ── Form Card ── */}
        <div className="glass animate-fade-in-2" style={{ borderRadius:20, padding:32, marginBottom:24, maxWidth:680, margin:"0 auto 24px" }}>
          <form onSubmit={handleAnalyze} style={{ display:"flex", flexDirection:"column", gap:20 }}>

            {/* Sport & Referee grid */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
              <div>
                <label style={{ display:"block", fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>
                  Target Sport
                </label>
                <select
                  value={sport}
                  onChange={e => setSport(e.target.value)}
                  style={{
                    width:"100%", padding:"11px 14px", borderRadius:10,
                    background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)",
                    color:"var(--text-primary)", fontSize:14, outline:"none",
                    cursor:"pointer", appearance:"none",
                  }}
                >
                  {SPORTS.map(s => <option key={s} value={s} style={{ background:"#0d0d1f" }}>{s}</option>)}
                </select>
              </div>

              <div>
                <label style={{ display:"block", fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>
                  Match Official <span style={{ fontWeight:400, textTransform:"none", letterSpacing:"normal" }}>(Opt)</span>
                </label>
                <select
                  value={refereeName}
                  onChange={e => setRefName(e.target.value)}
                  style={{
                    width:"100%", padding:"11px 14px", borderRadius:10,
                    background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)",
                    color:"var(--text-primary)", fontSize:14, outline:"none",
                    cursor:"pointer", appearance:"none",
                  }}
                >
                  {REFEREES.map(r => <option key={r} value={r} style={{ background:"#0d0d1f" }}>{r}</option>)}
                </select>
              </div>
            </div>

            {/* Drop zone */}
            <div>
              <label style={{ display:"block", fontSize:12, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--text-muted)", marginBottom:8 }}>
                Video Evidence
              </label>
              <div
                className={`upload-zone${dragging ? " dragging" : ""}`}
                style={{ borderRadius:14, padding:"28px 24px", textAlign:"center", cursor:"pointer" }}
                onClick={() => fileRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onChange={onFileChange} style={{ display:"none" }} />
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
            <button type="submit" disabled={!file || loading} className="btn-analyze"
              style={{ padding:"14px 0", borderRadius:12, border:"none", fontSize:15, fontWeight:600, display:"flex", alignItems:"center", justifyContent:"center", gap:8, cursor: file && !loading ? "pointer" : "not-allowed" }}>
              {loading
                ? (<><div className="loading-spinner" style={{ width:18, height:18, borderWidth:2 }} /><span className="shimmer-text">Processing Analysis Protocol…</span></>)
                : "⚡ Run VAR Analysis"}
            </button>
          </form>

          {/* Error */}
          {error && (
            <div className="animate-fade-in" style={{ marginTop:20, padding:"14px 16px", borderRadius:12, background:"var(--red-dim)", border:"1px solid rgba(244,63,94,0.3)", color:"var(--red)", fontSize:13, lineHeight:1.5 }}>
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        {/* ── Live Analysis Log (Loading State) ── */}
        {loading && (
          <div className="glass animate-fade-in" style={{ borderRadius:16, padding:"32px", marginBottom:24, maxWidth:680, margin:"0 auto 24px" }}>
            <p style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:20 }}>System Progress</p>
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              {LOADING_STEPS.map((step, idx) => (
                <div key={idx} style={{ display:"flex", alignItems:"center", gap:12, opacity: idx <= loadingStep ? 1 : 0.3, transition:"opacity 0.3s" }}>
                  <div style={{ width:20, height:20, borderRadius:"50%", border: idx < loadingStep ? "none" : "2px solid var(--border)", background: idx < loadingStep ? "#10b981" : "transparent", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {idx < loadingStep && <span style={{ color:"#fff", fontSize:12, fontWeight:700 }}>✓</span>}
                    {idx === loadingStep && <div className="loading-spinner" style={{ width:12, height:12, borderWidth:2, borderColor:"var(--accent) transparent transparent" }} />}
                  </div>
                  <span style={{ fontSize:14, fontWeight: idx === loadingStep ? 600 : 400, color: idx <= loadingStep ? "var(--text-primary)" : "var(--text-muted)" }}>
                    {step}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Result card ── */}
        {result && !loading && (
          <div className="animate-slide-up" style={{ display:"flex", flexDirection:"column", gap:24 }}>
            
            {/* Header: Verdict */}
            <div className="glass" style={{ borderRadius:20, padding:"24px 32px", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ textAlign:"center" }}>
                <p style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:10 }}>Final VAR Decision</p>
                <div className={verdictStyle(result.verdict)}
                  style={{ display:"inline-flex", alignItems:"center", gap:10, padding:"10px 32px", borderRadius:99, fontSize:24, fontWeight:800, letterSpacing:"-0.02em", boxShadow:"0 4px 20px rgba(0,0,0,0.2)" }}>
                  <span style={{ width:32, height:32, borderRadius:"50%", background:"rgba(255,255,255,0.12)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:900 }}>
                    {verdictIcon(result.verdict)}
                  </span>
                  {result.verdict.toUpperCase()}
                </div>
              </div>
            </div>

            {/* 30-Frame Film Strip */}
            {result.frames && result.frames.length > 0 && (
              <div className="glass" style={{ borderRadius:20, overflow:"hidden" }}>
                <div style={{ padding:"16px 24px", borderBottom:"1px solid var(--border)", background:"rgba(255,255,255,0.02)" }}>
                  <h3 style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)" }}>Motion Evidence Timeline</h3>
                </div>
                <div style={{ padding:"16px", display:"flex", gap:12, overflowX:"auto" }} className="hide-scrollbar">
                  {result.frames.map((frame, idx) => {
                    const frameNum = idx + 1;
                    const isFoul = result.foul_frames.includes(frameNum);
                    return (
                      <div key={idx} style={{ display:"flex", flexDirection:"column", gap:8, flexShrink:0 }}>
                        <div style={{ 
                          height:96, width:"auto", minWidth: 120, borderRadius:8, overflow:"hidden", 
                          border: isFoul ? "2px solid #ef4444" : "1px solid var(--border)", 
                          background:"#000", position:"relative",
                          boxShadow: isFoul ? "0 0 12px rgba(239,68,68,0.5)" : "none"
                        }}>
                          <img
                            src={`data:image/jpeg;base64,${frame}`}
                            alt={`Frame ${frameNum}`}
                            style={{ height:"100%", width:"100%", objectFit:"cover", opacity: isFoul ? 1 : 0.6 }}
                          />
                          {isFoul && (
                            <div style={{ position:"absolute", top:4, right:4, background:"#ef4444", color:"#fff", fontSize:8, fontWeight:800, padding:"2px 6px", borderRadius:4, textTransform:"uppercase" }}>
                              Foul Zone
                            </div>
                          )}
                        </div>
                        <span style={{ fontSize:10, textTransform:"uppercase", fontWeight:700, color: isFoul ? "#ef4444" : "var(--text-muted)", textAlign:"center" }}>
                          Frame {frameNum}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Reasoning & Reference */}
            <div className="glass" style={{ borderRadius:20, overflow:"hidden" }}>
              <div style={{ display:"flex", flexDirection:"column" }}>
                <div style={{ padding:"24px 32px", flex:1 }}>
                  <p style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:10 }}>Diagnostic Reasoning</p>
                  <p style={{ fontSize:15, lineHeight:1.8, color:"var(--text-secondary)" }}>
                    {renderWithCitations(result.reasoning)}
                  </p>
                </div>

                {/* Detection Panel */}
                <div style={{ width: 220, borderLeft:"1px solid var(--border)", background:"rgba(255,255,255,0.02)", padding:"24px" }}>
                  <p style={{ fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:12 }}>Detection Panel</p>
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {result.detected_entities.length > 0 ? result.detected_entities.map((ent, i) => (
                      <div key={i} style={{ fontSize:11, fontFamily:"monospace", color:"#4f8ef7", background:"rgba(79,142,247,0.1)", padding:"6px 10px", borderRadius:6, border:"1px solid rgba(79,142,247,0.2)" }}>
                        {ent}
                      </div>
                    )) : (
                      <div style={{ fontSize:11, fontFamily:"monospace", color:"var(--text-muted)" }}>No entities mapped.</div>
                    )}
                  </div>
                </div>
              </div>
              
              <details id="reference-panel" style={{ cursor:"pointer", borderTop:"1px solid var(--border)", background:"rgba(255,255,255,0.01)" }}>
                <summary style={{ padding:"16px 32px", fontSize:13, fontWeight:600, color:"var(--text-primary)", listStyle:"none", display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ color:"#4f8ef7" }}>📖</span> IFAB Law 12 Reference Panel
                </summary>
                <div style={{ margin:"0 32px 24px", padding:"16px", background:"#05050f", borderRadius:12, border:"1px solid var(--border)", fontSize:12, fontFamily:"monospace", color:"var(--text-muted)", whiteSpace:"pre-wrap", lineHeight:1.6 }}>
                  {LAW_12_SNIPPET}
                </div>
              </details>

              {/* Technical Metadata Footer */}
              <div style={{ padding:"10px 32px", borderTop:"1px dashed var(--border)", background:"#05050a" }}>
                <p style={{ fontSize:10, fontFamily:"monospace", color:"var(--text-muted)", textTransform:"uppercase", letterSpacing:"0.05em" }}>
                  System Latency // Inference Time: <span style={{ color:"#10b981", fontWeight:700 }}>{result.inference_time_seconds}s</span>
                </p>
              </div>
            </div>

            {/* Referee Grid */}
            {result.referee_stats && (
              <div className="glass" style={{ borderRadius:20, padding:"24px 32px" }}>
                <p style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"var(--text-muted)", marginBottom:20 }}>🕵️ Physics & Accountability Data</p>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))", gap:16, alignItems:"start" }}>
                  
                  {/* Physics Gauges */}
                  <div style={{ display:"flex", gap:20, justifyContent:"center", background:"rgba(255,255,255,0.02)", padding:"20px", borderRadius:16, border:"1px solid var(--border)" }}>
                    <CircularGauge score={result.confidence_score} label="Confidence" />
                    <CircularGauge score={result.rule_alignment_score} label="Rule Align" colorOverride="#4f8ef7" />
                    <CircularGauge score={result.visual_clarity_index} label="Clarity Idx" colorOverride="#a855f7" />
                  </div>

                  <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid var(--border)", borderRadius:14, padding:"20px", height:"100%" }}>
                    <p style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--accent)", marginBottom:8, fontWeight:700 }}>Historical Bias Context</p>
                    <p style={{ fontSize:13, lineHeight:1.6, color:"var(--text-secondary)" }}>{result.referee_stats.historical_bias}</p>
                    
                    <div style={{ marginTop:16, paddingTop:16, borderTop:"1px dashed var(--border)" }}>
                      <p style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--accent)", marginBottom:6, fontWeight:700 }}>Accuracy Profile</p>
                      <p style={{ fontSize:18, fontWeight:800, color:"#fff" }}>{result.referee_stats.accuracy_rating}</p>
                    </div>
                  </div>
                  
                </div>
              </div>
            )}

            {/* Ask the VAR */}
            <div className="glass" style={{ borderRadius:20, overflow:"hidden" }}>
              <div style={{ padding:"20px 28px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:18 }}>💬</span>
                <div>
                  <p style={{ fontWeight:700, fontSize:14, letterSpacing:"-0.01em" }}>Ask the VAR</p>
                  <p style={{ fontSize:12, color:"var(--text-muted)" }}>Submit follow-up inquiries about the ruling logic.</p>
                </div>
              </div>

              {/* Chat history */}
              <div style={{ padding:"16px 28px", display:"flex", flexDirection:"column", gap:12, minHeight: chatHistory.length ? "auto" : 72, maxHeight:320, overflowY:"auto" }}>
                {chatHistory.length === 0 && (
                  <p style={{ fontSize:13, color:"var(--text-muted)", textAlign:"center", padding:"16px 0" }}>
                    No inquiries submitted yet.
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
                    <div style={{ padding:"10px 14px", borderRadius:"14px 14px 14px 4px", background:"rgba(255,255,255,0.05)", border:"1px solid var(--border)", fontSize:13, color:"var(--text-muted)", display:"flex", alignItems:"center", gap:8 }}>
                      <div className="loading-spinner" style={{ width:12, height:12, borderWidth:2 }} /> Processing query…
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Chat input */}
              <form onSubmit={handleChat} style={{ padding:"12px 20px", borderTop:"1px solid var(--border)", display:"flex", gap:10, background:"rgba(255,255,255,0.02)" }}>
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="e.g., Did you consider the defender's trailing leg?"
                  disabled={chatLoading}
                  style={{
                    flex:1, padding:"10px 14px", borderRadius:10,
                    background:"rgba(255,255,255,0.04)", border:"1px solid var(--border)",
                    color:"var(--text-primary)", fontSize:13, outline:"none",
                  }}
                  onFocus={e => (e.target.style.borderColor = "rgba(124,106,247,0.5)")}
                  onBlur={e  => (e.target.style.borderColor = "var(--border)")}
                />
                <button type="submit" disabled={!chatInput.trim() || chatLoading}
                  style={{ padding:"10px 18px", borderRadius:10, border:"none", background:"linear-gradient(135deg,#7c6af7,#4f8ef7)", color:"#fff", fontWeight:600, fontSize:13, cursor: chatInput.trim() && !chatLoading ? "pointer" : "not-allowed", opacity: chatInput.trim() && !chatLoading ? 1 : 0.5 }}>
                  Send
                </button>
              </form>
            </div>

            {/* Reset */}
            <div style={{ textAlign:"center" }}>
              <button 
                onClick={() => { setResult(null); setFile(null); setError(null); setChatHist([]); setOrigCall(""); }}
                style={{ padding:"10px 24px", borderRadius:10, border:"1px solid var(--border-bright)", background:"transparent", color:"var(--text-secondary)", fontSize:13, fontWeight:500, cursor:"pointer" }}>
                Start New Analysis
              </button>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
