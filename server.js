/**
 * ASTRO CRASH PRO — Server v3.0
 * Node.js + Socket.io | Replit Ready
 * Authoritative Server-Side Game Engine
 */
require('dotenv').config();
const express     = require('express');
const http        = require('http');
const { Server }  = require('socket.io');
const rateLimit   = require('express-rate-limit');
const helmet      = require('helmet');
const compression = require('compression');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const { v4: uuid } = require('uuid');

// ─── CONFIG ─────────────────────────────────────────
const CFG = {
  PORT:         process.env.PORT         || 3000,
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'AstroAdmin2024',
  ADMIN_ROUTE:  process.env.ADMIN_ROUTE  || '/admin-secret-access',
  START_BAL:    1000,
  MIN_BET:      0.10,
  MAX_BET:      10000,
  BETTING_MS:   10000,
  STARTING_MS:  2000,
  CRASHED_MS:   4000,
  TICK_MS:      100,
  DB_PATH:      './data/db.json',
  BOT_NAMES:    ['CryptoK','NightFly','StarBet','ZeroG','NovaBet','BitBlast','AstroVet','PulsR','VoidX','DrkMtr'],
  BOT_COLORS:   ['#00d4ff','#ff2d55','#ffe600','#00ff88','#bf5fff','#ff6600','#00fff7','#ff69b4'],
};

// ─── DATA STORE (JSON DB) ────────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
function loadDB() { try { return JSON.parse(fs.readFileSync(CFG.DB_PATH,'utf8')); } catch(e) { return { users:{}, txLogs:[], referrals:{} }; } }
function saveDB() { fs.writeFileSync(CFG.DB_PATH, JSON.stringify(DB, null, 2)); }
let DB = loadDB();
// Auto-save every 30s
setInterval(saveDB, 30000);
// Auto backup daily
setInterval(() => {
  const ts = new Date().toISOString().slice(0,10);
  try { fs.writeFileSync(`./data/backup_${ts}.json`, JSON.stringify(DB, null, 2)); } catch(e) {}
}, 3600000);

// ─── APP SETUP ───────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin:'*' },
  perMessageDeflate: true,
});

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs:60000, max:200 }));

// ─── GAME SETTINGS (Admin-Changeable) ────────────────
let GS = {
  probs:       [5, 50, 35, 9, 1],   // [instant,low,mid,high,jackpot]
  growthBase:  0.00008,
  houseEdge:   0.03,
  minBet:      CFG.MIN_BET,
  maxBet:      CFG.MAX_BET,
  botCount:    6,
  killSwitch:  false,
  maintenance: false,
  globalMsg:   '',
  forceCrash:  null,
};

// ─── CRASH RANGES ────────────────────────────────────
const RANGES = [
  {min:1.00,max:1.00},{min:1.01,max:1.50},
  {min:1.51,max:5.00},{min:5.01,max:15.0},{min:15.01,max:30.0}
];

// ─── PROVABLY FAIR ────────────────────────────────────
let sSeed = crypto.randomBytes(32).toString('hex');
let sHash = crypto.createHash('sha256').update(sSeed).digest('hex');
let cSeed = crypto.randomBytes(8).toString('hex');
let nonce = 0;

function genCrash() {
  if (GS.forceCrash !== null) { const c=GS.forceCrash; GS.forceCrash=null; return c; }
  const combined=`${sSeed}:${cSeed}:${nonce}`;
  const hmac=crypto.createHmac('sha256',sSeed).update(combined).digest('hex');
  const rng=parseInt(hmac.slice(0,8),16)/0xFFFFFFFF;
  if (rng < GS.houseEdge) return 1.00;
  const total=GS.probs.reduce((s,v)=>s+v,0)||100;
  let cumul=0, bucket=4;
  const pick=rng*total;
  for(let i=0;i<GS.probs.length;i++){cumul+=GS.probs[i];if(pick<cumul){bucket=i;break;}}
  const r=RANGES[bucket];
  if(r.min===r.max) return r.min;
  const intra=crypto.randomBytes(4).readUInt32BE(0)/0xFFFFFFFF;
  const skew=bucket>=3?Math.pow(intra,2.2):intra;
  return Math.max(r.min,Math.min(r.max,parseFloat((r.min+skew*(r.max-r.min)).toFixed(2))));
}

