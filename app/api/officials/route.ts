import { NextRequest, NextResponse } from "next/server";

// ─── ESPN sport/league configs ────────────────────────────────────────────────
export const SPORT_LEAGUES: Record<string, { sport: string; leagues: { id: string; label: string }[] }> = {
  basketball: {
    sport: "basketball",
    leagues: [
      { id: "nba", label: "NBA" },
      { id: "wnba", label: "WNBA" },
    ],
  },
  soccer: {
    sport: "soccer",
    leagues: [
      { id: "eng.1", label: "Premier League" },
      { id: "usa.1", label: "MLS" },
      { id: "esp.1", label: "La Liga" },
      { id: "ita.1", label: "Serie A" },
      { id: "ger.1", label: "Bundesliga" },
      { id: "fra.1", label: "Ligue 1" },
    ],
  },
  americanfootball: {
    sport: "football",
    leagues: [
      { id: "nfl", label: "NFL" },
      { id: "college-football", label: "NCAA Football" },
    ],
  },
  baseball: {
    sport: "baseball",
    leagues: [{ id: "mlb", label: "MLB" }],
  },
  hockey: {
    sport: "hockey",
    leagues: [{ id: "nhl", label: "NHL" }],
  },
  tennis: {
    sport: "tennis",
    leagues: [{ id: "atp", label: "ATP" }],
  },
};

const ESPN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://www.espn.com",
  Referer: "https://www.espn.com/",
};

export interface Official {
  displayName: string;
  position: string;
  jerseyNumber?: string;
}

export interface GameInfo {
  id: string;
  name: string;
  date: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  status: string;
  espnUrl: string;
  league: string;
}

// ─── Helper: normalize officials from ESPN response ───────────────────────────
function extractOfficials(data: Record<string, unknown>): Official[] {
  // ESPN places officials in different locations by sport
  const raw: unknown[] =
    (data?.boxscore as Record<string, unknown>)?.officials as unknown[] ||
    (data?.officials as unknown[]) ||
    (data?.gameInfo as Record<string, unknown>)?.officials as unknown[] ||
    [];

  return (raw as Record<string, unknown>[]).map((o) => ({
    displayName:
      (o?.displayName as string) ||
      `${o?.firstName ?? ""} ${o?.lastName ?? ""}`.trim() ||
      "Unknown Official",
    position:
      (o?.position as Record<string, unknown>)?.displayName as string ||
      (o?.position as string) ||
      (o?.role as string) ||
      "Official",
    jerseyNumber: o?.jersey as string | undefined,
  }));
}

// ─── MLB Stats API fallback (official MLB data includes umpires) ───────────────
async function fetchMLBOfficials(
  date: string,
  homeTeam: string,
  awayTeam: string
): Promise<{ officials: Official[]; gameInfo: Partial<GameInfo> }> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=officials,teams`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("MLB API unavailable.");
  const data = await res.json();

  const games: Record<string, unknown>[] = (data?.dates?.[0]?.games as Record<string, unknown>[]) || [];
  const homeLower = homeTeam?.toLowerCase();
  const awayLower = awayTeam?.toLowerCase();

  let target = games.find((g) => {
    const home = ((g?.teams as Record<string, unknown>)?.home as Record<string, unknown>)?.team as Record<string, unknown>;
    const away = ((g?.teams as Record<string, unknown>)?.away as Record<string, unknown>)?.team as Record<string, unknown>;
    const hn = ((home?.name as string) || "").toLowerCase();
    const an = ((away?.name as string) || "").toLowerCase();
    const hm = !homeLower || hn.includes(homeLower);
    const am = !awayLower || an.includes(awayLower);
    return hm && am;
  });
  if (!target && games.length > 0) target = games[0];
  if (!target) return { officials: [], gameInfo: {} };

  const raw: Record<string, unknown>[] = (target?.officials as Record<string, unknown>[]) || [];
  const officials = raw.map((o) => ({
    displayName: ((o?.official as Record<string, unknown>)?.fullName as string) || "Unknown",
    position: (o?.officialType as string) || "Umpire",
  }));

  const home = ((target?.teams as Record<string, unknown>)?.home as Record<string, unknown>)?.team as Record<string, unknown>;
  const away = ((target?.teams as Record<string, unknown>)?.away as Record<string, unknown>)?.team as Record<string, unknown>;
  const gameInfo: Partial<GameInfo> = {
    id: String(target?.gamePk ?? ""),
    name: `${away?.name ?? "Away"} @ ${home?.name ?? "Home"}`,
    date: target?.gameDate as string,
    homeTeam: (home?.name as string) || "",
    awayTeam: (away?.name as string) || "",
    venue: ((target?.venue as Record<string, unknown>)?.name as string) || "",
    espnUrl: `https://www.mlb.com/gameday/${target?.gamePk}`,
    league: "MLB",
  };

  return { officials, gameInfo };
}

