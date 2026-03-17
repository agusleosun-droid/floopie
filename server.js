/**
 * ══════════════════════════════════════════════
 *   OCR WA SENDER — server.js v2
 *   Baileys (no Chromium) + Multiple User
 *   Dynamic add/remove WA accounts
 * ══════════════════════════════════════════════
 */

import express   from 'express';
import cors      from 'cors';
import qrcode    from 'qrcode';
import path      from 'path';
import fs        from 'fs';
import P         from 'pino';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';

// ESM tidak punya __dirname — definisikan manual
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ──────────────────────────────────────────────
//   STORAGE
// ──────────────────────────────────────────────
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const CONFIG_FILE  = path.join(__dirname, 'wa-config.json');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Load / inisialisasi config WA
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {}
  }
  // Default 3 WA
  const cfg = {
    accounts: [
      { id: 1, label: 'WhatsApp 1' },
      { id: 2, label: 'WhatsApp 2' },
      { id: 3, label: 'WhatsApp 3' },
    ],
    nextId: 4,
  };
  saveConfig(cfg);
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ──────────────────────────────────────────────
//   STATE
// ──────────────────────────────────────────────
const sockets      = {};   // baileys socket per id
const clientState  = {};   // status per id
const qrTimers     = {};   // QR expire timer
const reinitTimers = {};   // guard double reinit
const QR_TTL       = 60000;

const logger = P({ level: 'silent' });

function defaultState(id, label) {
  return { status: 'idle', qrDataUrl: null, label: label || `WhatsApp ${id}`, phoneNumber: null, pushname: null };
}

// Init state semua account dari config
config.accounts.forEach(acc => {
  clientState[acc.id] = defaultState(acc.id, acc.label);
});

// ──────────────────────────────────────────────
//   HELPERS
// ──────────────────────────────────────────────
function clearQR(id) {
  if (clientState[id]) clientState[id].qrDataUrl = null;
  if (qrTimers[id]) { clearTimeout(qrTimers[id]); qrTimers[id] = null; }
}

function scheduleReinit(id, delay = 5000) {
  if (reinitTimers[id]) return;
  reinitTimers[id] = setTimeout(() => {
    reinitTimers[id] = null;
    startClient(id);
  }, delay);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getLabel(id) {
  const acc = config.accounts.find(a => a.id === id);
  return acc?.label || `WhatsApp ${id}`;
}

// ──────────────────────────────────────────────
//   START CLIENT (Baileys)
// ──────────────────────────────────────────────
async function startClient(id) {
  // Destroy socket lama
  if (sockets[id]) {
    try { sockets[id].end(); } catch(e) {}
    sockets[id] = null;
  }

  const label = getLabel(id);
  console.log(`[WA${id}] Starting (${label})...`);
  clientState[id] = defaultState(id, label);
  clientState[id].status = 'loading';

  const sessionDir = path.join(SESSIONS_DIR, `wa-${id}`);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  } catch(e) {
    console.error(`[WA${id}] Auth state error:`, e.message);
    clientState[id].status = 'idle';
    return;
  }

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['OCR WA Sender', 'Chrome', '120.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR baru tersedia
    if (qr) {
      console.log(`[WA${id}] QR received`);
      try {
        clearQR(id);
        const dataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
        clientState[id].status = 'qr';
        clientState[id].qrDataUrl = dataUrl;
        qrTimers[id] = setTimeout(() => {
          if (clientState[id]?.status === 'qr') {
            clientState[id].qrDataUrl = null;
            console.log(`[WA${id}] QR expired`);
          }
        }, QR_TTL);
      } catch(e) { console.error(`[WA${id}] QR error:`, e.message); }
    }

    // Terhubung
    if (connection === 'open') {
      console.log(`[WA${id}] Ready! ✓`);
      clearQR(id);
      clientState[id].status = 'ready';
      try {
        const user = sock.user;
        if (user) {
          clientState[id].phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net','');
          clientState[id].pushname = user.name || '';
        }
      } catch(e) {}
    }

    // Terputus
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.warn(`[WA${id}] Disconnected (code: ${code})`);
      clearQR(id);
      clientState[id].status = 'idle';
      clientState[id].phoneNumber = null;
      clientState[id].pushname = null;

      // Logout paksa → hapus session
      if (code === DisconnectReason.loggedOut) {
        console.log(`[WA${id}] Logged out — clearing session`);
        try {
          fs.rmSync(path.join(SESSIONS_DIR, `wa-${id}`), { recursive: true, force: true });
        } catch(e) {}
        clientState[id].status = 'idle';
        sockets[id] = null;
        return; // tidak reinit otomatis
      }

      // Error lain → reinit otomatis
      if (code !== DisconnectReason.loggedOut) {
        scheduleReinit(id, 5000);
      }
    }
  });

  sockets[id] = sock;
}

// ──────────────────────────────────────────────
//   HEALTH CHECK tiap 60 detik
// ──────────────────────────────────────────────
setInterval(() => {
  config.accounts.forEach(async acc => {
    const id = acc.id;
    if (clientState[id]?.status !== 'ready') return;
    try {
      if (!sockets[id] || !sockets[id].user) throw new Error('No user');
    } catch(e) {
      console.warn(`[WA${id}] Health check failed — marking idle`);
      clientState[id].status = 'idle';
      clientState[id].phoneNumber = null;
      clientState[id].pushname = null;
      clearQR(id);
    }
  });
}, 60000);

// ══════════════════════════════════════════════
//   API ENDPOINTS
// ══════════════════════════════════════════════