function rotateSeed() {
  nonce++;
  const prev=sSeed;
  sSeed=crypto.randomBytes(32).toString('hex');
  sHash=crypto.createHash('sha256').update(sSeed).digest('hex');
  cSeed=crypto.randomBytes(8).toString('hex');
  return {prev,hash:sHash,client:cSeed,nonce};
}

// ─── GAME STATE ───────────────────────────────────────
let STATE = {
  phase:'betting', mult:1.00, crashPt:1.00, roundNum:0,
  startTime:null, seedHash:'', clientSeed:'', nonce:0, prevSeed:'',
  bets:{},
};

let houseProfit=0, totalBets=0, totalRounds=0;
let sessions={};    // userId -> socketId
let botPlayers={};
let crashHistory=[];
let botTimers=[];

// ─── BOT SYSTEM ───────────────────────────────────────
const BOT_CHATS = [
  'Lucky round! 🚀','Let it fly!','Come on 5x!','Cash out at 2x!','10x incoming!!',
  'GG everyone 🎉','Wow that was close','Double up!','YOLO 🔥','nice one!',
  'sinhala players best','ayye 3x!','crash too early 😭','who else at 2x?','yess!!'
];

function scheduleBots() {
  botTimers.forEach(t=>clearTimeout(t)); botTimers=[]; botPlayers={};
  const n=Math.min(GS.botCount,12);
  for(let i=0;i<n;i++){
    const id='bot'+i;
    const name=CFG.BOT_NAMES[i%CFG.BOT_NAMES.length]+(Math.random()>.5?Math.floor(Math.random()*99):'');
    const color=CFG.BOT_COLORS[i%CFG.BOT_COLORS.length];
    const amt=parseFloat((Math.random()*80+5).toFixed(2));
    const coAt=parseFloat((Math.random()*5+1.1).toFixed(2));
    botPlayers[id]={id,name,color,amount:amt,coAt,status:'pending',pnl:null};
    const delay=Math.random()*(CFG.BETTING_MS-2000)+400;
    botTimers.push(setTimeout(()=>{
      if(STATE.phase!=='betting') return;
      io.emit('bot_bet',{id,name,color,amount:amt,coAt});
      if(Math.random()>.5){
        setTimeout(()=>io.emit('chat',{name,color,msg:BOT_CHATS[Math.floor(Math.random()*BOT_CHATS.length)],bot:true}),Math.random()*3000+500);
      }
    },delay));
  }
  const checkBots=setInterval(()=>{
    if(STATE.phase!=='running'){clearInterval(checkBots);return;}
    Object.values(botPlayers).forEach(b=>{
      if(b.status==='pending'&&STATE.mult>=b.coAt){
        b.status='won';b.pnl=(b.amount*b.coAt).toFixed(2);
        io.emit('bot_cashout',{id:b.id,name:b.name,mult:parseFloat(STATE.mult.toFixed(2))});
      }
    });
  },150);
}

// ─── GAME LOOP ────────────────────────────────────────
let gameTimer=null, tickInterval=null;

