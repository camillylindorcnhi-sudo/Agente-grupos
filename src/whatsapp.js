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
// userIds em processo de limpeza — initSession não cria nova sessão enquanto limpa
const cleaningUp = new Set();

async function syncGroups(userId, client, attempt = 1) {
  console.log(`[WA:${userId}] Buscando grupos... (tentativa ${attempt})`);
  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    console.log(`[WA:${userId}] ${groups.length} grupos encontrados.`);

    if (groups.length === 0) {
      if (attempt < 4) {
        console.log(`[WA:${userId}] Nenhum grupo. Retry em 10s...`);
        setTimeout(() => {
          const cur = sessions[userId]?.client;
          if (cur) syncGroups(userId, cur, attempt + 1);
        }, 10000);
      }
      return;
    }

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
      setTimeout(() => {
        const cur = sessions[userId]?.client;
        if (cur) syncGroups(userId, cur, attempt + 1);
      }, 10000);
    }
  }
}

function initSession(userId) {
  if (sessions[userId]) return sessions[userId];
  // Bloqueia criação de nova sessão enquanto limpeza está em andamento
  if (cleaningUp.has(userId)) {
    console.log(`[WA:${userId}] initSession ignorado — limpeza em andamento.`);
    return null;
  }

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
    if (sessions[userId] !== session) return;
    cleaningUp.add(userId);
    delete sessions[userId];
    const sessionPath = path.join(AUTH_DIR, `session-${userId}`);
    // Aguarda Chrome liberar locks antes de deletar
    setTimeout(() => {
      try {
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          console.log(`[WA:${userId}] Credenciais inválidas removidas do disco.`);
        }
      } catch (_) {}
      cleaningUp.delete(userId);
      console.log(`[WA:${userId}] Reiniciando sessão limpa...`);
      initSession(userId);
    }, 3000);
  });

  client.on('disconnected', (reason) => {
    console.log(`[WA:${userId}] STATUS → disconnected (${reason})`);
    session.status = 'disconnected';
    session.qr = null;
    session.phone = null;
    if (sessions[userId] !== session) return;
    delete sessions[userId];
  });

  client.initialize().catch(async (err) => {
    console.error(`[WA:${userId}] Falha ao inicializar:`, err.message);
    if (sessions[userId] !== session) return;
    cleaningUp.add(userId);
    delete sessions[userId];
    const sessionPath = path.join(AUTH_DIR, `session-${userId}`);
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`[WA:${userId}] Sessão corrompida removida.`);
      }
    } catch (_) {}
    setTimeout(() => {
      cleaningUp.delete(userId);
      initSession(userId);
    }, 5000);
  });

  // Se ainda estiver 'initializing' após 20s, sessão salva está inválida — limpa e gera QR novo
  setTimeout(async () => {
    if (sessions[userId] !== session || session.status !== 'initializing') return;
    console.log(`[WA:${userId}] Timeout de inicialização. Limpando sessão antiga para gerar QR...`);
    cleaningUp.add(userId);
    delete sessions[userId];
    try { await session.client.destroy(); } catch (_) {}
    await new Promise(r => setTimeout(r, 3000));
    const sessionPath = path.join(AUTH_DIR, `session-${userId}`);
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`[WA:${userId}] Sessão antiga removida do disco.`);
      }
    } catch (_) {}
    cleaningUp.delete(userId);
    initSession(userId);
  }, 20000);

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
  if (!s || cleaningUp.has(userId)) return;

  // Marca limpeza ANTES de qualquer await para bloquear initSession do poll de status
  cleaningUp.add(userId);
  const savedClient = s.client;
  delete sessions[userId];

  try { await savedClient.logout(); } catch (_) {}
  try { await savedClient.destroy(); } catch (_) {}

  // Aguarda Chrome liberar locks de arquivo
  await new Promise(r => setTimeout(r, 3000));

  const sessionPath = path.join(AUTH_DIR, `session-${userId}`);
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`[WA:${userId}] Sessão removida.`);
    }
  } catch (e) {
    console.warn(`[WA:${userId}] Não foi possível remover arquivos de sessão: ${e.message}`);
  }

  cleaningUp.delete(userId);
  initSession(userId);
}

function clearSession(userId) {
  const s = sessions[userId];
  if (s) {
    try { s.client.destroy(); } catch (_) {}
    delete sessions[userId];
  }
  const sessionPath = path.join(AUTH_DIR, `session-${userId}`);
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log(`[WA:${userId}] Sessão limpa do disco.`);
  }
}

module.exports = { initSession, getStatus, getQR, getClient, disconnect, clearSession };
