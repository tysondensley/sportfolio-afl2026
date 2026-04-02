const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialise DB table if needed
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gamestate (
      id INTEGER PRIMARY KEY DEFAULT 1,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Seed initial state if table is empty
  const result = await pool.query("SELECT id FROM gamestate WHERE id = 1");
  if (result.rows.length === 0) {
    console.log("No existing state — seeding and running AI pre-season trades...");
    const initial = makeInitialState();
    await pool.query(
      `INSERT INTO gamestate (id, state, updated_at) VALUES (1, $1, NOW())`,
      [JSON.stringify(initial)]
    );
    // Run AI pre-season investments
    await runAIPreseason();
  }
  console.log("Database ready");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── GAME CONSTANTS ────────────────────────────────────────────

const AFL_TEAMS = [
  { name: "Brisbane Lions",   emoji: "🦁", odds: 4.50  },
  { name: "Gold Coast Suns",  emoji: "☀️", odds: 8.50  },
  { name: "Sydney Swans",     emoji: "🦢", odds: 9.00  },
  { name: "Hawthorn",         emoji: "🦅", odds: 10.00 },
  { name: "Fremantle",        emoji: "⚓", odds: 11.00 },
  { name: "Geelong",          emoji: "🐱", odds: 13.00 },
  { name: "Adelaide",         emoji: "🦔", odds: 14.00 },
  { name: "St Kilda",         emoji: "⭐", odds: 15.00 },
  { name: "Western Bulldogs", emoji: "🐾", odds: 15.00 },
  { name: "Collingwood",      emoji: "🎵", odds: 18.00 },
  { name: "GWS Giants",       emoji: "🦊", odds: 21.00 },
  { name: "Carlton",          emoji: "💙", odds: 41.00 },
  { name: "Port Adelaide",    emoji: "⚡", odds: 41.00 },
  { name: "Melbourne",        emoji: "🔴", odds: 81.00 },
  { name: "Essendon",         emoji: "🔥", odds: 101.00 },
  { name: "North Melbourne",  emoji: "🦘", odds: 151.00 },
  { name: "Richmond",         emoji: "🐯", odds: 251.00 },
  { name: "West Coast",       emoji: "🌊", odds: 251.00 },
];

// ── SQUIGGLE INTEGRATION ──────────────────────────────────────

// Squiggle uses different team name conventions — map to ours
const SQUIGGLE_NAME_MAP = {
  "Adelaide":             "Adelaide",
  "Brisbane":             "Brisbane Lions",
  "Brisbane Lions":       "Brisbane Lions",
  "Carlton":              "Carlton",
  "Collingwood":          "Collingwood",
  "Essendon":             "Essendon",
  "Fremantle":            "Fremantle",
  "Geelong":              "Geelong",
  "Gold Coast":           "Gold Coast Suns",
  "Gold Coast Suns":      "Gold Coast Suns",
  "Greater Western Sydney": "GWS Giants",
  "GWS":                  "GWS Giants",
  "GWS Giants":           "GWS Giants",
  "Hawthorn":             "Hawthorn",
  "Melbourne":            "Melbourne",
  "North Melbourne":      "North Melbourne",
  "Port Adelaide":        "Port Adelaide",
  "Richmond":             "Richmond",
  "St Kilda":             "St Kilda",
  "Sydney":               "Sydney Swans",
  "Sydney Swans":         "Sydney Swans",
  "West Coast":           "West Coast",
  "Western Bulldogs":     "Western Bulldogs",
};

// Fetch current standings from Squiggle for a given AFL round
async function fetchSquiggleLadder(aflRound) {
  const year = 2026;
  const url = `https://api.squiggle.com.au/?q=standings;year=${year};round=${aflRound}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Sportfolio-AFL2026/1.0 (personal fantasy game; contact via github)" }
    });
    if (!res.ok) throw new Error(`Squiggle returned ${res.status}`);
    const data = await res.json();
    if (!data.standings || data.standings.length === 0) throw new Error("No standings data");

    // Sort by rank (Squiggle returns rank field)
    const sorted = [...data.standings].sort((a, b) => a.rank - b.rank);
    console.log("Squiggle raw names:", sorted.map(s => s.name).join(", "));

    // Map to our ladder format
    return sorted.map(s => {
      const ourName = SQUIGGLE_NAME_MAP[s.name] || s.name;
      const teamInfo = AFL_TEAMS.find(t => t.name === ourName) || { emoji: "🏉" };
      if (!AFL_TEAMS.find(t => t.name === ourName)) {
        console.warn(`Squiggle name not mapped: "${s.name}" -> "${ourName}"`);
      }
      const wins = s.wins || 0;
      const losses = s.losses || 0;
      const draws = s.draws || 0;
      const played = wins + losses + draws;
      const pts = (wins * 4) + (draws * 2);
      const pct = s.percentage ? parseFloat(s.percentage.toFixed(1)) : 100;
      return {
        name: ourName,
        emoji: teamInfo.emoji,
        wins, losses, draws, played, pts,
        pct,
      };
    });
  } catch(e) {
    console.error("Squiggle fetch failed:", e.message);
    return null;
  }
}

// Map game round number in Sportfolio (1=after OR, 2=after R1...) to AFL round number
// Sportfolio round 1 trading = after AFL Opening Round (round 1 in Squiggle for 2026)
// Sportfolio round 2 trading = after AFL Round 1 = Squiggle round 2... etc
function sportfolioRoundToAFLRound(sportfolioRound) {
  return sportfolioRound; // 1:1 mapping — OR=round 1, R1=round 2, etc in AFL numbering
}

let squigglePoller = null;

async function startSquigglePolling() {
  if (squigglePoller) return; // Already running
  console.log("Starting Squiggle live ladder polling...");

  squigglePoller = setInterval(async () => {
    try {
      const gs = await loadState();
      const deadline = gs.tradeDeadline ? new Date(gs.tradeDeadline).getTime() : null;
      const isLocked = deadline && Date.now() > deadline;

      // Only poll during lockout (round in progress)
      if (!isLocked || gs.round >= TOTAL_ROUNDS) {
        stopSquigglePolling();
        return;
      }

      const aflRound = sportfolioRoundToAFLRound(gs.round);
      const newLadder = await fetchSquiggleLadder(aflRound);
      if (!newLadder) return;

      // Check if ladder has actually changed
      const oldOrder = gs.ladder.map(t => t.name).join(",");
      const newOrder = newLadder.map(t => t.name).join(",");
      const oldPcts  = gs.ladder.map(t => t.pct).join(",");
      const newPcts  = newLadder.map(t => t.pct).join(",");

      if (oldOrder === newOrder && oldPcts === newPcts) {
        console.log("Squiggle: no ladder change detected");
        return;
      }

      console.log(`Squiggle update: ladder changed for round ${aflRound}`);
      gs.ladder = newLadder;
      gs.liveUpdatedAt = new Date().toISOString();

      // Daily headline refresh
      if (await maybeRefreshHeadlines(gs)) {
        console.log("Refreshing AI headlines (daily cycle)...");
        gs.headlines = await generateAIHeadlines(gs);
      }

      await saveState(gs);
    } catch(e) {
      console.error("Squiggle poller error:", e.message);
    }
  }, 5 * 60 * 1000); // Every 5 minutes
}

function stopSquigglePolling() {
  if (squigglePoller) {
    clearInterval(squigglePoller);
    squigglePoller = null;
    console.log("Squiggle polling stopped.");
  }
}

const PRICE_SCALE = {
  1:6.12, 2:5.56, 3:5.05, 4:4.59, 5:4.18,
  6:3.80, 7:3.45, 8:3.14, 9:2.85, 10:2.59,
  11:2.36, 12:2.14, 13:1.95, 14:1.77, 15:1.61,
  16:1.46, 17:1.33, 18:1.00
};

const INTEREST_RATES = { 1:0.02, 2:0.015, 3:0.01, 4:0.005 };
const BOTTOM_TAX = 0.01;
const PORTFOLIO_CAP = 0.25;
const MIN_HOLD = 2;
const PRESEASON_HOLD = 2;
const TOTAL_ROUNDS = 10;
const HUMAN_PLAYERS = ["Tyson", "Jas", "Sam"];
const AI_PLAYERS = ["Alex", "Jordan", "Casey", "Riley", "Morgan", "Quinn", "Blake"];
const ALL_PLAYERS = [...HUMAN_PLAYERS, ...AI_PLAYERS];

// ── STATE HELPERS ─────────────────────────────────────────────

function makeInitialState() {
  const ladder = AFL_TEAMS.map((t, i) => ({
    name: t.name, emoji: t.emoji,
    wins: 0, losses: 0, draws: 0, pts: 0, pct: 100, pos: i + 1
  }));
  const players = {};
  ALL_PLAYERS.forEach(name => {
    players[name] = {
      name, isHuman: HUMAN_PLAYERS.includes(name),
      cash: 10000, holdings: [], tradeLog: [],
      tradesThisRound: 0, consecutiveTop4: {}
    };
  });
  return { round: 0, ladder, prevLadder: null, players, lastUpdated: Date.now(), fixtures: {
    1: [ // Opening Round
      ["Sydney Swans","Carlton"],
      ["Gold Coast Suns","Geelong"],
      ["GWS Giants","Hawthorn"],
      ["Brisbane Lions","Western Bulldogs"],
      ["St Kilda","Collingwood"]
    ],
    2: [ // Round 1
      ["Carlton","Richmond"],
      ["Essendon","Hawthorn"],
      ["Western Bulldogs","GWS Giants"],
      ["Geelong","Fremantle"],
      ["Sydney Swans","Brisbane Lions"],
      ["Collingwood","Adelaide"],
      ["North Melbourne","Port Adelaide"],
      ["Melbourne","St Kilda"],
      ["Gold Coast Suns","West Coast"]
    ],
    3: [ // Round 2
      ["Hawthorn","Sydney Swans"],
      ["Adelaide","Western Bulldogs"],
      ["Richmond","Gold Coast Suns"],
      ["GWS Giants","St Kilda"],
      ["Fremantle","Melbourne"],
      ["Port Adelaide","Essendon"],
      ["West Coast","North Melbourne"]
    ],
    4: [ // Round 3
      ["Geelong","Adelaide"],
      ["Collingwood","GWS Giants"],
      ["St Kilda","Brisbane Lions"],
      ["Fremantle","Richmond"],
      ["Essendon","North Melbourne"],
      ["Port Adelaide","West Coast"],
      ["Carlton","Melbourne"]
    ],
    5: [ // Round 4
      ["Brisbane Lions","Collingwood"],
      ["North Melbourne","Carlton"],
      ["Adelaide","Fremantle"],
      ["Richmond","Port Adelaide"],
      ["West Coast","Sydney Swans"],
      ["Melbourne","Gold Coast Suns"],
      ["Western Bulldogs","Essendon"],
      ["Hawthorn","Geelong"]
    ],
    6: [ // Round 5
      ["Adelaide","Carlton"],
      ["Collingwood","Fremantle"],
      ["North Melbourne","Brisbane Lions"],
      ["Essendon","Melbourne"],
      ["Sydney Swans","Gold Coast Suns"],
      ["Hawthorn","Western Bulldogs"],
      ["Geelong","West Coast"],
      ["GWS Giants","Richmond"],
      ["Port Adelaide","St Kilda"]
    ],
    7: [ // Round 6
      ["Carlton","Collingwood"],
      ["Geelong","Western Bulldogs"],
      ["Sydney Swans","GWS Giants"],
      ["Gold Coast Suns","Essendon"],
      ["Hawthorn","Port Adelaide"],
      ["Adelaide","St Kilda"],
      ["North Melbourne","Richmond"],
      ["Melbourne","Brisbane Lions"],
      ["West Coast","Fremantle"]
    ],
    8: [ // Round 7
      ["Western Bulldogs","Sydney Swans"],
      ["Richmond","Melbourne"],
      ["Hawthorn","Gold Coast Suns"],
      ["Essendon","Collingwood"],
      ["Port Adelaide","Geelong"],
      ["Fremantle","Carlton"],
      ["St Kilda","West Coast"],
      ["Brisbane Lions","Adelaide"],
      ["GWS Giants","North Melbourne"]
    ],
    9: [ // Round 8
      ["Collingwood","Hawthorn"],
      ["Western Bulldogs","Fremantle"],
      ["Adelaide","Port Adelaide"],
      ["Essendon","Brisbane Lions"],
      ["West Coast","Richmond"],
      ["Geelong","North Melbourne"],
      ["Carlton","St Kilda"],
      ["Sydney Swans","Melbourne"],
      ["Gold Coast Suns","GWS Giants"]
    ],
    10: [ // Round 9
      ["Fremantle","Hawthorn"],
      ["Brisbane Lions","Carlton"],
      ["Port Adelaide","Western Bulldogs"],
      ["North Melbourne","Sydney Swans"],
      ["GWS Giants","Essendon"],
      ["Gold Coast Suns","St Kilda"],
      ["Geelong","Collingwood"],
      ["Melbourne","West Coast"],
      ["Richmond","Adelaide"]
    ]
  }};
}

async function loadState() {
  try {
    const result = await pool.query("SELECT state FROM gamestate WHERE id = 1");
    console.log("DB rows:", result.rows.length);
    if (result.rows.length > 0) {
      const saved = result.rows[0].state;
      console.log("State type:", typeof saved, "Keys:", saved ? Object.keys(saved).join(",") : "null");
      if (saved && saved.players && saved.ladder) {
        if (!saved.fixtures) saved.fixtures = makeInitialState().fixtures;
        return saved;
      }
    }
  } catch (e) {
    console.error("Error loading state:", e);
  }
  console.log("Seeding fresh state...");
  const fresh = makeInitialState();
  await saveState(fresh);
  return fresh;
}

async function saveState(state) {
  try {
    state.lastUpdated = Date.now();
    await pool.query(`
      INSERT INTO gamestate (id, state, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = NOW()
    `, [JSON.stringify(state)]);
  } catch (e) {
    console.error("Error saving state:", e);
  }
}

// ── GAME LOGIC ────────────────────────────────────────────────

function getPrice(teamName, ladder) {
  const pos = ladder.findIndex(t => t.name === teamName);
  return PRICE_SCALE[pos + 1] || PRICE_SCALE[18];
}

function getTotal(player, ladder) {
  const stockVal = player.holdings.reduce((s, h) => s + h.shares * getPrice(h.team, ladder), 0);
  return player.cash + stockVal;
}

function getBrokerageFee(player, ladder) {
  const total = getTotal(player, ladder);
  return total * 0.005 * Math.pow(2, player.tradesThisRound);
}

function canSellHolding(holding, round) {
  const minHold = holding.buyRound === 0 ? PRESEASON_HOLD : MIN_HOLD;
  return (round - holding.buyRound) >= minHold;
}

function applyInterestAndTax(players, ladder) {
  ALL_PLAYERS.forEach(name => {
    const p = players[name];
    p.holdings.forEach(h => {
      const pos = ladder.findIndex(t => t.name === h.team) + 1;
      if (pos >= 1 && pos <= 4) {
        const consec = (p.consecutiveTop4[h.team] || 0) + 1;
        p.consecutiveTop4[h.team] = consec;
        h.shares *= (1 + (INTEREST_RATES[pos] || 0));
      } else {
        p.consecutiveTop4[h.team] = 0;
      }
      if (pos === 18) h.shares *= (1 - BOTTOM_TAX);
    });
  });
}

async function runAIPreseason() {
  const gs = await loadState();
  const ladder = gs.ladder;

  const ladderSummary = ladder.map((t, i) =>
    `${i+1}. ${t.name} - price $${PRICE_SCALE[i+1]}`
  ).join("\n");

  const upcomingFixtures = (gs.fixtures && gs.fixtures[1])
    ? gs.fixtures[1].map(m => `${m[0]} vs ${m[1]}`).join("\n")
    : "Fixtures not available";

  const prompt = `You are managing 7 AI players in a fantasy AFL sharemarket game called Sportfolio for the 2026 season.

GAME RULES:
- Each player starts with $10,000 cash
- Share prices based on pre-season ladder position: 1st=$6.12 down to 18th=$1.00
- Max 25% of portfolio in any single team
- Must invest at least 50% of portfolio (max $5,000 cash remaining)
- 2-round minimum hold before selling
- Brokerage: 0.5% of portfolio per trade, doubles each trade

PRE-SEASON LADDER (based on 2026 premiership odds):
${ladderSummary}

OPENING ROUND FIXTURES:
${upcomingFixtures}

YOUR TASK:
1. Use web search to research 2026 AFL season previews, team strength, and Opening Round predictions
2. Each AI player must invest at least 50% of their $10,000 (so max $5,000 remaining in cash)
3. They can make up to 3 buy trades (brokerage doubles each trade so be selective)
4. Spread investments intelligently based on your research — not all players should buy the same teams

Respond ONLY with valid JSON (no markdown):
{
  "research": "2-3 sentence summary of your findings",
  "players": {
    "Alex": {
      "reasoning": "1-2 sentences",
      "trades": [
        {"type": "buy", "team": "Team Name", "amount": 2500}
      ]
    },
    "Jordan": { "reasoning": "...", "trades": [] },
    "Casey": { "reasoning": "...", "trades": [] },
    "Riley": { "reasoning": "...", "trades": [] },
    "Morgan": { "reasoning": "...", "trades": [] },
    "Quinn": { "reasoning": "...", "trades": [] },
    "Blake": { "reasoning": "...", "trades": [] }
  }
}`;

  let aiDecisions = null;
  let researchSummary = "AI pre-season research unavailable.";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await response.json();
    console.log("AI API response status:", response.status);
    console.log("AI API content blocks:", data.content && data.content.map(b => b.type).join(","));
    const textBlock = data.content && data.content.find(b => b.type === "text");
    if (textBlock) {
      console.log("AI text response (first 200 chars):", textBlock.text.slice(0, 200));
      const clean = textBlock.text.replace(/```json|```/g, "").trim();
      aiDecisions = JSON.parse(clean);
      researchSummary = aiDecisions.research || researchSummary;
    } else {
      console.log("No text block found in response:", JSON.stringify(data).slice(0, 300));
    }
  } catch(e) {
    console.error("AI preseason research failed:", e.message);
  }

  // Apply trades
  AI_PLAYERS.forEach(name => {
    const player = gs.players[name];
    player.tradesThisRound = 0;

    let trades = [];
    if (aiDecisions && aiDecisions.players && aiDecisions.players[name]) {
      trades = aiDecisions.players[name].trades || [];
      player.aiReasoning = aiDecisions.players[name].reasoning || "";
    } else {
      // Fallback: buy top 2 teams with $2500 each
      trades = [
        { type:"buy", team: ladder[0].name, amount: 2500 },
        { type:"buy", team: ladder[1].name, amount: 2500 }
      ];
      player.aiReasoning = "Fallback: invested in top 2 pre-season favourites.";
    }

    trades.forEach(trade => {
      if (player.tradesThisRound >= 3) return;
      if (trade.type !== "buy") return;
      const price = getPrice(trade.team, ladder);
      if (!price) return;
      const fee = getBrokerageFee(player, ladder);
      const maxInvest = getTotal(player, ladder) * PORTFOLIO_CAP;
      const existing = player.holdings.find(h => h.team === trade.team);
      const existingVal = existing ? existing.shares * price : 0;
      const available = Math.min(trade.amount, player.cash - fee, maxInvest - existingVal);
      if (available < 50 || player.cash < fee + available) return;
      const shares = available / price;
      player.cash -= (available + fee);
      if (existing) {
        const tot = existing.shares + shares;
        existing.buyPrice = (existing.shares * existing.buyPrice + shares * price) / tot;
        existing.shares = tot;
      } else {
        player.holdings.push({ team: trade.team, shares, buyPrice: price, buyRound: 0 });
      }
      player.tradesThisRound++;
      player.tradeLog.push({ type:"buy", team: trade.team, value: shares*price, fee, round: 0 });
    });

    player.tradesThisRound = 0; // Reset after pre-season
  });

  // Store research log
  gs.aiResearchLog = gs.aiResearchLog || [];
  gs.aiResearchLog.push({
    round: 0,
    research: researchSummary,
    reasoning: AI_PLAYERS.reduce((acc, name) => {
      acc[name] = gs.players[name].aiReasoning || "";
      return acc;
    }, {})
  });

  await saveState(gs);
  console.log("AI pre-season trades complete");
}

async function runAITrades(players, ladder, round, fixtures) {
  // Build context for Claude
  const roundLabel = round === 1 ? "Opening Round" : `Round ${round - 1}`;
  const nextRoundLabel = round === 1 ? "Round 1" : `Round ${round}`;

  const ladderSummary = ladder.map((t, i) => `${i+1}. ${t.name} (${t.wins}W-${t.losses}L, ${t.pct.toFixed(1)}%) price=$${PRICE_SCALE[i+1]}`).join("\n");

  const upcomingFixtures = (fixtures && fixtures[round]) 
    ? fixtures[round].map(m => `${m[0]} vs ${m[1]}`).join("\n")
    : "Fixtures not available";

  const playerSummaries = AI_PLAYERS.map(name => {
    const p = players[name];
    const total = getTotal(p, ladder);
    const holdings = p.holdings.map(h => {
      const pos = ladder.findIndex(t => t.name === h.team) + 1;
      const canSell = canSellHolding(h, round);
      return `  ${h.team} (pos ${pos}, bought R${h.buyRound}, value=$${(h.shares * getPrice(h.team, ladder)).toFixed(0)}, canSell=${canSell})`;
    }).join("\n") || "  No holdings";
    return `${name}: cash=$${p.cash.toFixed(0)}, total=$${total.toFixed(0)}, tradesThisRound=0\nHoldings:\n${holdings}`;
  }).join("\n\n");

  const prompt = `You are managing 7 AI players in a fantasy AFL sharemarket game called Sportfolio. The season is AFL 2026.

GAME RULES:
- Each player starts with $10,000
- Share prices based on ladder position: 1st=$6.12 down to 18th=$1.00
- Max 25% of portfolio in any single team
- 2-round minimum hold before selling
- Brokerage fee: 0.5% of portfolio, doubles each trade this round
- Interest paid on top 4 holdings, tax on 18th place

CURRENT STATE (after ${roundLabel}):
LADDER:
${ladderSummary}

UPCOMING FIXTURES (${nextRoundLabel}):
${upcomingFixtures}

AI PLAYERS:
${playerSummaries}

YOUR TASK:
1. Use web search to research AFL 2026 ${nextRoundLabel} predictions and win probabilities
2. Consider each team's upcoming fixture difficulty, current form, and ladder trajectory
3. Decide trades for each AI player — they should make smart, informed decisions based on your research
4. Each player can make up to 3 trades (buy or sell) but brokerage doubles each trade so be selective
5. Only suggest sells for holdings where canSell=true

Respond ONLY with a valid JSON object in this exact format (no markdown, no explanation outside JSON):
{
  "research": "2-3 sentence summary of what you found about upcoming round predictions",
  "players": {
    "Alex": {
      "reasoning": "1-2 sentences explaining their decision",
      "trades": [
        {"type": "buy", "team": "Team Name", "amount": 1500},
        {"type": "sell", "team": "Team Name"}
      ]
    },
    "Jordan": { "reasoning": "...", "trades": [] },
    "Casey": { "reasoning": "...", "trades": [] },
    "Riley": { "reasoning": "...", "trades": [] },
    "Morgan": { "reasoning": "...", "trades": [] },
    "Quinn": { "reasoning": "...", "trades": [] },
    "Blake": { "reasoning": "...", "trades": [] }
  }
}`;

  let aiDecisions = null;
  let researchLog = "AI research unavailable — using fallback logic.";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    const textBlock = data.content && data.content.find(b => b.type === "text");
    if (textBlock) {
      const clean = textBlock.text.replace(/```json|```/g, "").trim();
      aiDecisions = JSON.parse(clean);
      researchLog = aiDecisions.research || researchLog;
    }
  } catch (e) {
    console.error("AI research failed:", e.message);
  }

  // Apply trades for each AI player
  AI_PLAYERS.forEach(name => {
    const player = players[name];
    player.tradesThisRound = 0;

    let trades = [];
    if (aiDecisions && aiDecisions.players && aiDecisions.players[name]) {
      trades = aiDecisions.players[name].trades || [];
      player.aiReasoning = aiDecisions.players[name].reasoning || "";
    } else {
      // Fallback: simple logic if API failed
      const total = getTotal(player, ladder);
      if (player.holdings.length === 0 && player.cash > 1000) {
        trades = [{ type:"buy", team:ladder[0].name, amount:Math.min(player.cash*0.4, total*PORTFOLIO_CAP) }];
      }
      player.aiReasoning = "Used fallback logic (research unavailable).";
    }

    trades.forEach(trade => {
      if (player.tradesThisRound >= 3) return;
      const fee = getBrokerageFee(player, ladder);
      if (trade.type === "buy") {
        const price = getPrice(trade.team, ladder);
        if (!price) return;
        const maxInvest = getTotal(player, ladder) * PORTFOLIO_CAP;
        const existingTranches = player.holdings.filter(h => h.team === trade.team);
        const existingVal = existingTranches.reduce((s,h) => s + h.shares * price, 0);
        const available = Math.min(trade.amount, player.cash - fee, maxInvest - existingVal);
        if (available < 50 || player.cash < fee + available) return;
        const shares = available / price;
        player.cash -= (available + fee);
        // Always push new tranche
        player.holdings.push({ team: trade.team, shares, buyPrice: price, buyRound: round });
        player.tradesThisRound++;
        player.tradeLog.push({ type:"buy", team:trade.team, value:shares*price, fee, round });
      } else if (trade.type === "sell") {
        const eligibleTranches = player.holdings.filter(hh => hh.team === trade.team && canSellHolding(hh, round));
        if (!eligibleTranches.length) return;
        const price = getPrice(trade.team, ladder);
        const totalEligible = eligibleTranches.reduce((s,h) => s+h.shares, 0);
        // Sell all eligible tranches
        let sellVal = 0;
        eligibleTranches.forEach(h => { sellVal += h.shares * price; h.shares = 0; });
        player.holdings = player.holdings.filter(hh => hh.shares > 0);
        player.cash += sellVal - fee;
        player.tradesThisRound++;
        player.tradeLog.push({ type:"sell", team:trade.team, value:sellVal, fee, round });
      }
    });
  });

  return researchLog;
}

// ── AI HEADLINE GENERATION ────────────────────────────────────

async function generateAIHeadlines(gs) {
  const ladder = gs.ladder;
  const compareLadder = gs.snapshotLadder || gs.prevLadder;

  // Build price movement summary
  const movementSummary = ladder.map((t, i) => {
    const pos = i + 1;
    const price = PRICE_SCALE[pos];
    if (!compareLadder) return `${t.name}: $${price.toFixed(2)} (pos ${pos})`;
    const prevPos = compareLadder.findIndex(p => p.name === t.name);
    const prevPrice = PRICE_SCALE[prevPos + 1] || PRICE_SCALE[18];
    const chg = price - prevPrice;
    const chgStr = chg > 0.005 ? `▲$${chg.toFixed(2)}` : chg < -0.005 ? `▼$${Math.abs(chg).toFixed(2)}` : `=`;
    return `${t.name}: pos ${pos}, $${price.toFixed(2)} (${chgStr})`;
  }).join("\n");

  const prompt = `You are a witty financial market commentator covering the AFL Sportfolio sharemarket game. Write exactly 5 punchy, fun "market headlines" about the current AFL ladder and share price movements. Use AFL vernacular mixed with stockmarket language. Be creative, irreverent, and entertaining — think Bloomberg meets AFL Record.

CURRENT LADDER & PRICE MOVEMENTS:
${movementSummary}

Rules:
- Each headline should be 8-15 words max — tight and punchy
- Mix serious financial tone with AFL humour
- Reference specific teams and price moves where relevant
- Vary the style: some alarming, some triumphant, some sardonic
- NO quotation marks around the headlines

Respond ONLY with a JSON array of exactly 5 strings, no markdown:
["Headline 1","Headline 2","Headline 3","Headline 4","Headline 5"]`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await response.json();
    const textBlock = data.content && data.content.find(b => b.type === "text");
    if (textBlock) {
      const clean = textBlock.text.replace(/```json|```/g, "").trim();
      const items = JSON.parse(clean);
      if (Array.isArray(items) && items.length) {
        console.log("AI headlines generated:", items.length);
        return { items, generatedAt: new Date().toISOString() };
      }
    }
  } catch(e) {
    console.error("Headline generation failed:", e.message);
  }

  // Fallback headlines
  return {
    items: [
      "Markets open — position your portfolio before the siren",
      "Ladder volatility at season high as mid-table logjam tightens",
      "Top-4 interest payments flowing — are your shares in the right hands?",
      "Brokerage costs biting traders who overextended this round",
      "Hold period clock ticking — plan your exits carefully"
    ],
    generatedAt: new Date().toISOString()
  };
}

// Check if headlines need daily refresh (called on each Squiggle poll cycle too)
async function maybeRefreshHeadlines(gs) {
  const headlines = gs.headlines;
  if (!headlines || !headlines.generatedAt) return true; // needs generation
  const age = Date.now() - new Date(headlines.generatedAt).getTime();
  return age > 24 * 60 * 60 * 1000; // older than 24 hours
}

// ── API ROUTES ────────────────────────────────────────────────

// Get full game state
app.get("/api/state", async (req, res) => {
  res.json(await loadState());
});

// Buy shares
app.post("/api/buy", async (req, res) => {
  const { playerName, teamName, amount } = req.body;
  if (!HUMAN_PLAYERS.includes(playerName)) return res.status(403).json({ error: "Not a human player" });
  const gs = await loadState();
  if (gs.round >= TOTAL_ROUNDS) return res.status(400).json({ error: "Season complete" });
  if (gs.tradeDeadline && Date.now() > new Date(gs.tradeDeadline).getTime())
    return res.status(400).json({ error: "Trade window closed — round has started." });

  const player = gs.players[playerName];
  const price = getPrice(teamName, gs.ladder);
  const fee = getBrokerageFee(player, gs.ladder);
  const shares = Math.floor(parseFloat(amount) / price);
  const cost = shares * price;

  if (shares <= 0) return res.status(400).json({ error: "Amount too small" });
  if (cost + fee > player.cash) return res.status(400).json({ error: "Insufficient cash" });

  const total = getTotal(player, gs.ladder);
  const maxInvest = total * PORTFOLIO_CAP;
  const existingTranches = player.holdings.filter(h => h.team === teamName);
  const existingVal = existingTranches.reduce((s, h) => s + h.shares * price, 0);
  if (existingVal + cost > maxInvest)
    return res.status(400).json({ error: `25% cap exceeded. Max ${Math.floor(maxInvest - existingVal)} more in this team.` });

  const tradeId = Date.now() + "_" + Math.random().toString(36).slice(2,7);
  const wasNewHolding = existingTranches.length === 0;
  const cashBefore = player.cash; // snapshot cash before deducting
  player.cash -= (cost + fee);
  player.tradesThisRound++;
  // Always store as a new tranche to preserve individual buyRound for hold period enforcement
  player.holdings.push({ team: teamName, shares, buyPrice: price, buyRound: gs.round });
  player.tradeLog.push({ id:tradeId, type:"buy", team:teamName, value:cost, fee, round:gs.round, shares, price, wasNewHolding, cashBefore });

  await saveState(gs);
  res.json({ success: true, shares, cost, fee, state: gs });
});

// Sell shares
app.post("/api/sell", async (req, res) => {
  const { playerName, teamName, shares } = req.body;
  if (!HUMAN_PLAYERS.includes(playerName)) return res.status(403).json({ error: "Not a human player" });
  const gs = await loadState();
  if (gs.round >= TOTAL_ROUNDS) return res.status(400).json({ error: "Season complete" });
  if (gs.tradeDeadline && Date.now() > new Date(gs.tradeDeadline).getTime())
    return res.status(400).json({ error: "Trade window closed — round has started." });

  const player = gs.players[playerName];
  const tranches = player.holdings.filter(hh => hh.team === teamName);
  if (tranches.length === 0) return res.status(400).json({ error: "No holding found" });

  // Only tranches that have met the hold period can be sold
  const eligibleTranches = tranches.filter(h => canSellHolding(h, gs.round));
  const eligibleShares = eligibleTranches.reduce((s, h) => s + h.shares, 0);
  if (eligibleShares <= 0) {
    const roundsNeeded = Math.min(...tranches.map(h => (h.buyRound === 0 ? PRESEASON_HOLD : MIN_HOLD) - (gs.round - h.buyRound)));
    return res.status(400).json({ error: `Hold period not met. ${Math.max(1, roundsNeeded)} more round(s) required.` });
  }

  const tradeId = Date.now() + "_" + Math.random().toString(36).slice(2,7);
  const requestedShares = parseFloat(shares);
  const sellShares = Math.min(requestedShares, eligibleShares);
  const price = getPrice(teamName, gs.ladder);
  const fee = getBrokerageFee(player, gs.ladder);
  const net = sellShares * price - fee;

  // Deduct shares from eligible tranches FIFO (oldest first)
  let remaining = sellShares;
  const sortedEligible = [...eligibleTranches].sort((a, b) => a.buyRound - b.buyRound);
  for (const tranche of sortedEligible) {
    if (remaining <= 0) break;
    const deduct = Math.min(remaining, tranche.shares);
    tranche.shares -= deduct;
    remaining -= deduct;
  }

  // Remove empty tranches and handle dust
  player.holdings = player.holdings.filter(hh => {
    if (hh.team !== teamName) return true;
    if (hh.shares <= 0) return false;
    // Clean up dusty tranche
    if (hh.shares * price < price) {
      player.cash += hh.shares * price;
      return false;
    }
    return true;
  });

  const prevBuyPrice = sortedEligible[0]?.buyPrice || 0;
  const prevBuyRound = sortedEligible[0]?.buyRound || 0;

  const cashBefore = player.cash; // snapshot cash before adding proceeds
  player.cash += net;
  player.tradesThisRound++;
  player.tradeLog.push({ id:tradeId, type:"sell", team:teamName, value:sellShares*price, fee, round:gs.round, shares:sellShares, price, prevBuyPrice, prevBuyRound, cashBefore });

  await saveState(gs);
  res.json({ success: true, net, fee, state: gs });
});

// Undo a trade (current round only)
app.post("/api/undo", async (req, res) => {
  const { playerName, tradeId } = req.body;
  if (!HUMAN_PLAYERS.includes(playerName)) return res.status(403).json({ error: "Not a human player" });
  const gs = await loadState();
  const player = gs.players[playerName];

  const tradeIdx = player.tradeLog.findIndex(t => t.id === tradeId);
  if (tradeIdx === -1) return res.status(400).json({ error: "Trade not found" });
  const trade = player.tradeLog[tradeIdx];
  if (trade.round !== gs.round) return res.status(400).json({ error: "Can only undo trades from the current round" });

  if (trade.type === "buy") {
    // Reverse a buy: remove shares, restore cash to pre-trade snapshot
    const h = player.holdings.find(hh => hh.team === trade.team);
    if (!h) return res.status(400).json({ error: "Holding not found" });
    if (trade.wasNewHolding) {
      player.holdings = player.holdings.filter(hh => hh.team !== trade.team);
    } else {
      h.shares -= trade.shares;
      if (h.shares <= 0) player.holdings = player.holdings.filter(hh => hh.team !== trade.team);
    }
    player.cash = trade.cashBefore !== undefined ? trade.cashBefore : player.cash + (trade.value + trade.fee);
  } else if (trade.type === "sell") {
    // Reverse a sell: return shares, restore cash to pre-trade snapshot
    player.cash = trade.cashBefore !== undefined ? trade.cashBefore : player.cash - (trade.value + trade.fee);
    const h = player.holdings.find(hh => hh.team === trade.team);
    if (h) {
      const tot = h.shares + trade.shares;
      h.buyPrice = (h.shares * h.buyPrice + trade.shares * trade.prevBuyPrice) / tot;
      h.shares = tot;
    } else {
      player.holdings.push({ team: trade.team, shares: trade.shares, buyPrice: trade.prevBuyPrice, buyRound: trade.prevBuyRound });
    }
  }

  player.tradesThisRound = Math.max(0, player.tradesThisRound - 1);
  player.tradeLog.splice(tradeIdx, 1);

  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: update ladder
app.post("/api/admin/ladder", async (req, res) => {
  const { playerName, updates } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  gs.prevLadder = JSON.parse(JSON.stringify(gs.ladder));

  updates.forEach(u => {
    const team = gs.ladder.find(t => t.name === u.name);
    if (team) {
      team.wins = parseInt(u.wins) || 0;
      team.losses = parseInt(u.losses) || 0;
      team.draws = parseInt(u.draws) || 0;
      team.pct = parseFloat(u.pct) || 100;
      team.pts = team.wins * 4 + team.draws * 2;
    }
  });

  gs.ladder.sort((a, b) => b.pts !== a.pts ? b.pts - a.pts : b.pct - a.pct);
  gs.ladder.forEach((t, i) => t.pos = i + 1);
  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: advance round
app.post("/api/admin/advance", async (req, res) => {
  const { playerName } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  if (gs.round >= TOTAL_ROUNDS) return res.status(400).json({ error: "Season complete" });

  // Save full state snapshot before advancing so we can go back if needed
  gs.previousState = JSON.parse(JSON.stringify(gs));
  delete gs.previousState.previousState; // Don't nest snapshots

  // Snapshot each player's portfolio total at end of this round for Weekly Winner tracking
  ALL_PLAYERS.forEach(name => {
    const p = gs.players[name];
    if (!p.roundHistory) p.roundHistory = {};
    const holdingsValue = (p.holdings || []).reduce((sum, h) => {
      const pos = gs.ladder.findIndex(t => t.name === h.team);
      const price = PRICE_SCALE[pos + 1] || PRICE_SCALE[18];
      return sum + price * h.shares;
    }, 0);
    p.roundHistory[gs.round] = Math.round((p.cash + holdingsValue) * 100) / 100;
  });

  applyInterestAndTax(gs.players, gs.ladder);
  gs.prevLadder = JSON.parse(JSON.stringify(gs.ladder));
  gs.round += 1;

  // Run AI trades with research
  const researchLog = await runAITrades(gs.players, gs.ladder, gs.round, gs.fixtures);
  gs.aiResearchLog = gs.aiResearchLog || [];
  gs.aiResearchLog.push({
    round: gs.round,
    research: researchLog,
    reasoning: AI_PLAYERS.reduce((acc, name) => {
      acc[name] = gs.players[name].aiReasoning || "";
      return acc;
    }, {})
  });

  ALL_PLAYERS.forEach(n => gs.players[n].tradesThisRound = 0);

  // Save snapshot of all players at round start
  gs.snapshot = {};
  ALL_PLAYERS.forEach(n => {
    gs.snapshot[n] = {
      cash: gs.players[n].cash,
      holdings: JSON.parse(JSON.stringify(gs.players[n].holdings)),
      total: getTotal(gs.players[n], gs.ladder)
    };
  });

  // Append to history for the round-by-round chart
  gs.history = gs.history || [];
  gs.history.push({
    round: gs.round,
    totals: ALL_PLAYERS.reduce((acc, n) => {
      acc[n] = gs.snapshot[n].total;
      return acc;
    }, {})
  });

  // Save ladder snapshot at round start — used for "change since round started" column
  gs.snapshotLadder = JSON.parse(JSON.stringify(gs.ladder));

  gs.tradeDeadline = null;
  gs.status = "trading";

  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: go back one round
app.post("/api/admin/back", async (req, res) => {
  const { playerName } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  if (!gs.previousState) return res.status(400).json({ error: "No previous state to restore." });
  await saveState(gs.previousState);
  res.json({ success: true, state: gs.previousState });
});

// Admin: decrement round by 1 without touching portfolios (emergency fix)
app.post("/api/admin/decrement-round", async (req, res) => {
  const { playerName } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  if (gs.round <= 0) return res.status(400).json({ error: "Already at round 0" });
  gs.round -= 1;
  gs.status = "trading";
  gs.tradeDeadline = null;
  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: set trade deadline
app.post("/api/admin/deadline", async (req, res) => {
  const { playerName, deadline } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  gs.tradeDeadline = deadline; // ISO datetime string
  gs.status = "trading";
  await saveState(gs);
  // Start Squiggle polling if deadline is within 1 hour or already passed
  const dl = new Date(deadline).getTime();
  if (dl - Date.now() < 60 * 60 * 1000) {
    startSquigglePolling();
  }
  res.json({ success: true, state: gs });
});

// Admin: manually trigger a Squiggle ladder fetch right now
app.post("/api/admin/fetch-ladder", async (req, res) => {
  const { playerName } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  const aflRound = sportfolioRoundToAFLRound(gs.round);
  const newLadder = await fetchSquiggleLadder(aflRound);
  if (!newLadder) return res.status(502).json({ error: "Squiggle fetch failed — check server logs." });
  gs.prevLadder = JSON.parse(JSON.stringify(gs.ladder));
  gs.ladder = newLadder;
  gs.liveUpdatedAt = new Date().toISOString();
  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Public: get live update timestamp (so frontend knows when to refresh)
app.get("/api/live-status", async (req, res) => {
  const gs = await loadState();
  const deadline = gs.tradeDeadline ? new Date(gs.tradeDeadline).getTime() : null;
  const isLocked = deadline && Date.now() > deadline;
  res.json({
    round: gs.round,
    isLocked,
    liveUpdatedAt: gs.liveUpdatedAt || null,
    pollingActive: !!squigglePoller,
  });
});

// Admin: download backup
app.get("/api/admin/backup", async (req, res) => {
  if (req.query.playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  const filename = `sportfolio-backup-round${gs.round}-${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(gs, null, 2));
});

// Admin: restore from backup
app.post("/api/admin/restore", async (req, res) => {
  const { playerName, state } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  if (!state || !state.players || !state.ladder) return res.status(400).json({ error: "Invalid backup file" });
  await saveState(state);
  res.json({ success: true, state });
});

// Admin: trigger AI pre-season trades manually
app.post("/api/admin/ai-preseason", async (req, res) => {
  const { playerName } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  await runAIPreseason();
  const gs = await loadState();
  res.json({ success: true, state: gs });
});

// Admin: get AI research log
app.get("/api/admin/research", async (req, res) => {
  const gs = await loadState();
  res.json({ log: gs.aiResearchLog || [] });
});

// Admin: save fixtures
app.post("/api/admin/fixtures", async (req, res) => {
  const { playerName, fixtures } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  gs.fixtures = fixtures;
  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: generate AI headlines
app.post("/api/admin/generate-headlines", async (req, res) => {
  const { playerName } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = await loadState();
  const headlines = await generateAIHeadlines(gs);
  gs.headlines = headlines;
  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: manually save/edit headlines
app.post("/api/admin/headlines", async (req, res) => {
  const { playerName, items } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  const gs = await loadState();
  gs.headlines = gs.headlines || {};
  gs.headlines.items = items.filter(h => h && h.trim());
  gs.headlines.manualSavedAt = new Date().toISOString();
  await saveState(gs);
  res.json({ success: true, state: gs });
});

// Reset (admin only - emergency use)
app.post("/api/admin/reset", async (req, res) => {
  const { playerName, confirm } = req.body;
  if (playerName !== "Tyson" || confirm !== "RESET") return res.status(403).json({ error: "Forbidden" });
  const fresh = makeInitialState();
  await saveState(fresh);
  res.json({ success: true, state: fresh });
});

// Serve frontend for all other routes
app.use(function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb().then(async () => {
  app.listen(PORT, "0.0.0.0", function() {
    console.log("Sportfolio AFL 2026 running on port " + PORT);
  });
  // Resume Squiggle polling if we're already in a lockout period
  try {
    const gs = await loadState();
    const deadline = gs.tradeDeadline ? new Date(gs.tradeDeadline).getTime() : null;
    const isLocked = deadline && Date.now() > deadline;
    if (isLocked && gs.round < TOTAL_ROUNDS) {
      console.log("Resuming Squiggle polling (lockout already active)");
      startSquigglePolling();
    }
  } catch(e) {
    console.error("Failed to check polling state:", e.message);
  }
}).catch(err => {
  console.error("Failed to initialise database:", err);
  process.exit(1);
});