function startBetting() {
  if(GS.maintenance){setTimeout(startBetting,5000);return;}
  clearTimeout(gameTimer); clearInterval(tickInterval);
  const seed=rotateSeed();
  STATE.crashPt=genCrash(); STATE.phase='betting'; STATE.mult=1.00;
  STATE.bets={}; STATE.roundNum++; STATE.prevSeed=seed.prev;
  STATE.seedHash=seed.hash; STATE.clientSeed=seed.client; STATE.nonce=seed.nonce;
  totalRounds++; botPlayers={};
  io.emit('phase',{phase:'betting',duration:CFG.BETTING_MS,round:STATE.roundNum,
    seedHash:seed.hash,clientSeed:seed.client,nonce:seed.nonce,prevSeed:seed.prev});
  scheduleBots();
  gameTimer=setTimeout(startStarting,CFG.BETTING_MS);
}

function startStarting() {
  STATE.phase='starting';
  io.emit('phase',{phase:'starting',duration:CFG.STARTING_MS});
  gameTimer=setTimeout(startRunning,CFG.STARTING_MS);
}

function startRunning() {
  STATE.phase='running'; STATE.startTime=Date.now();
  io.emit('phase',{phase:'running',startTime:STATE.startTime});
  tickInterval=setInterval(()=>{
    const elapsed=Date.now()-STATE.startTime;
    STATE.mult=parseFloat(Math.pow(Math.E,GS.growthBase*elapsed).toFixed(4));
    for(const [sid,bet] of Object.entries(STATE.bets)){
      if(!bet.cashedOut&&bet.autoAt&&STATE.mult>=bet.autoAt) processCashout(sid,true);
    }
    io.volatile.emit('tick',{m:parseFloat(STATE.mult.toFixed(3)),e:elapsed});
    if(STATE.mult>=STATE.crashPt||GS.killSwitch) doCrash();
  },CFG.TICK_MS);
}

function doCrash() {
  clearInterval(tickInterval);
  STATE.phase='crashed';
  const cp=parseFloat(STATE.mult.toFixed(2));
  Object.entries(STATE.bets).forEach(([sid,bet])=>{
    if(!bet.cashedOut){
      houseProfit+=bet.amount;
      const u=DB.users[bet.userId];
      if(u){
        u.txLog=u.txLog||[];
        u.txLog.unshift({type:'bet',bet:bet.amount,mult:cp,profit:-bet.amount,win:false,t:Date.now(),round:STATE.roundNum});
        u.totalBets=(u.totalBets||0)+bet.amount; u.losses=(u.losses||0)+bet.amount;
        const ws=io.sockets.sockets.get(sid);
        if(ws) ws.emit('bet_result',{win:false,mult:cp,profit:-bet.amount,balance:u.balance});
      }
    }
  });
  Object.values(botPlayers).forEach(b=>{if(b.status==='pending')b.status='lost';});
  crashHistory.unshift(cp); if(crashHistory.length>20) crashHistory.pop();
  io.emit('phase',{phase:'crashed',mult:cp,crashPt:cp,prevSeed:STATE.prevSeed,history:crashHistory});
  saveDB();
  gameTimer=setTimeout(startBetting,CFG.CRASHED_MS);
}

function processCashout(sid, isAuto=false) {
  const bet=STATE.bets[sid];
  if(!bet||bet.cashedOut||STATE.phase!=='running') return false;
  bet.cashedOut=true; bet.cashMult=parseFloat(STATE.mult.toFixed(4));
  const payout=parseFloat((bet.amount*bet.cashMult).toFixed(2));
  const profit=parseFloat((payout-bet.amount).toFixed(2));
  const u=DB.users[bet.userId];
  if(u){
    u.balance=parseFloat((u.balance+payout).toFixed(2));
    u.txLog=u.txLog||[];
    u.txLog.unshift({type:'bet',bet:bet.amount,mult:bet.cashMult,profit,win:true,t:Date.now(),round:STATE.roundNum});
    u.totalBets=(u.totalBets||0)+bet.amount; u.wins=(u.wins||0)+profit;
    u.maxMult=Math.max(u.maxMult||0,bet.cashMult);
    houseProfit-=payout; totalBets+=bet.amount;
    const ws=io.sockets.sockets.get(sid);
    if(ws) ws.emit('cashout_ok',{mult:bet.cashMult,payout,profit,balance:u.balance,isAuto});
  }
  io.emit('player_cashout',{name:u?.name||'Player',mult:bet.cashMult,amount:bet.amount});
  return true;
}

