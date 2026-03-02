const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, "gamestate.json");

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
const PRESEASON_HOLD = 3;
const TOTAL_ROUNDS = 10;
const HUMAN_PLAYERS = ["Tyson", "Jas", "Sam"];
const AI_PLAYERS = ["Alex", "Jordan", "Casey", "Riley", "Morgan", "Quinn", "Blake"];
const ALL_PLAYERS = [...HUMAN_PLAYERS, ...AI_PLAYERS];
const AI_STRATEGIES = {
  Alex:"momentum", Jordan:"blueChip", Casey:"contrarian",
  Riley:"balanced", Morgan:"passive", Quinn:"momentum", Blake:"contrarian"
};

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

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      // Merge fixtures from initial state if missing
      if (!saved.fixtures) {
        saved.fixtures = makeInitialState().fixtures;
      }
      return saved;
    }
  } catch (e) {
    console.error("Error loading state:", e);
  }
  return makeInitialState();
}

function saveState(state) {
  try {
    state.lastUpdated = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

function runAITrades(players, ladder, round) {
  AI_PLAYERS.forEach(name => {
    const player = players[name];
    player.tradesThisRound = 0;
    const strategy = AI_STRATEGIES[name];
    const total = getTotal(player, ladder);
    const trades = [];

    if ((strategy === "blueChip" || strategy === "passive") && round === 1 && player.holdings.length === 0) {
      for (let i = 0; i < 4; i++) trades.push({ type:"buy", team:ladder[i].name, amount:2000 });
    } else if (strategy === "momentum" && round > 1) {
      const risers = ladder.filter((t,i) => i < 9 && !player.holdings.some(h=>h.team===t.name));
      if (risers.length > 0 && player.cash > 1000)
        trades.push({ type:"buy", team:risers[0].name, amount:Math.min(player.cash*0.6, total*PORTFOLIO_CAP) });
      player.holdings.filter(h => canSellHolding(h,round) && ladder.findIndex(t=>t.name===h.team) > 11)
        .forEach(h => trades.push({ type:"sell", team:h.team }));
    } else if (strategy === "contrarian" && round > 1) {
      const cheap = ladder.slice(9).filter(t => !player.holdings.some(h=>h.team===t.name));
      if (cheap.length > 0 && player.cash > 1000)
        trades.push({ type:"buy", team:cheap[0].name, amount:Math.min(player.cash*0.5, total*PORTFOLIO_CAP) });
    } else if (strategy === "balanced" && round % 3 === 0 && round > 0) {
      player.holdings.filter(h => canSellHolding(h,round) && ladder.findIndex(t=>t.name===h.team) > 13)
        .forEach(h => trades.push({ type:"sell", team:h.team }));
      if (player.cash > 1500) {
        const pick = ladder.slice(0,6).find(t=>!player.holdings.some(h=>h.team===t.name));
        if (pick) trades.push({ type:"buy", team:pick.name, amount:Math.min(player.cash*0.7, total*PORTFOLIO_CAP) });
      }
    }

    trades.forEach(trade => {
      if (player.tradesThisRound >= 3) return;
      const fee = getBrokerageFee(player, ladder);
      if (trade.type === "buy") {
        const price = getPrice(trade.team, ladder);
        const maxInvest = getTotal(player,ladder)*PORTFOLIO_CAP;
        const existing = player.holdings.find(h=>h.team===trade.team);
        const existingVal = existing ? existing.shares*price : 0;
        const available = Math.min(trade.amount, player.cash-fee, maxInvest-existingVal);
        if (available < 50 || player.cash < fee+available) return;
        const shares = available/price;
        player.cash -= (available+fee);
        if (existing) {
          const tot = existing.shares+shares;
          existing.buyPrice = (existing.shares*existing.buyPrice+shares*price)/tot;
          existing.shares = tot;
        } else {
          player.holdings.push({ team:trade.team, shares, buyPrice:price, buyRound:round });
        }
        player.tradesThisRound++;
        player.tradeLog.push({ type:"buy", team:trade.team, value:shares*price, fee, round });
      } else if (trade.type === "sell") {
        const h = player.holdings.find(hh=>hh.team===trade.team);
        if (!h || !canSellHolding(h,round)) return;
        const price = getPrice(h.team, ladder);
        player.cash += h.shares*price - fee;
        player.holdings = player.holdings.filter(hh=>hh.team!==trade.team);
        player.tradesThisRound++;
        player.tradeLog.push({ type:"sell", team:h.team, value:h.shares*price, fee, round });
      }
    });
  });
}

// ── API ROUTES ────────────────────────────────────────────────

// Get full game state
app.get("/api/state", (req, res) => {
  res.json(loadState());
});

// Buy shares
app.post("/api/buy", (req, res) => {
  const { playerName, teamName, amount } = req.body;
  if (!HUMAN_PLAYERS.includes(playerName)) return res.status(403).json({ error: "Not a human player" });
  const gs = loadState();
  if (gs.round >= TOTAL_ROUNDS) return res.status(400).json({ error: "Season complete" });
  if (gs.tradeDeadline && Date.now() > new Date(gs.tradeDeadline).getTime())
    return res.status(400).json({ error: "Trade window closed — round has started." });

  const player = gs.players[playerName];
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

  saveState(gs);
  res.json({ success: true, shares, cost, fee, state: gs });
});

// Sell shares
app.post("/api/sell", (req, res) => {
  const { playerName, teamName, shares } = req.body;
  if (!HUMAN_PLAYERS.includes(playerName)) return res.status(403).json({ error: "Not a human player" });
  const gs = loadState();
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

  saveState(gs);
  res.json({ success: true, net, fee, state: gs });
});

// Undo a trade (current round only)
app.post("/api/undo", (req, res) => {
  const { playerName, tradeId } = req.body;
  if (!HUMAN_PLAYERS.includes(playerName)) return res.status(403).json({ error: "Not a human player" });
  const gs = loadState();
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

  saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: update ladder
app.post("/api/admin/ladder", (req, res) => {
  const { playerName, updates } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = loadState();
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
  saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: advance round
app.post("/api/admin/advance", (req, res) => {
  const { playerName } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = loadState();
  if (gs.round >= TOTAL_ROUNDS) return res.status(400).json({ error: "Season complete" });

  applyInterestAndTax(gs.players, gs.ladder);
  runAITrades(gs.players, gs.ladder, gs.round + 1);
  ALL_PLAYERS.forEach(n => gs.players[n].tradesThisRound = 0);
  gs.prevLadder = JSON.parse(JSON.stringify(gs.ladder));
  gs.round += 1;

  // Save snapshot of all players at round start
  gs.snapshot = {};
  ALL_PLAYERS.forEach(n => {
    gs.snapshot[n] = {
      cash: gs.players[n].cash,
      holdings: JSON.parse(JSON.stringify(gs.players[n].holdings)),
      total: getTotal(gs.players[n], gs.ladder)
    };
  });

  // Clear deadline — new trading window is open, no deadline set yet
  gs.tradeDeadline = null;
  gs.status = "trading"; // "trading" or "lockout"

  saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: set trade deadline
app.post("/api/admin/deadline", (req, res) => {
  const { playerName, deadline } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = loadState();
  gs.tradeDeadline = deadline; // ISO datetime string
  gs.status = "trading";
  saveState(gs);
  res.json({ success: true, state: gs });
});

// Admin: save fixtures
app.post("/api/admin/fixtures", (req, res) => {
  const { playerName, fixtures } = req.body;
  if (playerName !== "Tyson") return res.status(403).json({ error: "Admin only" });
  const gs = loadState();
  gs.fixtures = fixtures;
  saveState(gs);
  res.json({ success: true, state: gs });
});

// Reset (admin only - emergency use)
app.post("/api/admin/reset", (req, res) => {
  const { playerName, confirm } = req.body;
  if (playerName !== "Tyson" || confirm !== "RESET") return res.status(403).json({ error: "Forbidden" });
  const fresh = makeInitialState();
  saveState(fresh);
  res.json({ success: true, state: fresh });
});

// Serve frontend for all other routes
app.use(function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", function() {
  console.log("Sportfolio AFL 2026 running on port " + PORT);
});
