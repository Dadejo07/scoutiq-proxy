/**
 * ScoutIQ — Flashscore Proxy Server
 * -----------------------------------
 * Draai lokaal: node server.js
 * Of deploy naar Railway / Render / Fly.io
 *
 * SETUP:
 *   npm install
 *   node server.js
 *
 * De app stuurt requests naar http://localhost:3001/api/...
 */

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3001;

// Sta requests toe vanuit claude.ai en localhost
app.use(cors({
  origin: ["http://localhost:3000", "https://claude.ai", "https://www.claudeusercontent.com"],
  methods: ["GET"],
}));

// ─── Flashscore headers (nabootsen van browser) ────────────────────────────
const FS_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
  "Referer":         "https://www.flashscore.nl/",
  "Origin":          "https://www.flashscore.nl",
  "x-fsign":         "SW9D1eZo",   // publieke signing key die Flashscore gebruikt
};

const FS_BASE = "https://www.flashscore.nl";

// ─── Eredivisie team IDs op Flashscore ────────────────────────────────────
// Format: { "clubnaam": "flashscore-team-id" }
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

// ─── Hulpfunctie: fetch met foutafhandeling ────────────────────────────────
async function fsFetch(url) {
  const res = await fetch(url, { headers: FS_HEADERS });
  if (!res.ok) throw new Error(`Flashscore HTTP ${res.status} voor ${url}`);
  return res.text();
}