// ─── USER HELPERS ─────────────────────────────────────
function getOrCreate(uid) {
  if(!uid||!DB.users[uid]){
    uid=uuid();
    const adjs=['Lucky','Star','Neon','Cyber','Astro','Nova'];
    const nouns=['Rider','Hawk','Storm','Blaze','Ghost','Comet'];
    DB.users[uid]={
      id:uid, name:adjs[Math.floor(Math.random()*adjs.length)]+'_'+nouns[Math.floor(Math.random()*nouns.length)]+Math.floor(Math.random()*99),
      balance:CFG.START_BAL, totalBets:0, wins:0, losses:0, maxMult:0,
      txLog:[], refCode:uid.slice(0,8).toUpperCase(), refBy:null, refCount:0, refEarned:0,
      banned:false, deposits:[], withdrawals:[], joinedAt:Date.now(),
    };
    saveDB();
  }
  return DB.users[uid];
}

function safeUser(u){
  return {id:u.id,name:u.name,balance:u.balance,totalBets:u.totalBets,wins:u.wins,losses:u.losses,maxMult:u.maxMult,refCode:u.refCode,refCount:u.refCount,refEarned:u.refEarned};
}

// ─── SOCKET HANDLER ───────────────────────────────────
let playerMetas = {}; // sid -> { ip, ua }

