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
    const initial = makeInitialState();
    await pool.query(
      `INSERT INTO gamestate (id, state, updated_at) VALUES (1, $1, NOW())`,
      [JSON.stringify(initial)]
    );
    console.log("Initial game state seeded into database");
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
      headers: { "Content-Type": "application/json" },
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
          player.holdings.push({ team: trade.team, shares, buyPrice: price, buyRound: round });
        }
        player.tradesThisRound++;
        player.tradeLog.push({ type:"buy", team:trade.team, value:shares*price, fee, round });
      } else if (trade.type === "sell") {
        const h = player.holdings.find(hh => hh.team === trade.team);
        if (!h || !canSellHolding(h, round)) return;
        const price = getPrice(h.team, ladder);
        player.cash += h.shares * price - fee;
        player.holdings = player.holdings.filter(hh => hh.team !== trade.team);
        player.tradesThisRound++;
        player.tradeLog.push({ type:"sell", team:h.team, value:h.shares*price, fee, round });
      }
    });
  });

  return researchLog;
}

// ── API ROUTES ────────────────────────────────────────────────

// Get full game state
app.get("/api/state", async (req, res) => {
  res.json(loadState());
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
  const existing = player.holdings.find(h => h.team === teamName);
  const existingVal = existing ? existing.shares * price : 0;
  if (existingVal + cost > maxInvest)
    return res.status(400).json({ error: `25% cap exceeded. Max ${Math.floor(maxInvest - existingVal)} more in this team.` });

  const tradeId = Date.now() + "_" + Math.random().toString(36).slice(2,7);
  const wasNewHolding = !existing;
  player.cash -= (cost + fee);
  player.tradesThisRound++;
  if (existing) {
    const tot = existing.shares + shares;
    existing.buyPrice = (existing.shares * existing.buyPrice + shares * price) / tot;
    existing.shares = tot;
  } else {
    player.holdings.push({ team: teamName, shares, buyPrice: price, buyRound: gs.round });
  }
  player.tradeLog.push({ id:tradeId, type:"buy", team:teamName, value:cost, fee, round:gs.round, shares, price, wasNewHolding });

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
  const h = player.holdings.find(hh => hh.team === teamName);
  if (!h) return res.status(400).json({ error: "No holding found" });
  if (!canSellHolding(h, gs.round))
    return res.status(400).json({ error: `Hold period not met. ${(h.buyRound === 0 ? PRESEASON_HOLD : MIN_HOLD) - (gs.round - h.buyRound)} more round(s) required.` });

  const tradeId = Date.now() + "_" + Math.random().toString(36).slice(2,7);
  const sellShares = Math.min(parseFloat(shares), h.shares);
  const price = getPrice(teamName, gs.ladder);
  const fee = getBrokerageFee(player, gs.ladder);
  const net = sellShares * price - fee;
  const prevBuyPrice = h.buyPrice;
  const prevBuyRound = h.buyRound;

  player.cash += net;
  player.tradesThisRound++;
  if (sellShares >= h.shares) {
    player.holdings = player.holdings.filter(hh => hh.team !== teamName);
  } else {
    h.shares -= sellShares;
  }
  player.tradeLog.push({ id:tradeId, type:"sell", team:teamName, value:sellShares*price, fee, round:gs.round, shares:sellShares, price, prevBuyPrice, prevBuyRound });

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
    // Reverse a buy: remove shares, refund cash + fee
    const h = player.holdings.find(hh => hh.team === trade.team);
    if (!h) return res.status(400).json({ error: "Holding not found" });
    if (trade.wasNewHolding) {
      player.holdings = player.holdings.filter(hh => hh.team !== trade.team);
    } else {
      h.shares -= trade.shares;
      if (h.shares <= 0) player.holdings = player.holdings.filter(hh => hh.team !== trade.team);
    }
    player.cash += (trade.value + trade.fee);
  } else if (trade.type === "sell") {
    // Reverse a sell: return shares, deduct cash + fee
    player.cash -= (trade.value + trade.fee);
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

  gs.tradeDeadline = null;
  gs.status = "trading";

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
  res.json({ success: true, state: gs });
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

initDb().then(() => {
  app.listen(PORT, "0.0.0.0", function() {
    console.log("Sportfolio AFL 2026 running on port " + PORT);
  });
}).catch(err => {
  console.error("Failed to initialise database:", err);
  process.exit(1);
});
