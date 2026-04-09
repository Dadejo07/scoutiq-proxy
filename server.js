/**
 * ScoutIQ — Flashscore Proxy Server v2
 * Betere headers, debug endpoint, fallback parsing
 */

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET"] }));

// ─── Flashscore team IDs ────────────────────────────────────────────────────
const TEAM_IDS = {
  "Ajax":             "WNNf2vJ8",
  "PSV":              "I5mLFMlG",
  "Feyenoord":        "YBNl61EI",
  "AZ":               "fFCfmBxe",
  "FC Utrecht":       "CxGFwGaH",
  "FC Twente":        "EIAstm0O",
  "NEC Nijmegen":     "pNmV2Nqk",
  "Go Ahead Eagles":  "nQ6Ixm7d",
  "Heracles":         "nG4mGJAJ",
  "Sparta Rotterdam": "SqpWGDpD",
  "RKC Waalwijk":     "fVpEiHlt",
  "PEC Zwolle":       "nJWMXxrp",
  "Almere City":      "M7JLlHBj",
  "FC Groningen":     "EJP3Sl8m",
  "Willem II":        "bBxpTekb",
  "sc Heerenveen":    "tjT8Z2V0",
  "NAC Breda":        "tL1MkSTn",
  "Fortuna Sittard":  "tpB1WdVp",
};