io.on('connection', ws => {
  const ip = ws.handshake.address;
  const ua = ws.handshake.headers['user-agent']||'';
  playerMetas[ws.id] = { ip };

  let me = null;

  ws.emit('welcome',{phase:STATE.phase,mult:STATE.mult,roundNum:STATE.roundNum,
    startTime:STATE.startTime,seedHash:STATE.seedHash,history:crashHistory,
    minBet:GS.minBet,maxBet:GS.maxBet,globalMsg:GS.globalMsg});

  ws.on('auth',({uid,ref})=>{
    me=getOrCreate(uid);
    if(me.banned){ws.emit('banned');ws.disconnect();return;}
    // Single-session enforcement
    const prev=sessions[me.id];
    if(prev&&prev!==ws.id){
      const ps=io.sockets.sockets.get(prev);
      if(ps){ps.emit('kicked',{msg:'Logged in elsewhere'});ps.disconnect();}
    }
    sessions[me.id]=ws.id;
    // Referral
    if(ref&&!me.refBy){
      const refUser=Object.values(DB.users).find(u=>u.refCode===ref);
      if(refUser&&refUser.id!==me.id){
        me.refBy=refUser.id; refUser.refCount=(refUser.refCount||0)+1;
        refUser.refEarned=(refUser.refEarned||0)+5; refUser.balance+=5;
        saveDB();
        const rs=io.sockets.sockets.get(sessions[refUser.id]);
        if(rs) rs.emit('notify',{msg:'Referral bonus +$5!',type:'win'});
      }
    }
    ws.emit('auth_ok',{uid:me.id,user:safeUser(me),settings:{minBet:GS.minBet,maxBet:GS.maxBet}});
    broadcastLobby();
  });

  ws.on('set_name',({name})=>{
    if(!me)return; if(typeof name==='string'&&name.trim().length>=2){me.name=name.trim().slice(0,20).replace(/[<>]/g,'');saveDB();ws.emit('name_ok',{name:me.name});broadcastLobby();}
  });

  ws.on('place_bet',({amount,autoAt,panel})=>{
    if(!me||GS.killSwitch)return;
    if(STATE.phase!=='betting'){ws.emit('error',{msg:'Betting phase ended'});return;}
    if(STATE.bets[ws.id]){ws.emit('error',{msg:'Already bet'});return;}
    const amt=parseFloat(parseFloat(amount).toFixed(2));
    if(isNaN(amt)||amt<GS.minBet){ws.emit('error',{msg:`Min bet $${GS.minBet}`});return;}
    if(amt>GS.maxBet){ws.emit('error',{msg:`Max bet $${GS.maxBet}`});return;}
    if(amt>me.balance){ws.emit('error',{msg:'Insufficient balance'});return;}
    me.balance=parseFloat((me.balance-amt).toFixed(2));
    houseProfit+=amt;
    STATE.bets[ws.id]={amount:amt,cashedOut:false,cashMult:null,autoAt:autoAt||null,userId:me.id,panel:panel||1};
    saveDB();
    ws.emit('bet_placed',{amount:amt,balance:me.balance});
    io.emit('new_bet',{name:me.name,amount:amt,panel:panel||1});
  });

  ws.on('cash_out',()=>{if(me) processCashout(ws.id,false);});

  ws.on('daily_claim',()=>{
    if(!me)return;
    const now=Date.now(), last=me.lastDaily||0;
    if(now-last<86400000){ws.emit('error',{msg:'Already claimed today'});return;}
    me.balance+=10; me.lastDaily=now; saveDB();
    ws.emit('daily_ok',{amount:10,balance:me.balance});
  });

  ws.on('redeem_promo',({code})=>{
    if(!me)return;
    const PROMOS={'FREE50':50,'ASTRO10':10,'LUCKY25':25};
    const c=(code||'').toUpperCase();
    if(!PROMOS[c]){ws.emit('error',{msg:'Invalid promo'});return;}
    if((me.usedPromos||[]).includes(c)){ws.emit('error',{msg:'Already used'});return;}
    me.balance+=PROMOS[c]; me.usedPromos=[...(me.usedPromos||[]),c]; saveDB();
    ws.emit('promo_ok',{amount:PROMOS[c],balance:me.balance});
  });

  ws.on('chat',({msg})=>{
    if(!me||typeof msg!=='string'||msg.trim().length===0||msg.length>150)return;
    io.emit('chat',{name:me.name,msg:msg.trim().replace(/[<>]/g,''),bot:false,t:Date.now()});
  });

  ws.on('submit_withdrawal',({address,amount,network})=>{
    if(!me)return;
    const amt=parseFloat(amount);
    if(isNaN(amt)||amt<10){ws.emit('error',{msg:'Min withdrawal $10'});return;}
    if(amt>me.balance){ws.emit('error',{msg:'Insufficient balance'});return;}
    const req={id:uuid(),userId:me.id,name:me.name,address,amount:amt,network:network||'TRC-20',status:'pending',t:Date.now()};
    me.withdrawals=me.withdrawals||[]; me.withdrawals.unshift(req);
    DB.txLogs.unshift({...req,type:'withdrawal'}); saveDB();
    ws.emit('wd_submitted',{id:req.id});
  });

  ws.on('submit_deposit',({txid,amount})=>{
    if(!me)return;
    const req={id:uuid(),userId:me.id,name:me.name,txid,amount:parseFloat(amount)||0,status:'pending',t:Date.now()};
    me.deposits=me.deposits||[]; me.deposits.unshift(req);
    DB.txLogs.unshift({...req,type:'deposit'}); saveDB();
    ws.emit('dep_submitted',{id:req.id});
  });

  ws.on('get_history',()=>{
    if(!me)return;
    ws.emit('history',{txLog:(me.txLog||[]).slice(0,100),deposits:me.deposits||[],withdrawals:me.withdrawals||[]});
  });

  ws.on('get_leaderboard',()=>{
    const lb=Object.values(DB.users).filter(u=>!u.banned).sort((a,b)=>(b.wins||0)-(a.wins||0)).slice(0,20)
      .map(u=>({name:u.name,wins:u.wins||0,totalBets:u.totalBets||0,maxMult:u.maxMult||0}));
    ws.emit('leaderboard',lb);
  });

  ws.on('get_referral',()=>{
    if(!me)return;
    ws.emit('referral',{code:me.refCode,count:me.refCount||0,earned:me.refEarned||0,
      link:`${ws.handshake.headers.host||'astrocrash.repl.co'}?ref=${me.refCode}`});
  });

  // ═══ ADMIN SOCKET COMMANDS ═══
  ws.on('admin_login',({secret})=>{
    if(secret!==CFG.ADMIN_SECRET){ws.emit('admin_fail');return;}
    ws.data.isAdmin=true;
    ws.emit('admin_ok',buildAdminData());
  });

  ws.on('admin_get_stats',()=>{
    if(!ws.data.isAdmin)return;
    ws.emit('admin_stats',buildAdminData());
  });

  ws.on('admin_set_balance',({targetId,amount})=>{
    if(!ws.data.isAdmin)return;
    const u=DB.users[targetId]; if(!u)return;
    u.balance=parseFloat(amount); saveDB();
    const ts=io.sockets.sockets.get(sessions[targetId]);
    if(ts) ts.emit('balance_update',{balance:u.balance});
    ws.emit('admin_ack',{msg:`Balance set $${amount} for ${u.name}`});
  });

  ws.on('admin_adj_balance',({targetId,delta})=>{
    if(!ws.data.isAdmin)return;
    const u=DB.users[targetId]; if(!u)return;
    u.balance=Math.max(0,parseFloat((u.balance+(parseFloat(delta)||0)).toFixed(2))); saveDB();
    const ts=io.sockets.sockets.get(sessions[targetId]);
    if(ts) ts.emit('balance_update',{balance:u.balance});
    ws.emit('admin_ack',{msg:`Adjusted ${delta>0?'+':''}${delta} for ${u.name}`});
  });

  ws.on('admin_ban',({targetId,ban})=>{
    if(!ws.data.isAdmin)return;
    const u=DB.users[targetId]; if(!u)return;
    u.banned=!!ban; saveDB();
    if(ban){
      const ts=io.sockets.sockets.get(sessions[targetId]);
      if(ts){ts.emit('banned');ts.disconnect();}
    }
    ws.emit('admin_ack',{msg:`${u.name} ${ban?'banned':'unbanned'}`});
  });

  ws.on('admin_force_crash',({point})=>{
    if(!ws.data.isAdmin)return;
    const p=parseFloat(point);
    if(!isNaN(p)&&p>=1){GS.forceCrash=parseFloat(p.toFixed(2));ws.emit('admin_ack',{msg:`Next crash: ${p.toFixed(2)}×`});}
  });

  ws.on('admin_crash_now',()=>{
    if(!ws.data.isAdmin)return;
    if(STATE.phase==='running'){clearInterval(tickInterval);doCrash();}
  });

  ws.on('admin_set_speed',({growthBase})=>{
    if(!ws.data.isAdmin)return;
    const g=parseFloat(growthBase);
    if(!isNaN(g)&&g>0&&g<0.01){GS.growthBase=g;ws.emit('admin_ack',{msg:'Speed updated'});}
  });

  ws.on('admin_set_probs',({probs})=>{
    if(!ws.data.isAdmin)return;
    if(Array.isArray(probs)&&probs.length===5){GS.probs=probs.map(v=>Math.max(0,parseInt(v)||0));ws.emit('admin_ack',{msg:'Probs updated'});}
  });

  ws.on('admin_set_limits',({minBet,maxBet})=>{
    if(!ws.data.isAdmin)return;
    if(minBet>=0.01) GS.minBet=parseFloat(minBet);
    if(maxBet>=1)    GS.maxBet=parseFloat(maxBet);
    io.emit('limits_updated',{minBet:GS.minBet,maxBet:GS.maxBet});
    ws.emit('admin_ack',{msg:`Limits: $${GS.minBet}–$${GS.maxBet}`});
  });

  ws.on('admin_kill_switch',({active})=>{
    if(!ws.data.isAdmin)return;
    GS.killSwitch=!!active;
    io.emit('kill_switch',{active:GS.killSwitch});
    ws.emit('admin_ack',{msg:active?'Game PAUSED':'Game RESUMED'});
  });

  ws.on('admin_global_msg',({msg})=>{
    if(!ws.data.isAdmin)return;
    GS.globalMsg=msg||'';
    io.emit('global_msg',{msg:GS.globalMsg});
  });

  ws.on('admin_approve_wd',({wdId})=>{
    if(!ws.data.isAdmin)return;
    for(const u of Object.values(DB.users)){
      const wd=(u.withdrawals||[]).find(w=>w.id===wdId);
      if(wd){
        wd.status='approved'; u.balance=Math.max(0,parseFloat((u.balance-wd.amount).toFixed(2)));
        const tl=DB.txLogs.find(t=>t.id===wdId); if(tl) tl.status='approved';
        saveDB();
        const ts=io.sockets.sockets.get(sessions[u.id]);
        if(ts) ts.emit('wd_approved',{amount:wd.amount,balance:u.balance});
        ws.emit('admin_ack',{msg:`WD approved: $${wd.amount} to ${u.name}`});
        return;
      }
    }
  });

  ws.on('admin_reject_wd',({wdId})=>{
    if(!ws.data.isAdmin)return;
    for(const u of Object.values(DB.users)){
      const wd=(u.withdrawals||[]).find(w=>w.id===wdId);
      if(wd){wd.status='rejected';const tl=DB.txLogs.find(t=>t.id===wdId);if(tl)tl.status='rejected';saveDB();ws.emit('admin_ack',{msg:'WD rejected'});return;}
    }
  });

  ws.on('admin_approve_dep',({depId})=>{
    if(!ws.data.isAdmin)return;
    for(const u of Object.values(DB.users)){
      const dep=(u.deposits||[]).find(d=>d.id===depId);
      if(dep&&dep.status==='pending'){
        dep.status='approved'; u.balance=parseFloat((u.balance+dep.amount).toFixed(2));
        const tl=DB.txLogs.find(t=>t.id===depId); if(tl) tl.status='approved';
        saveDB();
        const ts=io.sockets.sockets.get(sessions[u.id]);
        if(ts) ts.emit('dep_approved',{amount:dep.amount,balance:u.balance});
        ws.emit('admin_ack',{msg:`Dep approved: $${dep.amount} for ${dep.name}`});
        return;
      }
    }
  });

  ws.on('admin_set_bots',({count})=>{
    if(!ws.data.isAdmin)return;
    GS.botCount=Math.max(0,Math.min(15,parseInt(count)||0));
    ws.emit('admin_ack',{msg:`Bots: ${GS.botCount}`});
  });

  ws.on('admin_reset_balances',()=>{
    if(!ws.data.isAdmin)return;
    Object.values(DB.users).forEach(u=>{if(!u.banned)u.balance=CFG.START_BAL;});
    saveDB(); ws.emit('admin_ack',{msg:'All demo balances reset'});
  });

  ws.on('admin_get_user_history',({targetId})=>{
    if(!ws.data.isAdmin)return;
    const u=DB.users[targetId]; if(!u)return;
    ws.emit('admin_user_history',{userId:targetId,name:u.name,txLog:(u.txLog||[]).slice(0,50)});
  });

  ws.on('disconnect',()=>{
    delete playerMetas[ws.id];
    if(me){if(sessions[me.id]===ws.id)delete sessions[me.id];saveDB();}
    broadcastLobby();
  });
});