// Status semua WA
app.get('/api/wa/all-status', (req, res) => {
  const result = {};
  config.accounts.forEach(acc => {
    const s = clientState[acc.id] || defaultState(acc.id, acc.label);
    result[acc.id] = {
      id: acc.id,
      label: acc.label,
      status: s.status,
      phoneNumber: s.phoneNumber,
      pushname: s.pushname,
    };
  });
  res.json(result);
});

// Status 1 WA
app.get('/api/wa/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  const s = clientState[id];
  if (!s) return res.status(404).json({ error: 'WA not found' });
  res.json({ id, label: getLabel(id), status: s.status, phoneNumber: s.phoneNumber, pushname: s.pushname });
});

// Activate WA (lazy start)
app.post('/api/wa/:id/activate', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clientState[id]) return res.status(404).json({ error: 'WA not found' });
  const status = clientState[id].status;
  if (status === 'ready') return res.json({ status: 'ready' });
  if (status === 'loading' || status === 'qr') return res.json({ status });
  await startClient(id);
  res.json({ status: 'loading' });
});

// QR
app.get('/api/wa/:id/qr', (req, res) => {
  const id = parseInt(req.params.id);
  const s = clientState[id];
  if (!s) return res.status(404).json({ error: 'WA not found' });
  if (s.status !== 'qr' || !s.qrDataUrl) return res.json({ status: s.status, qr: null });
  res.json({ status: 'qr', qr: s.qrDataUrl });
});

// Grup — retry loop sampai dapat
app.get('/api/wa/:id/groups', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!sockets[id] || clientState[id]?.status !== 'ready')
    return res.status(400).json({ error: 'WA not ready' });
  try {
    // Retry max 5x tiap 2 detik
    let groupMap = {};
    for (let attempt = 1; attempt <= 5; attempt++) {
      await sleep(2000);
      try {
        groupMap = await sockets[id].groupFetchAllParticipating();
        const count = Object.keys(groupMap).length;
        console.log(`[WA${id}] Attempt ${attempt}: ${count} groups`);
        if (count > 0) break;
      } catch(e) {
        console.warn(`[WA${id}] getGroups attempt ${attempt} error: ${e.message}`);
        if (attempt === 5) throw e;
      }
    }

    const groups = Object.entries(groupMap).map(([jid, g]) => ({
      id: jid,
      name: g.subject || jid,
      participantCount: g.participants?.length || 0,
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ groups });
  } catch(e) {
    console.error(`[WA${id}] Groups error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Kirim pesan
app.post('/api/wa/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!sockets[id] || clientState[id]?.status !== 'ready')
    return res.status(400).json({ error: 'WA not ready' });

  const { groupId, messages, delay = 800 } = req.body;
  if (!groupId || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'groupId dan messages diperlukan' });

  const safeDelay = Math.min(Math.max(parseInt(delay) || 800, 500), 5000);
  const results = [];

  for (let i = 0; i < messages.length; i++) {
    try {
      await sockets[id].sendMessage(groupId, { text: messages[i] });
      results.push({ index: i, message: messages[i], status: 'sent' });
      console.log(`[WA${id}] Sent [${i+1}/${messages.length}]: ${messages[i]}`);
    } catch(e) {
      results.push({ index: i, message: messages[i], status: 'error', error: e.message });
      console.error(`[WA${id}] Send error: ${e.message}`);
    }
    if (i < messages.length - 1) await sleep(safeDelay);
  }

  const sent = results.filter(r => r.status === 'sent').length;
  res.json({ success: true, total: messages.length, sent, errors: results.length - sent, results });
});

// Restart / reset WA
app.post('/api/wa/:id/restart', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clientState[id]) return res.status(404).json({ error: 'WA not found' });
  if (sockets[id]) { try { sockets[id].end(); } catch(e) {} sockets[id] = null; }
  clearQR(id);
  clientState[id].status = 'idle';
  clientState[id].phoneNumber = null;
  clientState[id].pushname = null;
  res.json({ success: true });
});

// ── TAMBAH WA BARU ──
app.post('/api/wa/add', (req, res) => {
  const { label } = req.body;
  const id = config.nextId++;
  const newLabel = label || `WhatsApp ${id}`;
  config.accounts.push({ id, label: newLabel });
  saveConfig(config);
  clientState[id] = defaultState(id, newLabel);
  console.log(`[WA${id}] Added: ${newLabel}`);
  res.json({ success: true, id, label: newLabel });
});

// ── HAPUS WA ──
app.delete('/api/wa/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!config.accounts.find(a => a.id === id))
    return res.status(404).json({ error: 'WA not found' });

  // Stop socket
  if (sockets[id]) { try { sockets[id].end(); } catch(e) {} sockets[id] = null; }
  clearQR(id);
  delete clientState[id];

  // Hapus session
  try { fs.rmSync(path.join(SESSIONS_DIR, `wa-${id}`), { recursive: true, force: true }); } catch(e) {}

  // Update config
  config.accounts = config.accounts.filter(a => a.id !== id);
  saveConfig(config);
  console.log(`[WA${id}] Removed`);
  res.json({ success: true });
});

// ── RENAME WA ──
app.patch('/api/wa/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const acc = config.accounts.find(a => a.id === id);
  if (!acc) return res.status(404).json({ error: 'WA not found' });
  const { label } = req.body;
  if (label) {
    acc.label = label;
    if (clientState[id]) clientState[id].label = label;
    saveConfig(config);
  }
  res.json({ success: true, id, label: acc.label });
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), accounts: config.accounts.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✓ Server running on port ${PORT}`);
  console.log(`  ✓ Baileys mode (no Chromium)`);
  console.log(`  ✓ ${config.accounts.length} WA accounts loaded`);
  console.log('  ✓ Lazy init — activate saat dipilih\n');
});