// ─── Route 1: haal meest recente wedstrijd op van een club ─────────────────
// GET /api/matches/:clubnaam
app.get("/api/matches/:clubnaam", async (req, res) => {
  try {
    const clubnaam = decodeURIComponent(req.params.clubnaam);
    const teamId   = TEAM_IDS[clubnaam];

    if (!teamId) {
      return res.status(404).json({ error: `Onbekende club: ${clubnaam}` });
    }

    // Flashscore feed: recente wedstrijden van een team
    const url  = `${FS_BASE}/x/feed/tr_1_${teamId}`;
    const body = await fsFetch(url);

    // Flashscore geeft eigen formaat terug — parse het
    const wedstrijden = parseFlashscoreMatches(body, clubnaam);

    res.json({ club: clubnaam, wedstrijden });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 2: haal opstelling op van een specifieke wedstrijd ──────────────
// GET /api/lineup/:matchId
app.get("/api/lineup/:matchId", async (req, res) => {
  try {
    const matchId = req.params.matchId;

    // Flashscore line-ups feed
    const url  = `${FS_BASE}/x/feed/lineups-${matchId}`;
    const body = await fsFetch(url);

    const opstelling = parseFlashscoreLineup(body);

    res.json({ matchId, ...opstelling });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 3: alles in één — geef laatste opstelling van een club ──────────
// GET /api/laatste-opstelling/:clubnaam
app.get("/api/laatste-opstelling/:clubnaam", async (req, res) => {
  try {
    const clubnaam = decodeURIComponent(req.params.clubnaam);
    const teamId   = TEAM_IDS[clubnaam];

    if (!teamId) {
      return res.status(404).json({ error: `Club "${clubnaam}" niet gevonden. Beschikbare clubs: ${Object.keys(TEAM_IDS).join(", ")}` });
    }

    // Stap 1: haal recente wedstrijden op
    const matchUrl  = `${FS_BASE}/x/feed/tr_1_${teamId}`;
    const matchBody = await fsFetch(matchUrl);
    const wedstrijden = parseFlashscoreMatches(matchBody, clubnaam);

    if (!wedstrijden.length) {
      return res.status(404).json({ error: "Geen gespeelde wedstrijden gevonden" });
    }

    // Stap 2: neem meest recente gespeelde wedstrijd
    const laatste = wedstrijden[0];

    // Stap 3: haal opstelling op
    const lineupUrl  = `${FS_BASE}/x/feed/lineups-${laatste.id}`;
    const lineupBody = await fsFetch(lineupUrl);
    const opstelling = parseFlashscoreLineup(lineupBody, clubnaam);

    res.json({
      club:         clubnaam,
      tegenstander: laatste.tegenstander,
      datum:        laatste.datum,
      score:        laatste.score,
      thuis:        laatste.thuis,
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

// ─── Health check ──────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", server: "ScoutIQ Proxy" }));

// ─── Parser: Flashscore wedstrijden ────────────────────────────────────────
function parseFlashscoreMatches(raw, clubnaam) {
  const wedstrijden = [];
  // Flashscore gebruikt een eigen tekst-formaat gescheiden door "¬" en "÷"
  const regels = raw.split("÷");

  for (const regel of regels) {
    try {
      // Zoek velden: AA÷matchId¬AB÷status¬...
      const velden = {};
      regel.split("¬").forEach(v => {
        const idx = v.indexOf("÷");
        if (idx > 0) velden[v.slice(0, idx)] = v.slice(idx + 1);
      });

      // Alleen gespeelde Eredivisie wedstrijden (status = 100 = finished)
      if (!velden["AA"] || velden["AB"] !== "100") continue;

      const thuis = velden["CX"] || velden["CL"] || "";
      const uit   = velden["CY"] || velden["CM"] || "";

      if (!thuis.toLowerCase().includes(clubnaam.toLowerCase()) &&
          !uit.toLowerCase().includes(clubnaam.toLowerCase())) continue;

      wedstrijden.push({
        id:           velden["AA"],
        datum:        formatDatum(velden["AD"]),
        thuis:        thuis,
        uit:          uit,
        scoreThuis:   velden["AF"] || "?",
        scoreUit:     velden["AG"] || "?",
        score:        `${velden["AF"] || "?"}-${velden["AG"] || "?"}`,
        tegenstander: thuis.toLowerCase().includes(clubnaam.toLowerCase()) ? uit : thuis,
        isThuis:      thuis.toLowerCase().includes(clubnaam.toLowerCase()),
      });
    } catch { /* sla kapotte regels over */ }
  }

  // Sorteer: meest recent eerst
  return wedstrijden.slice(0, 10);
}

// ─── Parser: Flashscore opstelling ─────────────────────────────────────────
function parseFlashscoreLineup(raw, clubnaam = "") {
  const basiself      = [];
  const wisselspelers = [];
  let formatie        = "4-3-3";
  let formatieThuis   = "";
  let formatieUit     = "";

  const regels = raw.split("÷");

  for (const regel of regels) {
    const velden = {};
    regel.split("¬").forEach(v => {
      const idx = v.indexOf("÷");
      if (idx > 0) velden[v.slice(0, idx)] = v.slice(idx + 1);
    });

    // Formatie
    if (velden["WI"]) formatieThuis = velden["WI"];
    if (velden["WJ"]) formatieUit   = velden["WJ"];

    // Speler (type WC = basis, WD = wissel)
    if (!velden["WC"] && !velden["WD"]) continue;

    const speler = {
      naam:    [velden["WL"] || "", velden["WM"] || ""].join(" ").trim(),
      nummer:  parseInt(velden["WN"] || "0") || 0,
      positie: mapPositie(velden["WO"] || ""),
      kapitein: velden["WK"] === "1",
      team:    velden["WB"] === "1" ? "thuis" : "uit",
    };

    if (!speler.naam) continue;

    if (velden["WC"]) basiself.push(speler);
    else wisselspelers.push(speler);
  }

  // Filter op club (thuis of uit team)
  // Als clubnaam meegegeven: filter op dat team, anders neem thuis-team
  const isThuis  = basiself.some(s => s.team === "thuis");
  const teamTag  = "thuis"; // standaard toon thuis-team; uitbreiding mogelijk
  const basis11  = basiself.filter(s => s.team === teamTag).slice(0, 11);
  const subs     = wisselspelers.filter(s => s.team === teamTag).slice(0, 7);

  formatie = formatieThuis || formatieUit || "4-3-3";

  return {
    formatie,
    basiself:      basis11.length ? basis11 : basiself.slice(0, 11),
    wisselspelers: subs.length    ? subs    : wisselspelers.slice(0, 7),
  };
}

// ─── Hulpfuncties ──────────────────────────────────────────────────────────
function formatDatum(timestamp) {
  if (!timestamp) return "Onbekend";
  const d = new Date(parseInt(timestamp) * 1000);
  return d.toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" });
}

function mapPositie(code) {
  const map = {
    "1": "GK", "2": "RB", "3": "CB", "4": "CB", "5": "LB",
    "6": "CDM", "7": "CM", "8": "CM", "9": "CAM",
    "10": "RW", "11": "ST", "12": "LW",
    "G": "GK", "D": "CB", "M": "CM", "F": "ST",
  };
  return map[code] || code || "MID";
}

// ─── Start server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ ScoutIQ Proxy draait op http://localhost:${PORT}`);
  console.log(`   Test: http://localhost:${PORT}/api/laatste-opstelling/Ajax`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
