const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const P = require('pino');
const { ViberBot, normalizeNumber } = require('./viber-automation');
const { ExcelSession, EXCEL_FILE } = require('./excel-tracker');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));
app.use(express.json());

// ─── State ───────────────────────────────────────────────────────────────────
let waSocket = null;
let waReady = false;
let viberBot = null;
let viberReady = false;

let sendQueue = [];
let sendingActive = false;
let sendTimeout = null;
let sendIntervalMs = 10000;
let currentIndex = 0;
let excelSession = null;
let currentMessage = '';

// ─── WebSocket broadcast ─────────────────────────────────────────────────────
const wsClients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function log(text, type = 'info') {
  console.log(text);
  broadcast({ type: 'log', text, logType: type });
}

// ─── WhatsApp (Baileys — no browser needed) ───────────────────────────────────
async function initWhatsApp() {
  if (waSocket) {
    try { waSocket.end(); } catch (e) {}
    waSocket = null;
  }
  waReady = false;
  broadcast({ type: 'wa_connecting' });
  log('WhatsApp: starting up, please wait...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState('.wa_session');
    const { version } = await fetchLatestBaileysVersion();
    log(`WhatsApp: using version ${version.join('.')}`);

    waSocket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: P({ level: 'silent' }),
      browser: Browsers.windows('Chrome'),
      syncFullHistory: false,
    });

    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const img = await qrcode.toDataURL(qr);
        broadcast({ type: 'wa_qr', qr: img });
        log('WhatsApp: scan QR code with your phone');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          waReady = false;
          log('WhatsApp: logged out — reconnect to scan again', 'warn');
          broadcast({ type: 'wa_disconnected' });
        } else {
          log(`WhatsApp: connection closed (code ${statusCode || '?'}) — retrying in 5s...`, 'warn');
          setTimeout(() => initWhatsApp(), 5000);
        }
      } else if (connection === 'open') {
        waReady = true;
        log('WhatsApp: ready ✓', 'success');
        broadcast({ type: 'wa_ready' });
      }
    });

    waSocket.ev.on('creds.update', saveCreds);

  } catch (err) {
    log(`WhatsApp error: ${err.message}`, 'error');
  }
}

async function waCheckNumber(number) {
  try {
    const jid = normalizeNumber(number).replace('+', '') + '@s.whatsapp.net';
    const [result] = await waSocket.onWhatsApp(jid);
    return result?.exists || false;
  } catch {
    return false;
  }
}

async function waSend(number, message) {
  const jid = normalizeNumber(number).replace('+', '') + '@s.whatsapp.net';
  await waSocket.sendMessage(jid, { text: message });
}

// ─── Viber ────────────────────────────────────────────────────────────────────
function initViber() {
  if (viberBot) {
    viberBot.close().catch(() => {});
  }
  viberReady = false;

  viberBot = new ViberBot({
    onQR: (imgData) => {
      broadcast({ type: 'viber_qr', qr: imgData });
    },
    onReady: () => {
      viberReady = true;
      log('Viber: ready ✓', 'success');
      broadcast({ type: 'viber_ready' });
    },
    onLog: (text) => log(text),
    onDisconnected: () => {
      viberReady = false;
      log('Viber: disconnected', 'warn');
      broadcast({ type: 'viber_disconnected' });
    },
  });

  viberBot.init().catch(err => {
    log(`Viber init error: ${err.message}`, 'error');
  });

  broadcast({ type: 'viber_connecting' });
  log('Viber: opening browser, scan QR with Viber app...');
}

// ─── Message Queue ────────────────────────────────────────────────────────────
async function startSending({ contacts, message, intervalMs }) {
  if (sendingActive) return;

  sendIntervalMs = intervalMs || 10000;
  currentMessage = message;

  // Load Excel history and find previously contacted numbers
  log('Checking send history...');
  excelSession = new ExcelSession();
  await excelSession.init();
  const alreadyContacted = await excelSession.getPreviouslyContacted();

  // Build queue, marking already-contacted numbers
  const seen = new Set(); // deduplicate within this session
  sendQueue = contacts.map(({ name, number }) => {
    const n = normalizeNumber(number);
    if (seen.has(n)) return null; // duplicate in this batch
    seen.add(n);
    return {
      name: name || '',
      number: n,
      status: alreadyContacted.has(n) ? 'already_contacted' : 'pending',
    };
  }).filter(Boolean);

  const pending = sendQueue.filter(i => i.status === 'pending').length;
  const skipped = sendQueue.filter(i => i.status === 'already_contacted').length;

  if (alreadyContacted.size > 0) {
    log(`History: ${alreadyContacted.size} numbers previously contacted — ${skipped} in this list will be skipped`);
  }

  // Create new sheet in Excel
  const sheetName = await excelSession.startSession();
  log(`Excel: sheet "${sheetName}" created in messages-log.xlsx`);
  log(`Starting: ${pending} to send, ${skipped} already contacted (${sendQueue.length} total)`, 'info');

  currentIndex = 0;
  sendingActive = true;
  broadcast({ type: 'sending_started', total: sendQueue.length, pending, skipped });

  processNext();
}

