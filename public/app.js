// ─── Persistence ─────────────────────────────────────────────────────────────
function saveField(key, value) { try { localStorage.setItem(key, value); } catch {} }
function loadField(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }

window.addEventListener('DOMContentLoaded', () => {
  const msg = loadField('am_message');
  const contacts = loadField('am_contacts');
  const delay = loadField('am_delay');
  if (msg)      document.getElementById('message-input').value = msg;
  if (contacts) document.getElementById('numbers-input').value = contacts;
  if (delay)    document.getElementById('delay-input').value = delay;

  document.getElementById('message-input').addEventListener('input', e => saveField('am_message', e.target.value));
  document.getElementById('numbers-input').addEventListener('input', e => saveField('am_contacts', e.target.value));
  document.getElementById('delay-input').addEventListener('input', e => saveField('am_delay', e.target.value));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${location.host}`);
let total = 0;
let done = 0;
let countdownInterval = null;

ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  handle(msg);
});

ws.addEventListener('close', () => addLog('Connection to server lost. Refresh the page.', 'error'));

function handle(msg) {
  switch (msg.type) {

    // ── WhatsApp ──
    case 'wa_connecting':
      setStatus('wa', 'Connecting...', 'connecting');
      break;
    case 'wa_qr':
      showQR('wa', msg.qr);
      setStatus('wa', 'Scan QR code', 'connecting');
      break;
    case 'wa_authenticated':
      setStatus('wa', 'Authenticated...', 'connecting');
      break;
    case 'wa_ready':
      hideQR('wa');
      setStatus('wa', 'Connected ✓', 'ready');
      markConnected('wa');
      break;
    case 'wa_disconnected':
      setStatus('wa', 'Disconnected', '');
      markDisconnected('wa');
      break;

    // ── Viber ──
    case 'viber_connecting':
      setStatus('viber', 'Opening browser...', 'connecting');
      break;
    case 'viber_qr':
      showQR('viber', msg.qr);
      setStatus('viber', 'Scan QR code', 'connecting');
      break;
    case 'viber_ready':
      hideQR('viber');
      setStatus('viber', 'Connected ✓', 'ready');
      markConnected('viber');
      break;
    case 'viber_disconnected':
      setStatus('viber', 'Disconnected', '');
      markDisconnected('viber');
      break;

    // ── Queue / sending ──
    case 'sending_started':
      total = msg.total;
      done = 0;
      showProgress();
      updateProgress();
      setSendingUI(true);
      break;

    case 'sending_item':
      updateChip(msg.index, msg.number, 'sending');
      break;

    case 'item_sent': {
      done++;
      updateProgress();
      const label = msg.name ? `${msg.name} (${msg.platform})` : `${msg.number} (${msg.platform})`;
      const chipClass = msg.platform === 'Viber' ? 'sent-viber' : 'sent-wa';
      updateChip(msg.index, label, chipClass);
      break;
    }

    case 'item_skipped':
      done++;
      updateProgress();
      updateChip(msg.index, msg.number, 'skipped');
      break;

    case 'next_in':
      startCountdown(msg.seconds);
      break;

    case 'sending_stopped':
    case 'sending_complete':
      setSendingUI(false);
      clearCountdown();
      if (msg.type === 'sending_complete') {
        document.getElementById('next-timer').textContent = 'All done!';
      }
      break;

    // ── Log ──
    case 'log':
      addLog(msg.text, msg.logType);
      break;

    case 'status':
      if (msg.waReady)    { setStatus('wa', 'Connected ✓', 'ready');    markConnected('wa'); }
      if (msg.viberReady) { setStatus('viber', 'Connected ✓', 'ready'); markConnected('viber'); }
      break;
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function connectWhatsApp() {
  fetch('/api/connect-whatsapp', { method: 'POST' });
  document.getElementById('wa-connect-btn').disabled = true;
}

function connectViber() {
  fetch('/api/connect-viber', { method: 'POST' });
  document.getElementById('viber-connect-btn').disabled = true;
}

function parseContacts(raw) {
  return raw.split('\n').map(line => {
    line = line.trim();
    if (!line) return null;
    // Find phone number: last token that starts with + or is all digits (with optional dashes/spaces)
    const match = line.match(/^(.*?)([+]?\d[\d\s\-().]{6,})$/);
    if (match) {
      const name = match[1].replace(/[,\s]+$/, '').trim();
      const number = match[2].replace(/\s/g, '').trim();
      return { name, number };
    }
    return { name: '', number: line };
  }).filter(c => c && c.number.length > 3);
}

function startSending() {
  const contacts = parseContacts(document.getElementById('numbers-input').value);
  const message = document.getElementById('message-input').value.trim();
  const intervalSeconds = parseInt(document.getElementById('delay-input').value) || 10;

  if (!contacts.length) { alert('Please enter at least one contact.'); return; }
  if (!message) { alert('Please type a message.'); return; }

  // Clear results grid
  document.getElementById('results-grid').innerHTML = '';
  contacts.forEach((c, i) => {
    const chip = document.createElement('div');
    chip.className = 'result-chip';
    chip.id = `chip-${i}`;
    chip.textContent = c.name ? `${c.name} (${c.number})` : c.number;
    document.getElementById('results-grid').appendChild(chip);
  });

  fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contacts, message, intervalSeconds }),
  }).then(r => r.json()).then(d => {
    if (d.error) alert(d.error);
  });
}

function stopSending() {
  fetch('/api/stop', { method: 'POST' });
}

function clearLog() {
  document.getElementById('log-box').innerHTML = '';
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(platform, text, cls) {
  const el = document.getElementById(`${platform}-status`);
  el.textContent = text;
  el.className = 'status-badge ' + (cls || '');
}

function markConnected(platform) {
  const btn = document.getElementById(`${platform}-connect-btn`);
  btn.textContent = 'Connected';
  btn.className = 'connect-btn connected';
  btn.disabled = true;
}

function markDisconnected(platform) {
  const btn = document.getElementById(`${platform}-connect-btn`);
  btn.textContent = 'Reconnect';
  btn.className = 'connect-btn';
  btn.disabled = false;
}

function showQR(platform, src) {
  const area = document.getElementById(`${platform}-qr-area`);
  const img  = document.getElementById(`${platform}-qr-img`);
  area.style.display = 'flex';
  img.src = src;
}

function hideQR(platform) {
  document.getElementById(`${platform}-qr-area`).style.display = 'none';
}

function showProgress() {
  document.getElementById('progress-section').style.display = 'flex';
}

function updateProgress() {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-text').textContent = `${done} / ${total} sent`;
}

function updateChip(index, label, type) {
  const chip = document.getElementById(`chip-${index}`);
  if (!chip) return;
  chip.textContent = label;
  chip.className = `result-chip chip-${type}`;
}

function setSendingUI(active) {
  document.getElementById('start-btn').style.display = active ? 'none' : '';
  document.getElementById('stop-btn').style.display  = active ? '' : 'none';
  document.getElementById('start-btn').disabled = active;
}

function startCountdown(seconds) {
  clearCountdown();
  let remaining = seconds;
  const el = document.getElementById('next-timer');
  el.textContent = `Next in ${remaining}s...`;
  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearCountdown();
      el.textContent = 'Sending...';
    } else {
      el.textContent = `Next in ${remaining}s...`;
    }
  }, 1000);
}

function clearCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
}

function addLog(text, type) {
  const box = document.getElementById('log-box');
  const now = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type || 'info'}`;
  entry.innerHTML = `<span class="log-time">${now}</span>${escapeHtml(text)}`;
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