// ─── Headers die een echte browser nabootsen ────────────────────────────────
function getHeaders(referer = "https://www.flashscore.nl/") {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "text/plain, */*; q=0.01",
    "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": referer,
    "Origin": "https://www.flashscore.nl",
    "x-fsign": "SW9D1eZo",
    "x-requested-with": "XMLHttpRequest",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", server: "ScoutIQ Proxy v2" }));

// ─── Debug: zie ruwe Flashscore response ─────────────────────────────────────
app.get("/api/debug/:clubnaam", async (req, res) => {
  try {
    const clubnaam = decodeURIComponent(req.params.clubnaam);
    const teamId   = TEAM_IDS[clubnaam];
    if (!teamId) return res.json({ error: "Club niet gevonden", beschikbaar: Object.keys(TEAM_IDS) });

    const url = `https://www.flashscore.nl/x/feed/tr_1_${teamId}`;
    const resp = await fetch(url, { headers: getHeaders() });

    res.json({
      club: clubnaam,
      teamId,
      url,
      httpStatus: resp.status,
      httpOk: resp.ok,
      contentType: resp.headers.get("content-type"),
      rawBody: (await resp.text()).slice(0, 2000),
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── Debug lineup ─────────────────────────────────────────────────────────────
app.get("/api/debug-lineup/:matchId", async (req, res) => {
  try {
    const url  = `https://www.flashscore.nl/x/feed/lineups-${req.params.matchId}`;
    const resp = await fetch(url, { headers: getHeaders() });
    res.json({
      url,
      httpStatus: resp.status,
      rawBody: (await resp.text()).slice(0, 3000),
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── Laatste opstelling ───────────────────────────────────────────────────────
app.get("/api/laatste-opstelling/:clubnaam", async (req, res) => {
  try {
    const clubnaam = decodeURIComponent(req.params.clubnaam);
    const teamId   = TEAM_IDS[clubnaam];
    if (!teamId) return res.status(404).json({ error: `Club "${clubnaam}" niet gevonden` });

    // Stap 1: haal recente wedstrijden op
    const matchUrl  = `https://www.flashscore.nl/x/feed/tr_1_${teamId}`;
    const matchResp = await fetch(matchUrl, { headers: getHeaders() });
    if (!matchResp.ok) {
      return res.status(502).json({ error: `Flashscore HTTP ${matchResp.status}`, url: matchUrl });
    }

    const matchBody = await matchResp.text();
    console.log(`[${clubnaam}] Match body preview:`, matchBody.slice(0, 300));

    const wedstrijden = parseMatches(matchBody, clubnaam);
    console.log(`[${clubnaam}] Gevonden wedstrijden:`, wedstrijden.length);

    if (!wedstrijden.length) {
      return res.status(404).json({
        error: "Geen gespeelde wedstrijden gevonden",
        rawPreview: matchBody.slice(0, 500)
      });
    }

    // Stap 2: haal opstelling op van meest recente wedstrijd
    const laatste   = wedstrijden[0];
    const lineupUrl = `https://www.flashscore.nl/x/feed/lineups-${laatste.id}`;
    const lineupResp = await fetch(lineupUrl, { headers: getHeaders(`https://www.flashscore.nl/wedstrijd/${laatste.id}/#/wedstrijd-samenvatting/opstellingen`) });

    if (!lineupResp.ok) {
      return res.status(502).json({ error: `Lineup HTTP ${lineupResp.status}`, matchId: laatste.id });
    }

    const lineupBody = await lineupResp.text();
    console.log(`[${clubnaam}] Lineup body preview:`, lineupBody.slice(0, 400));

    const opstelling = parseLineup(lineupBody, clubnaam);

    res.json({
      club:         clubnaam,
      tegenstander: laatste.tegenstander,
      datum:        laatste.datum,
      score:        laatste.score,
      thuis:        laatste.isThuis,
      thuis_naam:   laatste.thuis,
      uit_naam:     laatste.uit,
      wedstrijdId:  laatste.id,
      seizoen:      "2025-2026",
      competitie:   "Eredivisie",
      bron:         "flashscore.nl",
      ...opstelling,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Parser: wedstrijden ──────────────────────────────────────────────────────
function parseMatches(raw, clubnaam) {
  const results = [];
  const club_lower = clubnaam.toLowerCase();

  // Flashscore scheidt records met "÷" en velden met "¬"
  const records = raw.split("÷AA÷");

  for (const record of records.slice(1)) {
    try {
      const velden = {};
      // Elk veld is CODE÷WAARDE gescheiden door ¬
      const parts = ("AA÷" + record).split("¬");
      for (const part of parts) {
        const divIdx = part.indexOf("÷");
        if (divIdx > 0) {
          velden[part.slice(0, divIdx)] = part.slice(divIdx + 1);
        }
      }

      // Status 100 = afgelopen wedstrijd
      if (velden["AB"] !== "100") continue;

      const thuis = (velden["CX"] || velden["CL"] || "").trim();
      const uit   = (velden["CY"] || velden["CM"] || "").trim();

      if (!thuis && !uit) continue;

      const isThuis = thuis.toLowerCase().includes(club_lower);
      const isUit   = uit.toLowerCase().includes(club_lower);
      if (!isThuis && !isUit) continue;

      results.push({
        id:           velden["AA"],
        datum:        formatDatum(velden["AD"]),
        thuis,
        uit,
        score:        `${velden["AF"] || "?"}-${velden["AG"] || "?"}`,
        tegenstander: isThuis ? uit : thuis,
        isThuis,
      });
    } catch (e) {
      // sla kapotte records over
    }
  }

  return results;
}

// ─── Parser: opstelling ───────────────────────────────────────────────────────
function parseLineup(raw, clubnaam) {
  const basiself      = [];
  const wisselspelers = [];
  let   formatie      = "";
  let   formatieThuis = "";
  let   formatieUit   = "";

  const records = raw.split("¬");
  const velden  = {};

  for (const part of records) {
    const divIdx = part.indexOf("÷");
    if (divIdx > 0) {
      velden[part.slice(0, divIdx)] = part.slice(divIdx + 1);
    }
  }

  // Formaties
  if (velden["WI"]) formatieThuis = velden["WI"];
  if (velden["WJ"]) formatieUit   = velden["WJ"];
  formatie = formatieThuis || formatieUit || "4-3-3";

  // Spelers — Flashscore groepeert spelers per team
  // WA = thuisteam spelers blok, WB = uitteam spelers blok
  // Elk speler blok heeft: WL (voornaam), WM (achternaam), WN (nummer), WO (positie), WK (kapitein)

  // Gebruik regex om speler blokken te vinden
  const spelerRegex = /WN÷(\d+)¬WO÷([^¬]*)¬(?:WK÷([^¬]*)¬)?WL÷([^¬]*)¬WM÷([^¬]*)/g;
  let match;
  let spelerId = 0;

  while ((match = spelerRegex.exec(raw)) !== null) {
    spelerId++;
    const [, nummer, positieCode, kapitein, voornaam, achternaam] = match;
    const naam = `${voornaam} ${achternaam}`.trim();
    if (!naam || naam === " ") continue;

    const speler = {
      naam,
      nummer: parseInt(nummer) || spelerId,
      positie: mapPositie(positieCode),
      kapitein: kapitein === "1",
    };

    // Basis vs wissel: probeer te bepalen via context
    // Simpele heuristiek: eerste 22 spelers zijn basis (11 thuis + 11 uit)
    if (basiself.length < 22) basiself.push(speler);
    else wisselspelers.push(speler);
  }

  // Neem eerste 11 als basiself van één team (thuis)
  const basis11 = basiself.slice(0, 11);
  const subs    = basiself.slice(11, 22).concat(wisselspelers).slice(0, 7);

  return {
    formatie,
    basiself:      basis11.length >= 11 ? basis11 : basiself.slice(0, 11),
    wisselspelers: subs,
    rawLineupPreview: raw.slice(0, 300),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDatum(ts) {
  if (!ts) return "Onbekend";
  try {
    return new Date(parseInt(ts) * 1000).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" });
  } catch { return ts; }
}

function mapPositie(code) {
  const map = {
    "1":"GK","2":"RB","3":"CB","4":"CB","5":"LB",
    "6":"CDM","7":"CM","8":"CM","9":"CAM",
    "10":"RW","11":"ST","12":"LW",
    "G":"GK","D":"CB","M":"CM","F":"ST","A":"ST",
  };
  return map[String(code)] || code || "MID";
}

app.listen(PORT, () => {
  console.log(`✅ ScoutIQ Proxy v2 op poort ${PORT}`);
  console.log(`   Debug Ajax: /api/debug/Ajax`);
});