// ─── NHL API fallback ─────────────────────────────────────────────────────────
async function fetchNHLOfficials(
  date: string,
  homeTeam: string,
  awayTeam: string
): Promise<{ officials: Official[]; gameInfo: Partial<GameInfo> }> {
  const url = `https://api-web.nhle.com/v1/schedule/${date}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("NHL API unavailable.");
  const data = await res.json();

  const games: Record<string, unknown>[] =
    (data?.gameWeek?.[0]?.games as Record<string, unknown>[]) || [];
  const homeLower = homeTeam?.toLowerCase();
  const awayLower = awayTeam?.toLowerCase();

  let target = games.find((g) => {
    const hObj = (g?.homeTeam as Record<string, unknown>);
    const aObj = (g?.awayTeam as Record<string, unknown>);
    const hName = (((hObj?.placeName as Record<string, unknown>)?.default) as string || "").toLowerCase();
    const aName = (((aObj?.placeName as Record<string, unknown>)?.default) as string || "").toLowerCase();
    return (!homeLower || hName.includes(homeLower)) && (!awayLower || aName.includes(awayLower));
  });
  if (!target && games.length > 0) target = games[0];
  if (!target) return { officials: [], gameInfo: {} };

  const gameId = target?.id as string;
  let officials: Official[] = [];
  try {
    const boxRes = await fetch(`https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`);
    if (boxRes.ok) {
      const box = await boxRes.json();
      const refs: Record<string, unknown>[] =
        (box?.summary?.iceSurface?.referees as Record<string, unknown>[]) || [];
      const linesmen: Record<string, unknown>[] =
        (box?.summary?.iceSurface?.linesmen as Record<string, unknown>[]) || [];
      officials = [
        ...refs.map((r) => ({ displayName: (r?.default as string) || "Referee", position: "Referee" })),
        ...linesmen.map((l) => ({ displayName: (l?.default as string) || "Linesman", position: "Linesman" })),
      ];
    }
  } catch (_) {/* best-effort */}

  const homeTeamData = target?.homeTeam as Record<string, unknown>;
  const awayTeamData = target?.awayTeam as Record<string, unknown>;
  return {
    officials,
    gameInfo: {
      id: String(gameId),
      name: `${((awayTeamData?.placeName as Record<string,unknown>)?.default as string) ?? "Away"} @ ${((homeTeamData?.placeName as Record<string,unknown>)?.default as string) ?? "Home"}`,
      date: target?.startTimeUTC as string,
      homeTeam: ((homeTeamData?.placeName as Record<string,unknown>)?.default as string) || "",
      awayTeam: ((awayTeamData?.placeName as Record<string,unknown>)?.default as string) || "",
      venue: ((target?.venue as Record<string, unknown>)?.default as string) || "",
      espnUrl: `https://www.nhl.com/gamecenter/${gameId}`,
      league: "NHL",
    },
  };
}

