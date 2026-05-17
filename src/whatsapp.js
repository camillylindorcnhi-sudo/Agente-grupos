const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const supabase = require('./supabase');

const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Users\\camil\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
];
const CHROME = chromePaths.find(p => fs.existsSync(p)) || null;
console.log('Chrome encontrado:', CHROME || '(nenhum — usando Chromium embutido)');

const AUTH_DIR = path.join(__dirname, '..', '.wwebjs_auth');
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

// sessions[userId] = { client, status, qr, phone }
const sessions = {};

async function syncGroups(userId, client, attempt = 1) {
  console.log(`[WA:${userId}] Buscando grupos... (tentativa ${attempt})`);
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    console.log(`[WA:${userId}] ${groups.length} grupos encontrados.`);

    if (groups.length === 0) {
      if (attempt < 4) {
        console.log(`[WA:${userId}] Nenhum grupo. Retry em 10s...`);
        setTimeout(() => syncGroups(userId, client, attempt + 1), 10000);
      }
      return;
    }

    // Busca status active atual para não resetar grupos já ativados
    const { data: existing } = await supabase
      .from('groups')
      .select('group_id, active')
      .eq('user_id', userId);

    const activeMap = {};
    (existing || []).forEach(g => { activeMap[g.group_id] = g.active; });

    const rows = groups.map(g => ({
      user_id: userId,
      group_id: g.id._serialized,
      name: g._data?.subject || g.name || g.id.user || 'Sem nome',
      participant_count: g.participants?.length || 0,
      active: activeMap[g.id._serialized] ?? false,
      updated_at: new Date().toISOString(),
    }));

    rows.forEach(r => console.log(`[WA:${userId}] Grupo: "${r.name}" | active=${r.active} | ${r.participant_count} participantes`));

    const { error } = await supabase
      .from('groups')
      .upsert(rows, { onConflict: 'user_id,group_id' });

    if (error) console.error(`[WA:${userId}] Erro ao salvar grupos:`, error.message);
    else console.log(`[WA:${userId}] ${rows.length} grupos salvos no Supabase.`);
  } catch (err) {
    console.error(`[WA:${userId}] Erro em syncGroups:`, err.message);
    if (attempt < 4) {
      console.log(`[WA:${userId}] Retry syncGroups em 10s...`);
      setTimeout(() => syncGroups(userId, client, attempt + 1), 10000);
    }
  }
}

function initSession(userId) {
  if (sessions[userId]) return sessions[userId];

  console.log(`[WA:${userId}] Iniciando sessão...`);

  const session = { client: null, status: 'initializing', qr: null, phone: null };
  sessions[userId] = session;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId, dataPath: AUTH_DIR }),
    puppeteer: { ...(CHROME ? { executablePath: CHROME } : {}), headless: true, args: PUPPETEER_ARGS },
  });

  session.client = client;

  client.on('qr', (qr) => {
    session.qr = qr;
    session.status = 'qr_pending';
    console.log(`[WA:${userId}] STATUS → qr_pending (QR gerado)`);
  });

  client.on('authenticated', () => {
    console.log(`[WA:${userId}] STATUS → authenticated`);
  });

  client.on('ready', () => {
    session.status = 'connected';
    session.qr = null;
    session.phone = client.info?.wid?.user ?? null;
    console.log(`[WA:${userId}] STATUS → connected (${session.phone}). Sync em 8s...`);
    setTimeout(() => syncGroups(userId, client), 8000);
  });

  client.on('auth_failure', (msg) => {
    console.error(`[WA:${userId}] STATUS → auth_failure:`, msg);
    session.status = 'disconnected';
    delete sessions[userId];
  });

  client.on('disconnected', (reason) => {
    console.log(`[WA:${userId}] STATUS → disconnected (${reason})`);
    session.status = 'disconnected';
    session.qr = null;
    session.phone = null;
    delete sessions[userId];
  });

  client.initialize().catch(async (err) => {
    console.error(`[WA:${userId}] Falha ao inicializar:`, err.message);
    delete sessions[userId];
    const sessionPath = path.join(AUTH_DIR, `session-${userId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`[WA:${userId}] Sessão corrompida removida. Retry em 5s...`);
    }
    setTimeout(() => initSession(userId), 5000);
  });

  return session;
}

function getStatus(userId) {
  const s = sessions[userId];
  if (!s) return { status: 'disconnected', phone: null };
  return { status: s.status, phone: s.phone };
}

function getQR(userId) {
  return sessions[userId]?.qr || null;
}

function getClient(userId) {
  const s = sessions[userId];
  if (!s || s.status !== 'connected') return null;
  return s.client;
}

async function disconnect(userId) {
  const s = sessions[userId];
  if (!s) return;
  try { await s.client.logout(); } catch (_) {}
  delete sessions[userId];
  const sessionPath = path.join(AUTH_DIR, `session-${userId}`);
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log(`[WA:${userId}] Sessão removida.`);
  }
}

module.exports = { initSession, getStatus, getQR, getClient, disconnect };