function stopSending() {
  sendingActive = false;
  if (sendTimeout) clearTimeout(sendTimeout);
  sendTimeout = null;
  broadcast({ type: 'sending_stopped' });
  log('Sending stopped.');
}

async function processNext() {
  if (!sendingActive) return;

  if (currentIndex >= sendQueue.length) {
    sendingActive = false;
    broadcast({ type: 'sending_complete' });
    log('All done!', 'success');
    return;
  }

  const item = sendQueue[currentIndex];
  currentIndex++;

  const label = item.name ? `${item.name} (${item.number})` : item.number;

  // Already contacted — log to Excel and skip immediately, no delay
  if (item.status === 'already_contacted') {
    log(`↷ ${label} — already contacted before, skipping`, 'info');
    broadcast({ type: 'item_skipped', index: currentIndex - 1, number: item.number, name: item.name, reason: 'already_contacted' });
    if (excelSession) {
      await excelSession.logRow({ name: item.name, number: item.number, status: 'Already contacted', platform: null, message: currentMessage });
    }
    processNext();
    return;
  }

  broadcast({ type: 'sending_item', index: currentIndex - 1, number: item.number, name: item.name });
  log(`Processing ${label} (${currentIndex}/${sendQueue.length})...`);

  let sent = false;
  let platform = null;

  // 1. Try Viber first
  if (viberReady) {
    try {
      sent = await viberBot.sendMessage(item.number, currentMessage);
      if (sent) platform = 'Viber';
    } catch (e) {
      log(`Viber error: ${e.message}`, 'warn');
    }
  }

  // 2. Fallback to WhatsApp
  if (!sent && waReady) {
    try {
      const onWA = await waCheckNumber(item.number);
      if (onWA) {
        await waSend(item.number, currentMessage);
        sent = true;
        platform = 'WhatsApp';
      }
    } catch (e) {
      log(`WhatsApp error: ${e.message}`, 'warn');
    }
  }

  if (sent) {
    log(`✓ Sent via ${platform} to ${label}`, 'success');
    broadcast({ type: 'item_sent', index: currentIndex - 1, number: item.number, name: item.name, platform });
    if (excelSession) {
      await excelSession.logRow({ name: item.name, number: item.number, status: 'Sent', platform, message: currentMessage });
    }
  } else {
    log(`✗ ${label} — not on WhatsApp or Viber, skipped`, 'warn');
    broadcast({ type: 'item_skipped', index: currentIndex - 1, number: item.number, name: item.name, reason: 'not_found' });
    if (excelSession) {
      await excelSession.logRow({ name: item.name, number: item.number, status: 'Skipped', platform: null, message: currentMessage });
    }
  }

  if (sendingActive && currentIndex < sendQueue.length) {
    const nextItem = sendQueue[currentIndex];
    // No delay before already-contacted items
    if (nextItem && nextItem.status === 'already_contacted') {
      processNext();
    } else {
      broadcast({ type: 'next_in', seconds: sendIntervalMs / 1000 });
      sendTimeout = setTimeout(() => processNext(), sendIntervalMs);
    }
  } else {
    processNext();
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.post('/api/connect-whatsapp', (req, res) => {
  initWhatsApp();
  res.json({ ok: true });
});

app.post('/api/connect-viber', (req, res) => {
  if (process.env.PORT) {
    log('Viber is not supported on cloud servers — it only works when running the app locally on your PC. Use WhatsApp instead.', 'warn');
    return res.json({ ok: false });
  }
  initViber();
  res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
  const { contacts, message, intervalSeconds } = req.body;
  if (!contacts || !contacts.length || !message) return res.status(400).json({ error: 'contacts and message required' });
  if (!viberReady && !waReady) return res.status(400).json({ error: 'Connect at least one app first' });
  if (sendingActive) return res.status(400).json({ error: 'Already sending' });
  res.json({ ok: true });
  startSending({ contacts, message, intervalMs: (intervalSeconds || 10) * 1000 });
});

app.post('/api/stop', (req, res) => {
  stopSending();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ waReady, viberReady, sendingActive, queueLength: sendQueue.length, currentIndex });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'status', waReady, viberReady, sendingActive }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error('Unhandled error (server kept running):', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err?.message || err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n Auto-Messenger running at http://localhost:${PORT}\n`);
  console.log(' Open that URL in your browser to get started.\n');

  // Auto-reconnect WhatsApp if a saved session exists
  if (fs.existsSync('.wa_session')) {
    console.log(' Saved WhatsApp session found — reconnecting automatically...');
    initWhatsApp();
  }
});