// ─── HELPERS ──────────────────────────────────────────
function broadcastLobby() {
  const online=Object.values(DB.users).filter(u=>sessions[u.id]).length;
  const lb=Object.values(DB.users).filter(u=>!u.banned).sort((a,b)=>(b.wins||0)-(a.wins||0)).slice(0,10)
    .map(u=>({name:u.name,wins:u.wins||0,maxMult:u.maxMult||0}));
  io.emit('lobby',{online,leaderboard:lb});
}
setInterval(broadcastLobby, 15000);

function buildAdminData() {
  const onlineUsers=Object.values(DB.users).filter(u=>sessions[u.id]).map(u=>({
    id:u.id, name:u.name, balance:u.balance, totalBets:u.totalBets||0,
    wins:u.wins||0, losses:u.losses||0, maxMult:u.maxMult||0,
    banned:u.banned, refCount:u.refCount||0, refEarned:u.refEarned||0,
    ip:playerMetas[sessions[u.id]]?.ip||'—',
    online:true,
  }));
  const allUsers=Object.values(DB.users).map(u=>({
    id:u.id, name:u.name, balance:u.balance, totalBets:u.totalBets||0,
    wins:u.wins||0, losses:u.losses||0, maxMult:u.maxMult||0,
    banned:u.banned, refCount:u.refCount||0, refEarned:u.refEarned||0,
    online:!!sessions[u.id],
  }));
  const pendingWDs=Object.values(DB.users).flatMap(u=>(u.withdrawals||[]).filter(w=>w.status==='pending'));
  const pendingDeps=Object.values(DB.users).flatMap(u=>(u.deposits||[]).filter(d=>d.status==='pending'));
  const totalDeposits=DB.txLogs.filter(t=>t.type==='deposit'&&t.status==='approved').reduce((s,t)=>s+t.amount,0);
  const totalWithdrawals=DB.txLogs.filter(t=>t.type==='withdrawal'&&t.status==='approved').reduce((s,t)=>s+t.amount,0);
  return {
    onlineUsers, allUsers, pendingWDs, pendingDeps,
    houseProfit:parseFloat(houseProfit.toFixed(2)),
    totalBets:parseFloat(totalBets.toFixed(2)),
    totalDeposits:parseFloat(totalDeposits.toFixed(2)),
    totalWithdrawals:parseFloat(totalWithdrawals.toFixed(2)),
    totalRounds, onlineCount:io.sockets.sockets.size,
    phase:STATE.phase, mult:STATE.mult, roundNum:STATE.roundNum,
    settings:GS,
  };
}

