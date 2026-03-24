/**
 * ============================================================
 *  MODULAR AI WHATSAPP BOT — MVP SKELETON
 *  Stack : Node.js + Baileys + Claude (Anthropic) / GPT
 *  Auth  : Pairing Code (no QR scan needed — Render-friendly)
 * ============================================================
 */

'use strict';

require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino     = require('pino');
const path     = require('path');

// ── Core Services ────────────────────────────────────────────
const RouterEngine   = require('./src/core/RouterEngine');
const MemoryManager  = require('./src/core/MemoryManager');
const MediaHandler   = require('./src/core/MediaHandler');
const SessionManager = require('./src/core/SessionManager');
const Logger         = require('./src/utils/logger');

// ── Config ───────────────────────────────────────────────────
const PHONE_NUMBER = '94718890862';         // no + or spaces
const AUTH_FOLDER  = path.resolve(__dirname, 'auth_info_baileys');

// ── Boot ─────────────────────────────────────────────────────
async function startBot() {
  Logger.info('🚀 Booting Modular AI WhatsApp Bot (Pairing Code Mode)...');

  // ── 1. Load / create persistent session ────────────────────
  //   If auth_info_baileys/ already has valid creds, no pairing needed.
  //   The folder persists on Render disk — pair only ONCE.
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  // ── 2. Create socket ─────────────────────────────────────────
  //   printQRInTerminal: false  → pairing code used instead
  const sock = makeWASocket({
    logger            : pino({ level: 'silent' }),
    auth              : {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal : false,                     // ← QR disabled
    mobile            : false,
    getMessage        : async () => ({ conversation: '' }),
  });

  // ── 3. Persist credentials on every update ─────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── 4. Request Pairing Code (only if not yet registered) ───
  //   state.creds.registered is true once you've successfully paired.
  //   After first pair this block is permanently skipped.
  if (!state.creds.registered) {
    // Small delay — socket needs to handshake before requesting code
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER);

      // Print code prominently so it's easy to find in Render logs
      const formatted = code.match(/.{1,4}/g).join('-');   // e.g. ABCD-EFGH
      console.log('\n');
      console.log('╔══════════════════════════════════════════╗');
      console.log('║                                          ║');
      console.log(`║   🚀 YOUR PAIRING CODE:  ${formatted}    ║`);
      console.log('║                                          ║');
      console.log('║   1. Open WhatsApp on your phone         ║');
      console.log('║   2. Settings → Linked Devices           ║');
      console.log('║   3. Link a Device → "Pair with code"    ║');
      console.log('║   4. Enter the 8-digit code above ☝️      ║');
      console.log('║                                          ║');
      console.log('╚══════════════════════════════════════════╝');
      console.log('\n');

      Logger.info(`🔑 Pairing code requested for +${PHONE_NUMBER}`);
    } catch (err) {
      Logger.error('❌ Failed to request pairing code:', err.message);
      Logger.warn('Retrying full restart in 10 seconds...');
      setTimeout(startBot, 10_000);
      return;
    }
  } else {
    Logger.info(`✅ Session already registered for +${PHONE_NUMBER} — skipping pairing.`);
  }

  // ── 5. Connection State Machine ──────────────────────────────
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {

    // Safety net: if QR ever surfaces (shouldn't), log and ignore
    if (qr) {
      Logger.warn('⚠️  QR surfaced — ignoring (pairing code mode is active).');
    }

    if (connection === 'close') {
      const statusCode  = (lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      Logger.warn(`🔌 Connection closed. Status: ${statusCode}. LoggedOut: ${isLoggedOut}`);

      if (isLoggedOut) {
        // Credentials invalidated — operator must re-pair
        Logger.error('🚨 Logged out! Delete auth_info_baileys/ and redeploy to re-pair.');
        process.exit(1);                           // Render auto-restarts the service
      } else {
        // Transient disconnect — reconnect with a small backoff
        Logger.info('♻️  Reconnecting in 5 seconds...');
        setTimeout(startBot, 5_000);
      }

    } else if (connection === 'open') {
      Logger.info('✅ WhatsApp connection OPEN — Bot is live!');
    } else if (connection === 'connecting') {
      Logger.info('🔄 Connecting to WhatsApp...');
    }
  });

  // ── 6. Incoming Message Handler ──────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;    // ignore messages sent by this bot
      if (!msg.message)   continue;    // ignore protocol / empty events

      try {
        await handleIncomingMessage(sock, msg);
      } catch (err) {
        Logger.error('❌ Message handling error:', err);
      }
    }
  });
}

// ── Core Message Pipeline ─────────────────────────────────────
async function handleIncomingMessage(sock, msg) {
  const jid      = msg.key.remoteJid;
  const isGroup  = jid.endsWith('@g.us');
  const senderId = isGroup ? msg.key.participant : jid;

  // 1. Extract content (text / media / audio)
  const content = await MediaHandler.extractContent(msg);
  if (!content) return;

  Logger.info(`📩 [${senderId}] type=${content.type} | "${content.text ?? '[media]'}"`);

  // 2. Session & Memory hydration
  const session = await SessionManager.getOrCreate(senderId);
  const history = await MemoryManager.getHistory(senderId);   // last 15 turns

  // 3. Typing indicator
  await sock.sendPresenceUpdate('composing', jid);

  // 4. Route through LLM Brain
  const routerResult = await RouterEngine.route({
    userMessage : content,
    history,
    session,
    senderId,
  });

  // 5. Execute the selected module
  const reply = await routerResult.execute();

  // 6. Persist this exchange to memory
  await MemoryManager.append(senderId, {
    role   : 'user',
    content: content.text ?? `[${content.type}]`,
  });
  await MemoryManager.append(senderId, {
    role   : 'assistant',
    content: reply.text ?? `[${reply.type}]`,
  });

  // 7. Send reply
  await sendReply(sock, jid, reply);
}

// ── Polymorphic Reply Sender ──────────────────────────────────
async function sendReply(sock, jid, reply) {
  switch (reply.type) {

    case 'text':
      await sock.sendMessage(jid, { text: reply.text });
      break;

    case 'image':
      await sock.sendMessage(jid, {
        image  : reply.buffer,
        caption: reply.caption ?? '',
      });
      break;

    case 'audio':
      await sock.sendMessage(jid, {
        audio   : reply.buffer,
        mimetype: 'audio/mp4',
        ptt     : true,
      });
      break;

    case 'document':
      await sock.sendMessage(jid, {
        document : reply.buffer,
        mimetype : reply.mimetype,
        fileName : reply.fileName,
      });
      break;

    case 'buttons':
      await sock.sendMessage(jid, {
        text   : reply.text,
        buttons: reply.buttons,
        footer : '🤖 Powered by AI',
      });
      break;

    default:
      await sock.sendMessage(jid, {
        text: reply.text ?? '⚠️ Unknown response type.',
      });
  }
}

// ── Entrypoint ───────────────────────────────────────────────
startBot().catch((err) => {
  Logger.error('💥 Fatal boot error:', err);
  process.exit(1);
});
