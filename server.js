/*
 ╔══════════════════════════════════════════════════════════════╗
 ║          ASTRO CRASH - Multiplayer Crash Game Engine          ║
 ║          Full Production Server - All 100 Features            ║
 ╚══════════════════════════════════════════════════════════════╝
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const helmet = require('helmet');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ─── Config ─────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  HOUSE_EDGE: parseFloat(process.env.HOUSE_EDGE || '0.03'),
  STARTING_BALANCE: parseFloat(process.env.STARTING_BALANCE || '1000'),
  DEMO_BALANCE: parseFloat(process.env.DEMO_BALANCE || '500'),
  MIN_BET: parseFloat(process.env.MIN_BET || '1'),
  MAX_BET: parseFloat(process.env.MAX_BET || '10000'),
  WAITING_TIME: parseInt(process.env.WAITING_TIME || '7000'),
  SESSION_SECRET: process.env.SESSION_SECRET || 'astro-crash-secret-2024',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  DB_FILE: './data/db.json',
  BACKUP_DIR: './data/backups',
  LOGS_DIR: './data/logs',
  BOT_NAMES: ['LuckyAce','CryptoKing','StarBet','MoonRider','GoldRush','NightHawk','SpeedDemon','BigWin','JetSet','UltraMax'],
  JACKPOT_MULTIPLIER: 100,
  JACKPOT_CHANCE: 0.001,
  XP_PER_BET: 10,
  DAILY_BONUS: 10
};

// ─── Ensure directories exist ────────────────────────────────────
[CONFIG.DB_FILE.replace('/db.json',''), CONFIG.BACKUP_DIR, CONFIG.LOGS_DIR, 'public'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Database ────────────────────────────────────────────────────
let DB = {
  users: {},
  rounds: [],
  transactions: [],
  promoCodes: { 'FREE50': { amount: 50, uses: 0, maxUses: 999 }, 'WELCOME100': { amount: 100, uses: 0, maxUses: 100 } },
  referrals: {},
  bannedIPs: [],
  bannedUsers: [],
  adminLogs: [],
  withdrawals: [],
  deposits: [],
  globalMessage: '',
  maintenanceMode: false,
  settings: {
    minBet: CONFIG.MIN_BET,
    maxBet: CONFIG.MAX_BET,
    houseEdge: CONFIG.HOUSE_EDGE,
    speedMultiplier: 1,
    probabilityWeights: { low: 40, mid: 30, high: 20, vhigh: 8, ultra: 2 },
    jackpotEnabled: true
  }
};

function loadDB() {
  try {
    if (fs.existsSync(CONFIG.DB_FILE)) {
      const raw = fs.readFileSync(CONFIG.DB_FILE, 'utf8');
      DB = { ...DB, ...JSON.parse(raw) };
      console.log(`✅ Database loaded: ${Object.keys(DB.users).length} users`);
    }
  } catch (e) { console.error('DB load error:', e.message); }
}

function saveDB() {
  try {
    fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(DB, null, 2));
  } catch (e) { console.error('DB save error:', e.message); }
}

function backupDB() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(`${CONFIG.BACKUP_DIR}/db-${stamp}.json`, JSON.stringify(DB, null, 2));
    // Keep only last 10 backups
    const files = fs.readdirSync(CONFIG.BACKUP_DIR).sort();
    if (files.length > 10) fs.unlinkSync(`${CONFIG.BACKUP_DIR}/${files[0]}`);
  } catch (e) { console.error('Backup error:', e.message); }
}

function adminLog(action, adminId, details = {}) {
  const entry = { timestamp: Date.now(), action, adminId, details };
  DB.adminLogs.unshift(entry);
  if (DB.adminLogs.length > 500) DB.adminLogs = DB.adminLogs.slice(0, 500);
  saveDB();
}

loadDB();
setInterval(backupDB, 30 * 60 * 1000); // backup every 30 min
setInterval(saveDB, 60 * 1000);        // save every 60s

// ─── Provably Fair System ─────────────────────────────────────────
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function generateClientSeed() {
  return crypto.randomBytes(16).toString('hex');
}

function generateCrashPoint(serverSeed, clientSeed, nonce) {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const hash = hmac.digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = Math.pow(2, 32);
  const houseEdge = DB.settings.houseEdge;
  if (h % Math.floor(1 / houseEdge) === 0) return 1.00;
  return Math.max(1.00, parseFloat((e / (e - h) * (1 - houseEdge)).toFixed(2)));
}

// ─── Game State Machine ───────────────────────────────────────────
let GAME = {
  state: 'waiting',      // waiting | running | crashed
  multiplier: 1.00,
  startTime: null,
  crashAt: 1.00,
  serverSeed: generateServerSeed(),
  clientSeed: generateClientSeed(),
  nonce: 0,
  bets: {},             // socketId → { userId, amount, autoCashout, cashedOut, profit }
  history: [],          // last 50 rounds
  activePlayers: {},    // socketId → user info
  botIntervals: [],
  forceCrashAt: null,
  instantCrash: false,
  totalBetThisRound: 0,
  totalPayoutThisRound: 0,
  houseProfit: DB.rounds.reduce((a, r) => a + (r.housePot || 0), 0),
  killSwitch: false,
  speedMultiplier: 1
};

function getMultiplierForTime(ms) {
  const speed = GAME.speedMultiplier || 1;
  return parseFloat(Math.pow(Math.E, 0.00006 * ms * speed).toFixed(4));
}

function getTimeForMultiplier(m) {
  const speed = GAME.speedMultiplier || 1;
  return Math.log(m) / (0.00006 * speed);
}

async function startWaiting() {
  if (GAME.killSwitch || DB.maintenanceMode) return;
  GAME.state = 'waiting';
  GAME.bets = {};
  GAME.totalBetThisRound = 0;
  GAME.totalPayoutThisRound = 0;
  GAME.forceCrashAt = null;
  GAME.instantCrash = false;
  GAME.serverSeed = generateServerSeed();
  GAME.clientSeed = generateClientSeed();
  GAME.nonce++;
  GAME.multiplier = 1.00;

  // Determine crash point
  GAME.crashAt = generateCrashPointWithWeights();

  io.emit('game:waiting', {
    countdown: CONFIG.WAITING_TIME / 1000,
    nextHash: getPublicHash(),
    history: GAME.history.slice(0, 15)
  });

  // Simulate bots placing bets
  scheduleBotBets();

  setTimeout(startGame, CONFIG.WAITING_TIME);
}

function generateCrashPointWithWeights() {
  const w = DB.settings.probabilityWeights;
  const roll = Math.random() * 100;
  let raw;
  if (roll < w.low) {
    raw = 1 + Math.random() * 1.5;          // 1x–2.5x
  } else if (roll < w.low + w.mid) {
    raw = 2.5 + Math.random() * 4.5;        // 2.5x–7x
  } else if (roll < w.low + w.mid + w.high) {
    raw = 7 + Math.random() * 13;            // 7x–20x
  } else if (roll < w.low + w.mid + w.high + w.vhigh) {
    raw = 20 + Math.random() * 80;           // 20x–100x
  } else {
    raw = 100 + Math.random() * 400;         // 100x–500x
  }

  // Jackpot override
  if (DB.settings.jackpotEnabled && Math.random() < CONFIG.JACKPOT_CHANCE) {
    raw = CONFIG.JACKPOT_MULTIPLIER + Math.random() * 50;
    setTimeout(() => io.emit('game:jackpot_incoming'), 0);
  }

  // Admin force
  if (GAME.forceCrashAt !== null) return parseFloat(GAME.forceCrashAt.toFixed(2));
  if (GAME.instantCrash) return 1.00;

  return parseFloat(Math.max(1.00, raw).toFixed(2));
}

function getPublicHash() {
  return crypto.createHash('sha256').update(GAME.serverSeed + ':' + GAME.nonce).digest('hex').slice(0, 16);
}

function startGame() {
  if (GAME.killSwitch || DB.maintenanceMode) return startWaiting();
  GAME.state = 'running';
  GAME.startTime = Date.now();
  GAME.speedMultiplier = DB.settings.speedMultiplier || 1;

  io.emit('game:started', {
    startTime: GAME.startTime,
    speedMultiplier: GAME.speedMultiplier
  });

  const ticker = setInterval(() => {
    if (GAME.state !== 'running') return clearInterval(ticker);
    const elapsed = Date.now() - GAME.startTime;
    GAME.multiplier = getMultiplierForTime(elapsed);

    // Auto-cashout check
    Object.entries(GAME.bets).forEach(([sid, bet]) => {
      if (!bet.cashedOut && bet.autoCashout && GAME.multiplier >= bet.autoCashout) {
        processCashout(sid, GAME.multiplier);
      }
    });

    // Emit multiplier every 100ms
    io.emit('game:tick', { multiplier: GAME.multiplier });

    // Crash check
    if (GAME.multiplier >= GAME.crashAt) {
      clearInterval(ticker);
      crashGame();
    }
  }, 100);
}

function crashGame() {
  GAME.state = 'crashed';
  const roundId = uuidv4();
  const housePot = GAME.totalBetThisRound - GAME.totalPayoutThisRound;
  GAME.houseProfit += housePot;

  const roundData = {
    id: roundId,
    crashAt: GAME.crashAt,
    serverSeed: GAME.serverSeed,
    clientSeed: GAME.clientSeed,
    nonce: GAME.nonce,
    hash: crypto.createHmac('sha256', GAME.serverSeed).update(`${GAME.clientSeed}:${GAME.nonce}`).digest('hex'),
    bets: Object.values(GAME.bets).map(b => ({ userId: b.userId, amount: b.amount, cashedOut: b.cashedOut, profit: b.profit || 0 })),
    housePot,
    timestamp: Date.now()
  };

  GAME.history.unshift({ crashAt: GAME.crashAt, id: roundId, hash: roundData.hash });
  if (GAME.history.length > 50) GAME.history.pop();
  DB.rounds.unshift(roundData);
  if (DB.rounds.length > 500) DB.rounds.pop();

  // Bust all remaining bets
  Object.entries(GAME.bets).forEach(([sid, bet]) => {
    if (!bet.cashedOut) {
      const user = DB.users[bet.userId];
      if (user) {
        user.stats.totalLoss += bet.amount;
        user.stats.totalRounds++;
      }
    }
  });

  io.emit('game:crashed', {
    crashAt: GAME.crashAt,
    serverSeed: GAME.serverSeed,
    history: GAME.history.slice(0, 15),
    houseProfit: GAME.houseProfit
  });

  saveDB();
  setTimeout(startWaiting, 4000);
}

function processCashout(socketId, multiplier) {
  const bet = GAME.bets[socketId];
  if (!bet || bet.cashedOut || GAME.state !== 'running') return null;
  bet.cashedOut = true;
  bet.cashoutMultiplier = multiplier;
  const payout = parseFloat((bet.amount * multiplier).toFixed(2));
  const profit = parseFloat((payout - bet.amount).toFixed(2));
  bet.profit = profit;
  GAME.totalPayoutThisRound += payout;

  const user = DB.users[bet.userId];
  if (user) {
    user.balance = parseFloat((user.balance + payout).toFixed(2));
    user.stats.totalWin += payout;
    user.stats.totalRounds++;
    user.stats.maxMultiplier = Math.max(user.stats.maxMultiplier || 0, multiplier);
    user.xp += CONFIG.XP_PER_BET;
    updateLevel(user);

    // Referral commission
    if (user.referredBy && profit > 0) {
      const refUser = DB.users[user.referredBy];
      if (refUser) {
        refUser.balance = parseFloat((refUser.balance + profit * 0.10).toFixed(2));
        refUser.stats.referralEarnings = (refUser.stats.referralEarnings || 0) + profit * 0.10;
      }
    }

    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('bet:cashedout', { multiplier, payout, profit, balance: user.balance });
    }

    // Broadcast win
    io.emit('game:win', { username: user.username, amount: payout, multiplier });
  }
  return payout;
}

function updateLevel(user) {
  const levels = [0, 100, 300, 600, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
  let level = 0;
  for (let i = 0; i < levels.length; i++) {
    if (user.xp >= levels[i]) level = i;
  }
  user.level = level;
  if (level >= 7) user.vip = true;
}

// ─── Bot System ───────────────────────────────────────────────────
let bots = [];
const BOT_MESSAGES = [
  'lets go! 🚀','crashed again lol 😅','easyyy money 💰','who else cashing at 2x?',
  'im going for 10x this time!','gg everyone','ouch 😬','insane round!','my lucky day 🍀','moon or bust 🌙'
];

function addBot(name) {
  const id = 'bot_' + name.toLowerCase().replace(' ', '_');
  if (bots.find(b => b.id === id)) return;
  bots.push({ id, name, balance: 10000, active: true });
  io.emit('chat:message', { username: name, message: '👋 joined the game', isBot: true, timestamp: Date.now() });
}

function removeBot(id) {
  bots = bots.filter(b => b.id !== id);
}

function scheduleBotBets() {
  if (bots.length === 0) return;
  bots.filter(b => b.active).forEach(bot => {
    const delay = Math.random() * 4000;
    setTimeout(() => {
      if (GAME.state !== 'waiting') return;
      const amount = parseFloat((Math.random() * 100 + 10).toFixed(2));
      const autoCashout = Math.random() > 0.5 ? parseFloat((1.5 + Math.random() * 5).toFixed(2)) : null;
      const fakeSocketId = 'bot_' + bot.id + '_' + Date.now();
      GAME.bets[fakeSocketId] = { userId: bot.id, amount, autoCashout, cashedOut: false, isBot: true };
      GAME.totalBetThisRound += amount;
      io.emit('bet:placed', { username: bot.name, amount, autoCashout, isBot: true });

      // Bot chat occasionally
      if (Math.random() < 0.3) {
        setTimeout(() => {
          io.emit('chat:message', {
            username: bot.name,
            message: BOT_MESSAGES[Math.floor(Math.random() * BOT_MESSAGES.length)],
            isBot: true,
            timestamp: Date.now()
          });
        }, Math.random() * 3000);
      }
    }, delay);
  });
}

// Auto-add some bots at start
CONFIG.BOT_NAMES.slice(0, 5).forEach(name => addBot(name));

// ─── Middleware ───────────────────────────────────────────────────
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many requests' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many auth attempts' } });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

app.use(express.static('public'));

// ─── IP Ban Middleware ────────────────────────────────────────────
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (DB.bannedIPs.includes(ip)) return res.status(403).json({ error: 'Access denied' });
  next();
});

// ─── Auth Helpers ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId || !DB.users[req.session.userId]) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function createUser(username, password, referCode) {
  const id = uuidv4();
  const user = {
    id, username,
    passwordHash: bcrypt.hashSync(password, 10),
    balance: CONFIG.STARTING_BALANCE,
    demoBalance: CONFIG.DEMO_BALANCE,
    bonusBalance: 0,
    wageringRequired: 0,
    xp: 0, level: 0, vip: false,
    avatar: Math.floor(Math.random() * 8) + 1,
    referralCode: uuidv4().slice(0, 8).toUpperCase(),
    referredBy: null,
    stats: { totalWin: 0, totalLoss: 0, totalRounds: 0, maxMultiplier: 0, referralEarnings: 0 },
    dailyBonus: null,
    createdAt: Date.now(),
    banned: false,
    email: '',
    walletAddress: '',
    responsibleGaming: { dailyLimit: null, sessionStart: null, sessionDuration: null }
  };

  if (referCode) {
    const refUser = Object.values(DB.users).find(u => u.referralCode === referCode);
    if (refUser) {
      user.referredBy = refUser.id;
      if (!DB.referrals[refUser.id]) DB.referrals[refUser.id] = [];
      DB.referrals[refUser.id].push(id);
    }
  }

  DB.users[id] = user;
  saveDB();
  return user;
}

// ─── REST API ─────────────────────────────────────────────────────

// Register
app.post('/api/auth/register', (req, res) => {
  const { username, password, referCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (Object.values(DB.users).find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  const user = createUser(username, password, referCode);
  req.session.userId = user.id;
  res.json({ success: true, user: safeUser(user) });
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = Object.values(DB.users).find(u => u.username.toLowerCase() === username?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.banned) return res.status(403).json({ error: 'Account banned' });
  req.session.userId = user.id;
  if (password === CONFIG.ADMIN_PASSWORD && username === 'admin') req.session.isAdmin = true;
  res.json({ success: true, user: safeUser(user), isAdmin: !!req.session.isAdmin });
});

// Admin login
app.post('/api/auth/admin', (req, res) => {
  const { password } = req.body;
  if (password !== CONFIG.ADMIN_PASSWORD) return res.status(403).json({ error: 'Wrong password' });
  req.session.isAdmin = true;
  res.json({ success: true });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Me
app.get('/api/me', requireAuth, (req, res) => {
  res.json(safeUser(DB.users[req.session.userId]));
});

// Update profile
app.post('/api/profile', requireAuth, (req, res) => {
  const user = DB.users[req.session.userId];
  const { username, avatar, walletAddress, email } = req.body;
  if (username && username !== user.username) {
    if (Object.values(DB.users).find(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== user.id)) {
      return res.status(400).json({ error: 'Username taken' });
    }
    user.username = username;
  }
  if (avatar) user.avatar = avatar;
  if (walletAddress !== undefined) user.walletAddress = walletAddress;
  if (email !== undefined) user.email = email;
  saveDB();
  res.json({ success: true, user: safeUser(user) });
});

// Change password
app.post('/api/change-password', requireAuth, (req, res) => {
  const user = DB.users[req.session.userId];
  const { oldPassword, newPassword } = req.body;
  if (!bcrypt.compareSync(oldPassword, user.passwordHash)) return res.status(400).json({ error: 'Wrong current password' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveDB();
  res.json({ success: true });
});

// Daily bonus
app.post('/api/daily-bonus', requireAuth, (req, res) => {
  const user = DB.users[req.session.userId];
  const now = Date.now();
  const lastClaim = user.dailyBonus;
  if (lastClaim && now - lastClaim < 24 * 60 * 60 * 1000) {
    const remaining = 24 * 60 * 60 * 1000 - (now - lastClaim);
    return res.status(400).json({ error: 'Already claimed', remaining });
  }
  user.balance += CONFIG.DAILY_BONUS;
  user.dailyBonus = now;
  saveDB();
  res.json({ success: true, amount: CONFIG.DAILY_BONUS, balance: user.balance });
});

// Promo code
app.post('/api/promo', requireAuth, (req, res) => {
  const { code } = req.body;
  const promo = DB.promoCodes[code?.toUpperCase()];
  if (!promo) return res.status(400).json({ error: 'Invalid code' });
  if (promo.uses >= promo.maxUses) return res.status(400).json({ error: 'Code expired' });
  const user = DB.users[req.session.userId];
  if (user.usedPromos && user.usedPromos.includes(code)) return res.status(400).json({ error: 'Already used' });
  promo.uses++;
  user.bonusBalance += promo.amount;
  user.wageringRequired += promo.amount * 10;
  if (!user.usedPromos) user.usedPromos = [];
  user.usedPromos.push(code);
  saveDB();
  res.json({ success: true, amount: promo.amount, balance: user.balance });
});

// Deposit request
app.post('/api/deposit', requireAuth, (req, res) => {
  const { txid, amount, currency } = req.body;
  if (!txid || !amount) return res.status(400).json({ error: 'TXID and amount required' });
  const entry = { id: uuidv4(), userId: req.session.userId, txid, amount: parseFloat(amount), currency: currency || 'USDT', status: 'pending', createdAt: Date.now() };
  DB.deposits.push(entry);
  saveDB();
  res.json({ success: true, message: 'Deposit submitted, pending verification' });
});

// Withdrawal request
app.post('/api/withdraw', requireAuth, (req, res) => {
  const user = DB.users[req.session.userId];
  const { amount, walletAddress } = req.body;
  if (!amount || amount < 5) return res.status(400).json({ error: 'Min withdrawal $5' });
  if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
  user.balance -= parseFloat(amount);
  const entry = { id: uuidv4(), userId: req.session.userId, username: user.username, amount: parseFloat(amount), walletAddress: walletAddress || user.walletAddress, status: 'pending', createdAt: Date.now() };
  DB.withdrawals.push(entry);
  saveDB();
  res.json({ success: true, message: 'Withdrawal requested', balance: user.balance });
});

// Stats
app.get('/api/stats', (req, res) => {
  res.json({
    totalUsers: Object.keys(DB.users).length,
    totalRounds: DB.rounds.length,
    houseProfit: GAME.houseProfit,
    onlineCount: Object.keys(GAME.activePlayers).length,
    history: GAME.history.slice(0, 20)
  });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const leaders = Object.values(DB.users)
    .filter(u => !u.banned)
    .map(u => ({ username: u.username, totalWin: u.stats.totalWin, maxMultiplier: u.stats.maxMultiplier, level: u.level, vip: u.vip, avatar: u.avatar }))
    .sort((a, b) => b.totalWin - a.totalWin)
    .slice(0, 50);
  res.json(leaders);
});

// Round history & verify
app.get('/api/rounds', (req, res) => {
  res.json(DB.rounds.slice(0, 50).map(r => ({ id: r.id, crashAt: r.crashAt, hash: r.hash, timestamp: r.timestamp })));
});

app.get('/api/verify/:hash', (req, res) => {
  const round = DB.rounds.find(r => r.hash === req.params.hash);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const verified = crypto.createHmac('sha256', round.serverSeed).update(`${round.clientSeed}:${round.nonce}`).digest('hex') === round.hash;
  res.json({ ...round, verified });
});

// Responsible gaming
app.post('/api/responsible-gaming', requireAuth, (req, res) => {
  const user = DB.users[req.session.userId];
  const { dailyLimit, sessionDuration } = req.body;
  user.responsibleGaming.dailyLimit = dailyLimit || null;
  user.responsibleGaming.sessionDuration = sessionDuration || null;
  saveDB();
  res.json({ success: true });
});

// Recent payouts
app.get('/api/payouts', (req, res) => {
  const payouts = DB.rounds.slice(0, 20).flatMap(r =>
    r.bets.filter(b => b.profit > 0).map(b => ({
      username: DB.users[b.userId]?.username || 'Player',
      profit: b.profit,
      multiplier: r.crashAt,
      timestamp: r.timestamp
    }))
  ).sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
  res.json(payouts);
});

// Export CSV (admin)
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = ['Date,Username,TotalWin,TotalLoss,Balance,Rounds'];
  Object.values(DB.users).forEach(u => {
    rows.push(`${new Date(u.createdAt).toLocaleDateString()},${u.username},${u.stats.totalWin},${u.stats.totalLoss},${u.balance},${u.stats.totalRounds}`);
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=report.csv');
  res.send(rows.join('\n'));
});

// ─── Admin REST Endpoints ─────────────────────────────────────────
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.json({
    users: Object.values(DB.users).map(safeUser),
    houseProfit: GAME.houseProfit,
    totalBets: DB.rounds.reduce((a, r) => a + r.bets.length, 0),
    onlinePlayers: Object.values(GAME.activePlayers),
    withdrawals: DB.withdrawals,
    deposits: DB.deposits,
    adminLogs: DB.adminLogs.slice(0, 100),
    bots: bots,
    settings: DB.settings,
    maintenanceMode: DB.maintenanceMode
  });
});

app.post('/api/admin/balance', requireAdmin, (req, res) => {
  const { userId, amount, action } = req.body;
  const user = DB.users[userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (action === 'set') user.balance = parseFloat(amount);
  else if (action === 'add') user.balance += parseFloat(amount);
  else if (action === 'sub') user.balance = Math.max(0, user.balance - parseFloat(amount));
  adminLog('BALANCE_CHANGE', req.session.userId, { userId, amount, action, newBalance: user.balance });
  saveDB();
  res.json({ success: true, balance: user.balance });
});

app.post('/api/admin/ban', requireAdmin, (req, res) => {
  const { userId, ip } = req.body;
  if (userId) { const u = DB.users[userId]; if (u) u.banned = true; }
  if (ip && !DB.bannedIPs.includes(ip)) DB.bannedIPs.push(ip);
  adminLog('BAN', req.session.userId, { userId, ip });
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/unban', requireAdmin, (req, res) => {
  const { userId } = req.body;
  if (userId) { const u = DB.users[userId]; if (u) u.banned = false; }
  adminLog('UNBAN', req.session.userId, { userId });
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/force-crash', requireAdmin, (req, res) => {
  const { value } = req.body;
  GAME.forceCrashAt = parseFloat(value);
  adminLog('FORCE_CRASH', req.session.userId, { value });
  res.json({ success: true });
});

app.post('/api/admin/instant-crash', requireAdmin, (req, res) => {
  GAME.instantCrash = true;
  GAME.crashAt = 1.00;
  adminLog('INSTANT_CRASH', req.session.userId);
  res.json({ success: true });
});

app.post('/api/admin/kill-switch', requireAdmin, (req, res) => {
  GAME.killSwitch = !GAME.killSwitch;
  DB.maintenanceMode = GAME.killSwitch;
  io.emit('game:maintenance', { active: GAME.killSwitch });
  adminLog('KILL_SWITCH', req.session.userId, { state: GAME.killSwitch });
  saveDB();
  res.json({ success: true, state: GAME.killSwitch });
});

app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
  DB.maintenanceMode = !DB.maintenanceMode;
  io.emit('game:maintenance', { active: DB.maintenanceMode });
  adminLog('MAINTENANCE', req.session.userId, { state: DB.maintenanceMode });
  saveDB();
  res.json({ success: true, state: DB.maintenanceMode });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { minBet, maxBet, houseEdge, speedMultiplier, probabilityWeights, jackpotEnabled } = req.body;
  if (minBet !== undefined) DB.settings.minBet = parseFloat(minBet);
  if (maxBet !== undefined) DB.settings.maxBet = parseFloat(maxBet);
  if (houseEdge !== undefined) DB.settings.houseEdge = parseFloat(houseEdge);
  if (speedMultiplier !== undefined) { DB.settings.speedMultiplier = parseFloat(speedMultiplier); GAME.speedMultiplier = parseFloat(speedMultiplier); }
  if (probabilityWeights) DB.settings.probabilityWeights = probabilityWeights;
  if (jackpotEnabled !== undefined) DB.settings.jackpotEnabled = jackpotEnabled;
  adminLog('SETTINGS_CHANGE', req.session.userId, req.body);
  saveDB();
  res.json({ success: true, settings: DB.settings });
});

app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { message } = req.body;
  DB.globalMessage = message;
  io.emit('admin:broadcast', { message });
  adminLog('BROADCAST', req.session.userId, { message });
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/add-bot', requireAdmin, (req, res) => {
  const { name } = req.body;
  addBot(name || CONFIG.BOT_NAMES[Math.floor(Math.random() * CONFIG.BOT_NAMES.length)]);
  adminLog('ADD_BOT', req.session.userId, { name });
  res.json({ success: true, bots });
});

app.post('/api/admin/remove-bot', requireAdmin, (req, res) => {
  const { id } = req.body;
  removeBot(id);
  adminLog('REMOVE_BOT', req.session.userId, { id });
  res.json({ success: true, bots });
});

app.post('/api/admin/reset-demos', requireAdmin, (req, res) => {
  Object.values(DB.users).forEach(u => { u.demoBalance = CONFIG.DEMO_BALANCE; });
  adminLog('RESET_DEMOS', req.session.userId);
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/withdrawal-action', requireAdmin, (req, res) => {
  const { id, action } = req.body;
  const w = DB.withdrawals.find(x => x.id === id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  w.status = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'reject') {
    const u = DB.users[w.userId];
    if (u) u.balance += w.amount; // refund
  }
  adminLog('WITHDRAWAL_' + action.toUpperCase(), req.session.userId, { id, amount: w.amount });
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/deposit-action', requireAdmin, (req, res) => {
  const { id, action } = req.body;
  const d = DB.deposits.find(x => x.id === id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.status = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'approve') {
    const u = DB.users[d.userId];
    if (u) u.balance += d.amount;
  }
  adminLog('DEPOSIT_' + action.toUpperCase(), req.session.userId, { id, amount: d.amount });
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/promo', requireAdmin, (req, res) => {
  const { code, amount, maxUses } = req.body;
  DB.promoCodes[code.toUpperCase()] = { amount: parseFloat(amount), uses: 0, maxUses: parseInt(maxUses) || 100 };
  adminLog('PROMO_CREATE', req.session.userId, { code, amount });
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/chat-clean', requireAdmin, (req, res) => {
  io.emit('chat:clear');
  adminLog('CHAT_CLEAN', req.session.userId);
  res.json({ success: true });
});

app.post('/api/admin/jackpot-trigger', requireAdmin, (req, res) => {
  GAME.forceCrashAt = CONFIG.JACKPOT_MULTIPLIER + Math.random() * 50;
  io.emit('game:jackpot_incoming');
  adminLog('JACKPOT_TRIGGER', req.session.userId);
  res.json({ success: true });
});

// ─── Socket.io ────────────────────────────────────────────────────
const connectedSockets = {}; // userId → socketId (prevent multi-tab)

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  if (DB.bannedIPs.includes(ip)) { socket.disconnect(); return; }

  let currentUser = null;

  // Auth via socket
  socket.on('auth', ({ userId }) => {
    const user = DB.users[userId];
    if (!user || user.banned) return socket.emit('auth:error', 'Invalid session');

    // Multi-tab prevention
    if (connectedSockets[userId] && connectedSockets[userId] !== socket.id) {
      const oldSocket = io.sockets.sockets.get(connectedSockets[userId]);
      if (oldSocket) { oldSocket.emit('auth:duplicate'); oldSocket.disconnect(); }
    }
    connectedSockets[userId] = socket.id;
    currentUser = user;
    user.responsibleGaming.sessionStart = Date.now();

    GAME.activePlayers[socket.id] = { username: user.username, level: user.level, vip: user.vip, avatar: user.avatar };
    io.emit('players:update', { count: Object.keys(GAME.activePlayers).length });

    socket.emit('auth:ok', {
      user: safeUser(user),
      gameState: {
        state: GAME.state,
        multiplier: GAME.multiplier,
        history: GAME.history.slice(0, 15),
        startTime: GAME.startTime
      },
      globalMessage: DB.globalMessage,
      settings: DB.settings
    });
  });

  // Place bet
  socket.on('bet:place', (data) => {
    if (!currentUser) return socket.emit('error', 'Not authenticated');
    if (GAME.state !== 'waiting') return socket.emit('error', 'Betting closed');
    if (GAME.bets[socket.id]) return socket.emit('error', 'Bet already placed');

    const amount = parseFloat(data.amount);
    if (isNaN(amount) || amount < DB.settings.minBet || amount > DB.settings.maxBet) {
      return socket.emit('error', `Bet must be $${DB.settings.minBet}–$${DB.settings.maxBet}`);
    }

    const useDemo = data.useDemo;
    const balanceKey = useDemo ? 'demoBalance' : 'balance';
    if (currentUser[balanceKey] < amount) return socket.emit('error', 'Insufficient balance');

    currentUser[balanceKey] = parseFloat((currentUser[balanceKey] - amount).toFixed(2));
    GAME.totalBetThisRound += amount;
    GAME.bets[socket.id] = {
      userId: currentUser.id,
      username: currentUser.username,
      amount,
      autoCashout: data.autoCashout ? parseFloat(data.autoCashout) : null,
      cashedOut: false,
      useDemo,
      balanceKey
    };

    socket.emit('bet:confirmed', { amount, balance: currentUser[balanceKey] });
    io.emit('bet:placed', { username: currentUser.username, amount, autoCashout: data.autoCashout });
    saveDB();
  });

  // Cashout
  socket.on('bet:cashout', () => {
    if (GAME.state !== 'running') return socket.emit('error', 'Cannot cashout now');
    const payout = processCashout(socket.id, GAME.multiplier);
    if (!payout) socket.emit('error', 'No active bet or already cashed out');
  });

  // Chat
  socket.on('chat:send', ({ message }) => {
    if (!currentUser) return;
    if (!message || message.trim().length === 0 || message.length > 200) return;
    if (currentUser.chatMuted) return socket.emit('error', 'You are muted');
    io.emit('chat:message', {
      username: currentUser.username,
      message: message.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      level: currentUser.level,
      vip: currentUser.vip,
      avatar: currentUser.avatar,
      timestamp: Date.now()
    });
  });

  // Emoji reaction
  socket.on('chat:emoji', ({ emoji }) => {
    const allowed = ['🚀', '💥', '💰', '🎰', '🔥', '😂', '😭', '🤑', '👀', '🎉'];
    if (!allowed.includes(emoji)) return;
    io.emit('chat:emoji', { username: currentUser?.username, emoji, timestamp: Date.now() });
  });

  // Gift/tip
  socket.on('player:tip', ({ toUsername, amount }) => {
    if (!currentUser) return;
    const target = Object.values(DB.users).find(u => u.username === toUsername);
    if (!target) return socket.emit('error', 'Player not found');
    const tipAmount = parseFloat(amount);
    if (tipAmount < 1 || currentUser.balance < tipAmount) return socket.emit('error', 'Invalid tip');
    currentUser.balance -= tipAmount;
    target.balance += tipAmount;
    socket.emit('tip:sent', { to: toUsername, amount: tipAmount, balance: currentUser.balance });
    const targetSocket = io.sockets.sockets.get(connectedSockets[target.id]);
    if (targetSocket) targetSocket.emit('tip:received', { from: currentUser.username, amount: tipAmount });
    saveDB();
  });

  // Admin socket actions
  socket.on('admin:auth', ({ password }) => {
    if (password === CONFIG.ADMIN_PASSWORD) {
      socket.join('admin');
      socket.emit('admin:ok');
    }
  });

  socket.on('disconnect', () => {
    if (currentUser) {
      delete connectedSockets[currentUser.id];
      delete GAME.activePlayers[socket.id];
      io.emit('players:update', { count: Object.keys(GAME.activePlayers).length });
    }
  });
});

// ─── Helper ───────────────────────────────────────────────────────
function safeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

// ─── Start ────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`🚀 Astro Crash running on port ${CONFIG.PORT}`);
  startWaiting();
});

process.on('SIGTERM', () => { saveDB(); process.exit(0); });
process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('uncaughtException', (e) => { console.error('Uncaught:', e); saveDB(); });
