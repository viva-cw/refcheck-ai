/* eslint-disable */
"use client";

import { useEffect, useState } from "react";
import type { Official, GameInfo } from "../api/officials/route";

const STORAGE_KEY = "refcheck-ref-stats";

export interface RefReview {
  id: string;
  verdict: string;
  confidence: string;
  sport: string;
  gameName: string;
  analyzedAt: string;
}

export interface RefRecord {
  name: string;
  position: string;
  reviews: RefReview[];
}

type RefStats = Record<string, RefRecord>;

function loadStats(): RefStats {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function saveStats(stats: RefStats) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

export function recordVerdictForOfficials(
  officials: Official[],
  verdict: string,
  confidence: string,
  sport: string,
  gameInfo: GameInfo | null
) {
  const stats = loadStats();
  const review: RefReview = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    verdict,
    confidence,
    sport,
    gameName: gameInfo?.name || "Unknown Game",
    analyzedAt: new Date().toISOString(),
  };
  for (const off of officials) {
    const key = off.displayName.toLowerCase().replace(/\s+/g, "-");
    if (!stats[key]) {
      stats[key] = { name: off.displayName, position: off.position, reviews: [] };
    }
    stats[key].reviews.push(review);
  }
  saveStats(stats);
  return stats;
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(" ");
  const ini = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
  return (
    <div style={{
      width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
      background: "linear-gradient(135deg, #7c6af7, #4f8ef7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 13, fontWeight: 700, color: "white", textTransform: "uppercase",
    }}>{ini.toUpperCase()}</div>
  );
}

function verdictDot(v: string) {
  const color = v === "Fair Call" ? "var(--green)" : v === "Bad Call" ? "var(--red)" : "var(--yellow)";
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />;
}

// ─── Officiating Crew Card (shown in results) ─────────────────────────────────
interface CrewProps {
  officials: Official[];
  gameInfo: GameInfo | null;
  verdict: string;
  confidence: string;
  sport: string;
}

export function OfficiatingCrew({ officials, gameInfo, verdict, confidence, sport }: CrewProps) {
  const [stats, setStats] = useState<RefStats>({});

  useEffect(() => {
    const updated = recordVerdictForOfficials(officials, verdict, confidence, sport, gameInfo);
    setStats(updated);
  }, [officials, verdict, confidence, sport, gameInfo]);

  if (officials.length === 0 && !gameInfo) return null;

  return (
    <div className="result-section animate-fade-in-4">
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 14 }}>
        👮 Officiating Crew
      </div>

      {gameInfo && (
        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", fontSize: 13 }}>
          <span style={{ color: "var(--text-secondary)" }}>Game: </span>
          <a href={gameInfo.espnUrl} target="_blank" rel="noreferrer" style={{ color: "#a78bfa", textDecoration: "none", fontWeight: 600 }}>
            {gameInfo.name} ↗
          </a>
          {gameInfo.venue && <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>· {gameInfo.venue}</span>}
        </div>
      )}

      {officials.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No official data available in public records for this game.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {officials.map((off, i) => {
            const key = off.displayName.toLowerCase().replace(/\s+/g, "-");
            const record = stats[key];
            const reviews = record?.reviews || [];
            const fair = reviews.filter((r) => r.verdict === "Fair Call").length;
            const bad = reviews.filter((r) => r.verdict === "Bad Call").length;
            const inc = reviews.filter((r) => r.verdict === "Inconclusive").length;

            return (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 14, padding: "12px 14px",
                borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)",
              }}>
                <Initials name={off.displayName} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{off.displayName}</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{off.position}</div>
                </div>
                {reviews.length > 0 && (
                  <div style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)", display: "inline-block" }} /> {fair}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--red)", display: "inline-block" }} /> {bad}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--yellow)", display: "inline-block" }} /> {inc}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Ref Stats Dashboard ──────────────────────────────────────────────────────
export function RefStatsDashboard() {
  const [stats, setStats] = useState<RefStats>({});
  const [open, setOpen] = useState(false);

  useEffect(() => { setStats(loadStats()); }, [open]);

  const refs = Object.values(stats).filter((r) => r.reviews.length > 0);
  if (refs.length === 0) return null;

  return (
    <div style={{ marginTop: 32 }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", padding: "12px 16px", borderRadius: 12, cursor: "pointer",
        background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)",
        color: "var(--text-secondary)", fontFamily: "inherit", fontSize: 14, fontWeight: 600,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span>📊 Referee Performance History ({refs.length} tracked)</span>
        <span style={{ transition: "transform 0.2s", display: "inline-block", transform: open ? "rotate(180deg)" : "none" }}>▾</span>
      </button>

      {open && (
        <div className="animate-fade-in glass" style={{ marginTop: 8, borderRadius: 16, padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--text-secondary)" }}>SESSION REF STATS</h2>
            <button onClick={() => { localStorage.removeItem(STORAGE_KEY); setStats({}); }} style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              Clear history
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {refs.sort((a, b) => b.reviews.length - a.reviews.length).map((ref) => {
              const total = ref.reviews.length;
              const fair = ref.reviews.filter((r) => r.verdict === "Fair Call").length;
              const bad = ref.reviews.filter((r) => r.verdict === "Bad Call").length;
              const inc = ref.reviews.filter((r) => r.verdict === "Inconclusive").length;
              const accuracy = total > 0 ? Math.round((fair / total) * 100) : 0;

              return (
                <div key={ref.name} style={{ padding: "14px", borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Initials name={ref.name} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{ref.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{ref.position} · {total} play{total !== 1 ? "s" : ""} reviewed</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: accuracy >= 70 ? "var(--green)" : accuracy >= 40 ? "var(--yellow)" : "var(--red)" }}>
                      {accuracy}%
                      <div style={{ fontSize: 10, fontWeight: 400, color: "var(--text-muted)", textAlign: "right" }}>Fair Rate</div>
                    </div>
                  </div>

                  {/* Bar */}
                  <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", height: 6, gap: 2 }}>
                    {fair > 0 && <div style={{ flex: fair, background: "var(--green)", borderRadius: 4 }} />}
                    {bad > 0 && <div style={{ flex: bad, background: "var(--red)", borderRadius: 4 }} />}
                    {inc > 0 && <div style={{ flex: inc, background: "var(--yellow)", borderRadius: 4 }} />}
                  </div>

                  <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{verdictDot("Fair Call")} {fair} Fair</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{verdictDot("Bad Call")} {bad} Bad</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{verdictDot("Inconclusive")} {inc} Inconclusive</span>
                  </div>

                  {/* Last 3 reviews */}
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                    {ref.reviews.slice(-3).reverse().map((rv) => (
                      <div key={rv.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
                        {verdictDot(rv.verdict)}
                        <span style={{ color: "var(--text-secondary)" }}>{rv.verdict}</span>
                        <span>·</span>
                        <span>{rv.sport}</span>
                        <span>·</span>
                        <span>{rv.gameName}</span>
                        <span>·</span>
                        <span>{new Date(rv.analyzedAt).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
