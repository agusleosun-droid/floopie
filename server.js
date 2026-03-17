/**
 * ══════════════════════════════════════════════
 *   OCR WA SENDER — server.js
 *   3 WhatsApp Client via whatsapp-web.js
 *   Express REST API untuk frontend
 * ══════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ──────────────────────────────────────────────
//   STATE: 3 WA Clients
// ──────────────────────────────────────────────
const WA_COUNT = 3;
const clients = {};
const clientState = {};
const qrExpireTimers = {}; // timer hapus QR otomatis
const reinitTimers = {};   // guard agar tidak double reinit

const LABELS = { 1:'WhatsApp 1', 2:'WhatsApp 2', 3:'WhatsApp 3' };
const QR_TTL = 60000; // QR expired setelah 60 detik, langsung hapus dari memory

// ──────────────────────────────────────────────
//   HELPER: hapus QR dari memory
// ──────────────────────────────────────────────
function clearQR(id) {
  clientState[id].qrDataUrl = null;
  if (qrExpireTimers[id]) { clearTimeout(qrExpireTimers[id]); qrExpireTimers[id] = null; }
}

// ──────────────────────────────────────────────
//   HELPER: schedule reinit (guard double-call)
// ──────────────────────────────────────────────
function scheduleReinit(id, delay = 3000) {
  if (reinitTimers[id]) return; // sudah dijadwalkan
  reinitTimers[id] = setTimeout(() => {
    reinitTimers[id] = null;
    initClient(id);
  }, delay);
}

// ──────────────────────────────────────────────
//   INIT: Buat client
// ──────────────────────────────────────────────
async function initClient(id) {
  // Destroy client lama kalau masih ada
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

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `wa-client-${id}` }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--memory-pressure-off',
      ],
    },
  });

  // ── EVENT: QR ──
  client.on('qr', async (qr) => {
    console.log(`[WA${id}] QR received (baru)`);
    try {
      // Hapus QR lama dari memory dulu
      clearQR(id);

      const dataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
      clientState[id].status = 'qr';
      clientState[id].qrDataUrl = dataUrl;

      // Auto-hapus QR dari memory setelah TTL (60 detik)
      qrExpireTimers[id] = setTimeout(() => {
        if (clientState[id]?.status === 'qr') {
          console.log(`[WA${id}] QR expired, cleared from memory`);
          clientState[id].qrDataUrl = null;
          // Status tetap 'qr' — QR baru akan datang dari WA
        }
      }, QR_TTL);

    } catch (e) {
      console.error(`[WA${id}] QR error:`, e.message);
    }
  });

  // ── EVENT: Ready ──
  client.on('ready', () => {
    console.log(`[WA${id}] Ready! ✓`);
    clearQR(id); // hapus QR dari memory begitu login
    const info = client.info;
    clientState[id].status = 'ready';
    clientState[id].phoneNumber = info?.wid?.user || null;
    clientState[id].pushname = info?.pushname || null;
  });

  // ── EVENT: Auth Failure ──
  client.on('auth_failure', async (msg) => {
    console.error(`[WA${id}] Auth failure:`, msg);
    clearQR(id);
    clientState[id].status = 'disconnected';
    try { await client.destroy(); } catch(e) {}
    scheduleReinit(id, 3000);
  });

  // ── EVENT: Disconnected ──
  client.on('disconnected', async (reason) => {
    console.warn(`[WA${id}] Disconnected: ${reason}`);
    clearQR(id);
    clientState[id].status = 'disconnected';
    clientState[id].phoneNumber = null;
    clientState[id].pushname = null;
    try { await client.destroy(); } catch(e) {}
    console.log(`[WA${id}] Reinit in 3s...`);
    scheduleReinit(id, 3000);
  });

  client.initialize();
  clients[id] = client;
}

// Inisialisasi semua 3 WA
for (let i = 1; i <= WA_COUNT; i++) {
  initClient(i);
}

// ──────────────────────────────────────────────
//   REST API ENDPOINTS
// ──────────────────────────────────────────────

// GET /api/wa/all-status — status semua WA sekaligus
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

// GET /api/wa/:id/status — status 1 WA
app.get('/api/wa/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  if (!clientState[id]) return res.status(404).json({ error: 'WA not found' });
  const s = clientState[id];
  res.json({
    id,
    label: LABELS[id],
    status: s.status,
    phoneNumber: s.phoneNumber,
    pushname: s.pushname,
  });
});

// GET /api/wa/:id/qr — ambil QR image (data URL)
app.get('/api/wa/:id/qr', (req, res) => {
  const id = parseInt(req.params.id);
  if (!clientState[id]) return res.status(404).json({ error: 'WA not found' });
  const s = clientState[id];
  if (s.status !== 'qr' || !s.qrDataUrl) {
    return res.json({ status: s.status, qr: null });
  }
  res.json({ status: 'qr', qr: s.qrDataUrl });
});

// GET /api/wa/:id/groups — ambil semua grup
app.get('/api/wa/:id/groups', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clients[id] || clientState[id]?.status !== 'ready') {
    return res.status(400).json({ error: 'WA not ready' });
  }
  try {
    const chats = await clients[id].getChats();
    const groups = chats
      .filter(c => c.isGroup)
      .map(c => ({
        id: c.id._serialized,
        name: c.name,
        participantCount: c.participants?.length || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ groups });
  } catch (e) {
    console.error(`[WA${id}] Groups error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wa/:id/send — kirim pesan ke grup
// Body: { groupId: "...", messages: ["kode1", "kode2", ...], delay: 800 }
app.post('/api/wa/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clients[id] || clientState[id]?.status !== 'ready') {
    return res.status(400).json({ error: 'WA not ready' });
  }

  const { groupId, messages, delay = 800 } = req.body;
  if (!groupId || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'groupId dan messages diperlukan' });
  }

  // Validasi delay: min 500ms, max 5000ms
  const safeDelay = Math.min(Math.max(parseInt(delay) || 800, 500), 5000);

  console.log(`[WA${id}] Sending ${messages.length} messages to ${groupId}`);

  // Kirim satu per satu dengan delay
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    try {
      await clients[id].sendMessage(groupId, messages[i]);
      results.push({ index: i, message: messages[i], status: 'sent' });
      console.log(`[WA${id}] Sent [${i + 1}/${messages.length}]: ${messages[i]}`);
    } catch (e) {
      results.push({ index: i, message: messages[i], status: 'error', error: e.message });
      console.error(`[WA${id}] Error sending message ${i}:`, e.message);
    }
    // Delay antar pesan (kecuali pesan terakhir)
    if (i < messages.length - 1) {
      await sleep(safeDelay);
    }
  }

  const sent = results.filter(r => r.status === 'sent').length;
  const errors = results.filter(r => r.status === 'error').length;

  res.json({
    success: true,
    total: messages.length,
    sent,
    errors,
    results,
  });
});

// POST /api/wa/:id/restart — restart client
app.post('/api/wa/:id/restart', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!clients[id]) return res.status(404).json({ error: 'WA not found' });
  try {
    await clients[id].destroy();
  } catch (e) { /* ignore */ }
  setTimeout(() => initClient(id), 1000);
  res.json({ success: true, message: `WA${id} restarting...` });
});

// ──────────────────────────────────────────────
//   HELPER
// ──────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────
//   START SERVER
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   OCR WA Sender — Server Running    ║
  ║   http://localhost:${PORT}              ║
  ╚══════════════════════════════════════╝
  `);
  console.log('  Menginisialisasi 3 WhatsApp client...');
  console.log('  Buka http://localhost:3000 di browser\n');
});