// ─── Main Route ───────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { sport, date, homeTeam, awayTeam, league } = await req.json();

  if (!sport || !date) {
    return NextResponse.json({ error: "sport and date are required." }, { status: 400 });
  }

  // Use dedicated APIs for MLB and NHL (better official data)
  try {
    if (sport === "baseball") {
      const result = await fetchMLBOfficials(date, homeTeam, awayTeam);
      return NextResponse.json({ ...result, source: "MLB Stats API" });
    }
    if (sport === "hockey") {
      const result = await fetchNHLOfficials(date, homeTeam, awayTeam);
      return NextResponse.json({ ...result, source: "NHL API" });
    }
  } catch (err) {
    console.warn("Dedicated API failed, falling back to ESPN:", err);
  }

  // ESPN fallback for all sports
  const cfg = SPORT_LEAGUES[sport];
  if (!cfg) return NextResponse.json({ error: "Sport not supported." }, { status: 400 });

  const espnLeague = league || cfg.leagues[0].id;
  const espnSport = cfg.sport;
  const espnDate = date.replace(/-/g, "");
  const homeLower = homeTeam?.toLowerCase() || "";
  const awayLower = awayTeam?.toLowerCase() || "";

  try {
    const sbUrl = `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/${espnLeague}/scoreboard?dates=${espnDate}`;
    const sbRes = await fetch(sbUrl, { headers: ESPN_HEADERS, next: { revalidate: 300 } });
    if (!sbRes.ok) throw new Error(`ESPN scoreboard returned ${sbRes.status}`);
    const sbData = await sbRes.json();
    const events: Record<string, unknown>[] = (sbData?.events as Record<string, unknown>[]) || [];

    if (events.length === 0) {
      return NextResponse.json({
        officials: [],
        gameInfo: null,
        message: `No ${espnLeague.toUpperCase()} games found on ${date}.`,
        source: "ESPN",
      });
    }

    // Find best-matching game
    let target: Record<string, unknown> | null = null;
    for (const ev of events) {
      const comps: Record<string, unknown>[] =
        ((ev?.competitions as Record<string, unknown>[])?.[0]?.competitors as Record<string, unknown>[]) || [];
      const names = comps.map((c) => ((c?.team as Record<string, unknown>)?.displayName as string || "").toLowerCase());
      const abbrs = comps.map((c) => ((c?.team as Record<string, unknown>)?.abbreviation as string || "").toLowerCase());
      const hm = !homeLower || names.some((n) => n.includes(homeLower)) || abbrs.some((a) => a.includes(homeLower));
      const am = !awayLower || names.some((n) => n.includes(awayLower)) || abbrs.some((a) => a.includes(awayLower));
      if (hm && am) { target = ev; break; }
    }
    if (!target) target = events[0];

    const eventId = target?.id as string;
    const sumUrl = `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/${espnLeague}/summary?event=${eventId}`;
    const sumRes = await fetch(sumUrl, { headers: ESPN_HEADERS });
    if (!sumRes.ok) throw new Error(`ESPN summary returned ${sumRes.status}`);
    const sumData = (await sumRes.json()) as Record<string, unknown>;

    const officials = extractOfficials(sumData);
    const comps: Record<string, unknown>[] =
      ((target?.competitions as Record<string, unknown>[])?.[0]?.competitors as Record<string, unknown>[]) || [];
    const home = comps.find((c) => c?.homeAway === "home");
    const away = comps.find((c) => c?.homeAway === "away");

    const gameInfo: GameInfo = {
      id: eventId,
      name: (target?.name as string) || "",
      date: (target?.date as string) || date,
      homeTeam: (home?.team as Record<string, unknown>)?.displayName as string || "",
      awayTeam: (away?.team as Record<string, unknown>)?.displayName as string || "",
      venue: ((target?.competitions as Record<string, unknown>[])?.[0]?.venue as Record<string, unknown>)?.fullName as string || "",
      status: ((target?.status as Record<string,unknown>)?.type as Record<string,unknown>)?.description as string || "",
      espnUrl: `https://www.espn.com/${espnSport}/game/_/gameId/${eventId}`,
      league: espnLeague.toUpperCase(),
    };

    return NextResponse.json({
      officials,
      gameInfo,
      totalGames: events.length,
      matched: !!target,
      source: "ESPN",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Lookup failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
