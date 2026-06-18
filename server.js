const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const puppeteer = require('puppeteer');
const { ViberBot, normalizeNumber } = require('./viber-automation');

// Resolve the Chrome binary path from our puppeteer install
let CHROME_PATH;
try {
  CHROME_PATH = puppeteer.executablePath();
} catch (e) {
  CHROME_PATH = undefined;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));
app.use(express.json());

// ─── State ───────────────────────────────────────────────────────────────────
let waClient = null;
let waReady = false;
let viberBot = null;
let viberReady = false;

let sendQueue = [];
let sendingActive = false;
let sendTimeout = null;
let sendIntervalMs = 10000;
let currentIndex = 0;

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

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
function initWhatsApp() {
  if (waClient) {
    waClient.destroy().catch(() => {});
  }
  waReady = false;

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wa_session' }),
    puppeteer: {
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
    },
  });

  waClient.on('qr', async (qr) => {
    log('WhatsApp: scan QR code with your phone');
    const img = await qrcode.toDataURL(qr);
    broadcast({ type: 'wa_qr', qr: img });
  });

  waClient.on('authenticated', () => {
    log('WhatsApp: authenticated');
    broadcast({ type: 'wa_authenticated' });
  });

  waClient.on('ready', () => {
    waReady = true;
    log('WhatsApp: ready ✓', 'success');
    broadcast({ type: 'wa_ready' });
  });

  waClient.on('disconnected', (reason) => {
    waReady = false;
    log(`WhatsApp: disconnected (${reason})`, 'warn');
    broadcast({ type: 'wa_disconnected' });
  });

  waClient.initialize().catch(err => {
    log(`WhatsApp init error: ${err.message}`, 'error');
  });

  broadcast({ type: 'wa_connecting' });
  log('WhatsApp: starting up, please wait...');
}

async function waCheckNumber(number) {
  try {
    const normalized = normalizeNumber(number).replace('+', '');
    return await waClient.isRegisteredUser(normalized + '@c.us');
  } catch {
    return false;
  }
}

async function waSend(number, message) {
  const normalized = normalizeNumber(number).replace('+', '');
  await waClient.sendMessage(normalized + '@c.us', message);
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
function startSending({ numbers, message, intervalMs }) {
  if (sendingActive) return;

  sendQueue = numbers
    .map(n => n.trim())
    .filter(n => n.length > 0)
    .map(n => ({ number: n, status: 'pending' }));

  sendIntervalMs = intervalMs || 10000;
  currentIndex = 0;
  sendingActive = true;

  log(`Starting: ${sendQueue.length} numbers, ${sendIntervalMs / 1000}s between each`, 'info');
  broadcast({ type: 'sending_started', total: sendQueue.length });

  processNext(message);
}

function stopSending() {
  sendingActive = false;
  if (sendTimeout) clearTimeout(sendTimeout);
  sendTimeout = null;
  broadcast({ type: 'sending_stopped' });
  log('Sending stopped.');
}

async function processNext(message) {
  if (!sendingActive) return;

  if (currentIndex >= sendQueue.length) {
    sendingActive = false;
    broadcast({ type: 'sending_complete' });
    log('All messages sent!', 'success');
    return;
  }

  const item = sendQueue[currentIndex];
  currentIndex++;

  broadcast({ type: 'sending_item', index: currentIndex - 1, number: item.number });
  log(`Processing ${item.number} (${currentIndex}/${sendQueue.length})...`);

  let sent = false;
  let platform = null;

  // 1. Try Viber first
  if (viberReady) {
    try {
      sent = await viberBot.sendMessage(item.number, message);
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
        await waSend(item.number, message);
        sent = true;
        platform = 'WhatsApp';
      }
    } catch (e) {
      log(`WhatsApp error: ${e.message}`, 'warn');
    }
  }

  if (sent) {
    log(`✓ Sent via ${platform} to ${item.number}`, 'success');
    broadcast({ type: 'item_sent', index: currentIndex - 1, number: item.number, platform });
  } else {
    log(`✗ Skipped ${item.number} — not on Viber or WhatsApp`, 'warn');
    broadcast({ type: 'item_skipped', index: currentIndex - 1, number: item.number });
  }

  // Schedule next
  if (sendingActive && currentIndex < sendQueue.length) {
    broadcast({ type: 'next_in', seconds: sendIntervalMs / 1000 });
    sendTimeout = setTimeout(() => processNext(message), sendIntervalMs);
  } else {
    processNext(message);
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.post('/api/connect-whatsapp', (req, res) => {
  initWhatsApp();
  res.json({ ok: true });
});

app.post('/api/connect-viber', (req, res) => {
  initViber();
  res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
  const { numbers, message, intervalSeconds } = req.body;
  if (!numbers || !message) return res.status(400).json({ error: 'numbers and message required' });
  if (!viberReady && !waReady) return res.status(400).json({ error: 'Connect at least one app first' });
  startSending({ numbers, message, intervalMs: (intervalSeconds || 10) * 1000 });
  res.json({ ok: true });
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

  // Send current status on connect
  ws.send(JSON.stringify({ type: 'status', waReady, viberReady, sendingActive }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n Auto-Messenger running at http://localhost:${PORT}\n`);
  console.log(' Open that URL in your browser to get started.\n');
});