// ─── ROUTES ───────────────────────────────────────────
app.get('/api/status',(req,res)=>res.json({phase:STATE.phase,mult:STATE.mult,round:STATE.roundNum,players:io.sockets.sockets.size,seedHash:STATE.seedHash}));
app.get('/api/verify/:seed',(req,res)=>{const h=crypto.createHash('sha256').update(req.params.seed).digest('hex');res.json({seed:req.params.seed,hash:h});});

// HIDDEN Admin portal route
app.get(CFG.ADMIN_ROUTE, (req,res) => {
  res.sendFile(path.join(__dirname,'public','admin-portal.html'));
});
// Block direct admin portal file access
app.get('/admin-portal.html',(req,res)=>res.status(404).send('Not found'));

// ─── START ────────────────────────────────────────────
server.listen(CFG.PORT,'0.0.0.0',()=>{
  console.log(`\n🚀 ASTRO CRASH PRO on :${CFG.PORT}`);
  console.log(`   Admin: http://localhost:${CFG.PORT}${CFG.ADMIN_ROUTE}`);
  console.log(`   Secret: ${CFG.ADMIN_SECRET}`);
  setTimeout(startBetting,1500);
});
process.on('uncaughtException',err=>{console.error('ERR:',err.message);clearTimeout(gameTimer);clearInterval(tickInterval);setTimeout(startBetting,3000);});
process.on('unhandledRejection',err=>{console.error('UNHANDLED:',err);});
