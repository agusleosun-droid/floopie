/**
 * ══════════════════════════════════════════════
 *   OCR WA SENDER — server.js
 *   3 WhatsApp Client via whatsapp-web.js
 * ══════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ──────────────────────────────────────────────
//   AUTO-DETECT CHROMIUM PATH
// ──────────────────────────────────────────────
function findChromium() {
  // Kalau sudah di-set via env, pakai itu
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      console.log(`[Chromium] Using env path: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
  }
  // Cari di PATH sistem
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const name of candidates) {
    try {
      const p = execSync(`which ${name} 2>/dev/null`).toString().trim();
      if (p && fs.existsSync(p)) {
        console.log(`[Chromium] Found at: ${p}`);
        return p;
      }
    } catch(e) {}
  }
  // Cari di nix store
  try {
    const nixPath = execSync(`find /nix/store -name "chromium" -type f 2>/dev/null | grep -v sandbox | head -1`).toString().trim();
    if (nixPath && fs.existsSync(nixPath)) {
      console.log(`[Chromium] Found in nix store: ${nixPath}`);
      return nixPath;
    }
  } catch(e) {}

  console.warn('[Chromium] Not found! Will use puppeteer bundled chromium');
  return undefined;
}

const CHROMIUM_PATH = findChromium();

// ──────────────────────────────────────────────
//   STATE: 3 WA Clients
// ──────────────────────────────────────────────
const WA_COUNT = 3;
const clients = {};
const clientState = {};
const qrExpireTimers = {};
const reinitTimers = {};

const LABELS = { 1:'WhatsApp 1', 2:'WhatsApp 2', 3:'WhatsApp 3' };
const QR_TTL = 60000;

// ──────────────────────────────────────────────
//   HELPERS
// ──────────────────────────────────────────────
function clearQR(id) {
  if (clientState[id]) clientState[id].qrDataUrl = null;
  if (qrExpireTimers[id]) { clearTimeout(qrExpireTimers[id]); qrExpireTimers[id] = null; }
}

function scheduleReinit(id, delay = 3000) {
  if (reinitTimers[id]) return;
  reinitTimers[id] = setTimeout(() => {
    reinitTimers[id] = null;
    initClient(id);
  }, delay);
}

// ──────────────────────────────────────────────
//   INIT CLIENT
// ──────────────────────────────────────────────
async function initClient(id) {
  if (clients[id]) {
    try { await clients[id].destroy(); } catch(e) {}
    clients[id] = null;
  }

  console.log(`[WA${id}] Initializing...`);
  clientState[id] = {
    status: 'loading',
    qrDataUrl: null,
    label: LABELS[id],
    phoneNumber: null,
    pushname: null,
  };

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=256',
    ],
  };

  if (CHROMIUM_PATH) {
    puppeteerConfig.executablePath = CHROMIUM_PATH;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `wa-client-${id}` }),
    puppeteer: puppeteerConfig,
  });

  client.on('qr', async (qr) => {
    console.log(`[WA${id}] QR received`);
    try {
      clearQR(id);
      const dataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
      clientState[id].status = 'qr';
      clientState[id].qrDataUrl = dataUrl;
      qrExpireTimers[id] = setTimeout(() => {
        if (clientState[id]?.status === 'qr') {
          clientState[id].qrDataUrl = null;
          console.log(`[WA${id}] QR expired`);
        }
      }, QR_TTL);
    } catch (e) {
      console.error(`[WA${id}] QR error:`, e.message);
    }
  });

  client.on('ready', () => {
    console.log(`[WA${id}] Ready! ✓`);
    clearQR(id);
    const info = client.info;
    clientState[id].status = 'ready';
    clientState[id].phoneNumber = info?.wid?.user || null;
    clientState[id].pushname = info?.pushname || null;
  });

  client.on('auth_failure', async (msg) => {
    console.error(`[WA${id}] Auth failure:`, msg);
    clearQR(id);
    clientState[id].status = 'disconnected';
    try { await client.destroy(); } catch(e) {}
    scheduleReinit(id, 3000);
  });

  client.on('disconnected', async (reason) => {
    console.warn(`[WA${id}] Disconnected: ${reason}`);
    clearQR(id);
    clientState[id].status = 'disconnected';
    clientState[id].phoneNumber = null;
    clientState[id].pushname = null;
    try { await client.destroy(); } catch(e) {}
    scheduleReinit(id, 3000);
  });

  client.initialize();
  clients[id] = client;
}

// Inisialisasi semua 3 WA dengan jeda 5 detik agar tidak OOM
for (let i = 1; i <= WA_COUNT; i++) {
  setTimeout(() => initClient(i), (i - 1) * 5000);
}

// ──────────────────────────────────────────────
//   HEALTH CHECK: deteksi sesi mati setiap 30 detik
// ──────────────────────────────────────────────
setInterval(async () => {
  for (let i = 1; i <= WA_COUNT; i++) {
    if (clientState[i]?.status !== 'ready') continue;
    try {
      // Coba ping WA — kalau gagal berarti sesi mati
      const state = await clients[i].getState();
      if (!state) throw new Error('No state');
    } catch(e) {
      console.warn(`[WA${i}] Health check failed: ${e.message} — reinitializing`);
      clientState[i].status = 'disconnected';
      clearQR(i);
      try { await clients[i].destroy(); } catch(_) {}
      scheduleReinit(i, 2000);
    }
  }
}, 30000);

// ──────────────────────────────────────────────
//   API ENDPOINTS
// ──────────────────────────────────────────────

app.get('/api/wa/all-status', (req, res) => {
  const result = {};
  for (let i = 1; i <= WA_COUNT; i++) {
    const s = clientState[i] || {};
    result[i] = {
      id: i,
      label: LABELS[i],
      status: s.status || 'loading',
      phoneNumber: s.phoneNumber,
      pushname: s.pushname,
    };
  }
  res.json(result);
});

app.get('/api/wa/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  if (!clientState[id]) return res.status(404).json({ error: 'WA not found' });
  const s = clientState[id];
  res.json({ id, label: LABELS[id], status: s.status, phoneNumber: s.phoneNumber, pushname: s.pushname });
});

app.get('/api/wa/:id/qr', (req, res) => {
  const id = parseInt(req.params.id);
  if (!clientState[id]) return res.status(404).json({ error: 'WA not found' });
  const s = clientState[id];
  if (s.status !== 'qr' || !s.qrDataUrl) return res.json({ status: s.status, qr: null });
  res.json({ status: 'qr', qr: s.qrDataUrl });
});

app.get('/api/wa/:id/groups', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clients[id] || clientState[id]?.status !== 'ready')
    return res.status(400).json({ error: 'WA not ready' });
  try {
    await sleep(2000);
    const chats = await clients[id].getChats();
    console.log(`[WA${id}] Total chats: ${chats.length}, groups: ${chats.filter(c=>c.isGroup).length}`);
    const groups = chats
      .filter(c => c.isGroup)
      .map(c => ({ id: c.id._serialized, name: c.name, participantCount: c.participants?.length || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ groups });
  } catch (e) {
    console.error(`[WA${id}] Groups error: ${e.message}`);
    // Detached frame = Chromium crash, reinit
    if (e.message.includes('detached') || e.message.includes('Frame') || e.message.includes('Session closed')) {
      console.log(`[WA${id}] Chromium crashed, reinitializing...`);
      clientState[id].status = 'disconnected';
      scheduleReinit(id, 1000);
      return res.status(503).json({ error: 'WA restart, silakan tunggu 15 detik lalu coba lagi' });
    }
    res.status(500).json({ error: e.message });
  }
});

// Debug: cek raw chats
app.get('/api/wa/:id/debug', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clients[id] || clientState[id]?.status !== 'ready')
    return res.status(400).json({ error: 'WA not ready' });
  try {
    const chats = await clients[id].getChats();
    res.json({
      total: chats.length,
      groups: chats.filter(c => c.isGroup).length,
      sample: chats.slice(0, 5).map(c => ({ name: c.name, isGroup: c.isGroup }))
    });
  } catch(e) {
    if (e.message.includes('detached') || e.message.includes('Frame')) {
      clientState[id].status = 'disconnected';
      scheduleReinit(id, 1000);
      return res.status(503).json({ error: 'Chromium crashed, reinitializing...' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/wa/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clients[id] || clientState[id]?.status !== 'ready')
    return res.status(400).json({ error: 'WA not ready' });

  const { groupId, messages, delay = 800 } = req.body;
  if (!groupId || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'groupId dan messages diperlukan' });

  const safeDelay = Math.min(Math.max(parseInt(delay) || 800, 500), 5000);
  const results = [];

  for (let i = 0; i < messages.length; i++) {
    try {
      await clients[id].sendMessage(groupId, messages[i]);
      results.push({ index: i, message: messages[i], status: 'sent' });
      console.log(`[WA${id}] Sent [${i+1}/${messages.length}]: ${messages[i]}`);
    } catch (e) {
      results.push({ index: i, message: messages[i], status: 'error', error: e.message });
    }
    if (i < messages.length - 1) await sleep(safeDelay);
  }

  const sent = results.filter(r => r.status === 'sent').length;
  res.json({ success: true, total: messages.length, sent, errors: results.length - sent, results });
});

app.post('/api/wa/:id/restart', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clients[id]) return res.status(404).json({ error: 'WA not found' });
  try { await clients[id].destroy(); } catch(e) {}
  setTimeout(() => initClient(id), 1000);
  res.json({ success: true, message: `WA${id} restarting...` });
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✓ Server running on port ${PORT}`);
  console.log(`  ✓ Chromium: ${CHROMIUM_PATH || 'bundled'}`);
  console.log('  ✓ Initializing 3 WA clients (staggered 5s each)...\n');
});
