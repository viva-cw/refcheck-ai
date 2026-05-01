"use client";

import { useState } from "react";
import { SPORT_LEAGUES } from "../api/officials/route";
import type { Official, GameInfo } from "../api/officials/route";

interface Props {
  sport: string;
  onOfficials: (officials: Official[], gameInfo: GameInfo | null) => void;
}

export default function OfficialLookup({ sport, onOfficials }: Props) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  const [league, setLeague] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ officials: Official[]; gameInfo: GameInfo | null; source?: string } | null>(null);

  const leagues = SPORT_LEAGUES[sport]?.leagues || [];
  const selectedLeague = league || leagues[0]?.id || "";

  const lookup = async () => {
    setLoading(true); setError(null); setFound(null);
    try {
      const res = await fetch("/api/officials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sport, date, homeTeam, awayTeam, league: selectedLeague }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Lookup failed.");
      setFound(data);
      onOfficials(data.officials || [], data.gameInfo || null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not find game.");
    } finally { setLoading(false); }
  };

  const inp = {
    width: "100%", padding: "10px 14px", borderRadius: 10,
    background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-bright)",
    color: "var(--text-primary)", fontSize: 14, outline: "none", fontFamily: "inherit",
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", padding: "12px 16px", borderRadius: 12, cursor: "pointer",
        background: open ? "rgba(124,106,247,0.08)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${open ? "rgba(124,106,247,0.4)" : "var(--border)"}`,
        color: open ? "#a78bfa" : "var(--text-secondary)",
        fontFamily: "inherit", fontSize: 14, fontWeight: 600,
        display: "flex", alignItems: "center", justifyContent: "space-between", transition: "all 0.2s",
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          🔍 Identify Officiating Crew
          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 99, background: "rgba(124,106,247,0.15)", color: "#a78bfa", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>Optional</span>
        </span>
        <span style={{ transition: "transform 0.2s", display: "inline-block", transform: open ? "rotate(180deg)" : "none" }}>▾</span>
      </button>

      {open && (
        <div className="animate-fade-in" style={{ marginTop: 8, padding: "20px", borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
            Link this clip to a real game to identify the officiating crew and enable referee performance tracking.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Game Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inp} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>League</label>
              <select value={selectedLeague} onChange={(e) => setLeague(e.target.value)} style={{ ...inp, appearance: "none" as const }}>
                {leagues.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Away Team</label>
              <input type="text" placeholder="e.g. Lakers, Arsenal" value={awayTeam} onChange={(e) => setAwayTeam(e.target.value)} style={inp} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Home Team</label>
              <input type="text" placeholder="e.g. Celtics, Chelsea" value={homeTeam} onChange={(e) => setHomeTeam(e.target.value)} style={inp} />
            </div>
          </div>

          {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "var(--red-dim)", border: "1px solid rgba(244,63,94,0.3)", color: "var(--red)", fontSize: 13 }}>⚠️ {error}</div>}

          {found?.gameInfo && (
            <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "var(--green-dim)", border: "1px solid rgba(34,197,94,0.3)", fontSize: 13 }}>
              <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ Found: </span>
              <span style={{ color: "var(--text-primary)" }}>{found.gameInfo.name}</span>
              <span style={{ color: "var(--text-secondary)" }}> · {found.officials.length > 0 ? `${found.officials.length} officials identified` : "No officials in public data"}</span>
              {found.source && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(34,197,94,0.15)", color: "var(--green)" }}>via {found.source}</span>}
            </div>
          )}

          <button onClick={lookup} disabled={loading} style={{
            padding: "10px 24px", borderRadius: 10, border: "none", cursor: "pointer",
            background: "linear-gradient(135deg, rgba(124,106,247,0.8), rgba(79,142,247,0.8))",
            color: "white", fontWeight: 600, fontSize: 14, fontFamily: "inherit",
            opacity: loading ? 0.7 : 1, transition: "all 0.2s",
          }}>
            {loading ? "🔎 Searching..." : "🔎 Find Game & Officials"}
          </button>
        </div>
      )}
    </div>
  );
}
