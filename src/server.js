require('dotenv').config();
const express = require('express');
const path = require('path');
const { router: authRouter, authenticateToken } = require('./auth');
const whatsapp = require('./whatsapp');
const supabase = require('./supabase');
const QRCode = require('qrcode');
const cron = require('node-cron');
const multer = require('multer');
const { MessageMedia } = require('whatsapp-web.js');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);

// ─── WhatsApp ────────────────────────────────────────────────

app.get('/api/whatsapp/status', authenticateToken, (req, res) => {
  const userId = req.user.id;

  console.log('[STATUS] userId:', req.user?.id);
  console.log('[STATUS] status atual:', whatsapp.getStatus(req.user?.id));

  whatsapp.initSession(userId);

  const current = whatsapp.getStatus(userId);
  res.json(current);
});

app.get('/api/whatsapp/qr', authenticateToken, async (req, res) => {
  const qr = whatsapp.getQR(req.user.id);
  console.log('[QR ROUTE] userId:', req.user.id, '| qr existe:', !!qr);
  if (!qr) return res.status(404).json({ error: 'QR não disponível' });
  try {
    const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 300 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(buffer);
  } catch(e) {
    console.error('[QR ROUTE] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/whatsapp/disconnect', authenticateToken, async (req, res) => {
  await whatsapp.disconnect(req.user.id);
  res.json({ ok: true });
});

// ─── Groups ──────────────────────────────────────────────────

app.get('/api/groups', authenticateToken, async (req, res) => {
  const { data, error } = await supabase
    .from('groups')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erro ao buscar grupos.' });
  res.json({ groups: data });
});

app.patch('/api/groups/:id/toggle', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const { data: group, error: fetchErr } = await supabase
    .from('groups')
    .select('active, user_id')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr || !group) return res.status(404).json({ error: 'Grupo não encontrado.' });
  if (group.user_id !== req.user.id) return res.status(403).json({ error: 'Sem permissão.' });

  const { error } = await supabase
    .from('groups')
    .update({ active: !group.active, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'Erro ao atualizar grupo.' });
  res.json({ ok: true, active: !group.active });
});

// ─── Messages ────────────────────────────────────────────────

app.post('/api/messages', authenticateToken, upload.single('file'), async (req, res) => {
  console.log('Body recebido:', req.body);
  console.log('User:', req.user);

  const { group_id, group_name, text, scheduled_time } = req.body;
  if (!group_id || (!text && !req.file))
    return res.status(400).json({ error: 'group_id e text (ou arquivo) são obrigatórios.' });

  // Envio imediato
  if (!scheduled_time) {
    const client = whatsapp.getClient(req.user.id);
    const waStatus = whatsapp.getStatus(req.user.id);
    if (!client || waStatus.status !== 'connected') {
      console.error('[MSG] Erro: WhatsApp não conectado. Status:', waStatus.status);
      return res.status(400).json({ error: 'WhatsApp não conectado. Status: ' + waStatus.status });
    }
    const clientInfo = client.info;
    if (!clientInfo) {
      console.error('[MSG] client.info é null — sessão não está totalmente ativa');
      return res.status(400).json({ error: 'WhatsApp ainda não está pronto. Aguarde alguns segundos.' });
    }
    console.log(`[MSG] Conectado como: ${clientInfo.pushname} (${clientInfo.wid?.user})`);

    // Verifica o estado real do WhatsApp Web (detecta sessão "fantasma")
    try {
      const waState = await client.getState();
      console.log(`[MSG] WhatsApp Web state: ${waState}`);
      if (waState !== 'CONNECTED') {
        console.error(`[MSG] Estado inválido: ${waState} — sessão fantasma detectada.`);
        return res.status(400).json({ error: `WhatsApp Web não está conectado (estado: ${waState}). Reconecte e tente novamente.` });
      }
    } catch (stateErr) {
      console.error('[MSG] Não foi possível verificar estado do WhatsApp:', stateErr.message);
      return res.status(400).json({ error: 'Não foi possível verificar a conexão WhatsApp. Reconecte e tente novamente.' });
    }

    try {
      const waId = group_id.includes('@') ? group_id : `${group_id}@g.us`;
      console.log(`[MSG] waId: ${waId}`);
      if (req.file) {
        const media = new MessageMedia(req.file.mimetype, req.file.buffer.toString('base64'), req.file.originalname);
        const isAudio = req.file.mimetype.startsWith('audio/');
        const sendOpts = isAudio ? { sendAudioAsVoice: true } : { caption: text || undefined };
        const sent = await client.sendMessage(waId, media, sendOpts);
        console.log(`[MSG] Mídia enviada para ${group_name || group_id}: ${req.file.originalname} | msgId: ${sent?.id?._serialized}`);
        if (!sent?.id?._serialized) throw new Error('WhatsApp não retornou confirmação de envio da mídia.');
      } else {
        const sent = await client.sendMessage(waId, text);
        console.log(`[MSG] Enviada para ${group_name || group_id}: ${text.slice(0, 60)} | msgId: ${sent?.id?._serialized}`);
        if (!sent?.id?._serialized) throw new Error('WhatsApp não retornou confirmação de envio.');
      }
    } catch (err) {
      console.error('[MSG] Erro ao enviar mensagem imediata:', err);
      return res.status(500).json({ error: 'Erro ao enviar: ' + err.message });
    }
    const { data, error } = await supabase
      .from('messages')
      .insert([{ user_id: req.user.id, group_id, text: text || req.file.originalname, scheduled_time: null, sent: true }])
      .select().single();
    if (error) { console.error('[MSG] Erro Supabase completo:', JSON.stringify(error)); return res.status(500).json({ error: error.message || JSON.stringify(error) }); }
    return res.status(201).json({ message: data });
  }

  // Envio agendado — salva como sent=false, cron processa depois
  const mediaData     = req.file ? req.file.buffer.toString('base64') : null;
  const mediaMimetype = req.file ? req.file.mimetype : null;
  const mediaFilename = req.file ? req.file.originalname : null;

  const { data, error } = await supabase
    .from('messages')
    .insert([{
      user_id: req.user.id,
      group_id,
      text: text || req.file?.originalname,
      scheduled_time,
      sent: false,
      media_data: mediaData,
      media_mimetype: mediaMimetype,
      media_filename: mediaFilename,
    }])
    .select().single();

  if (error) { console.error('[MSG] Erro Supabase completo:', JSON.stringify(error)); return res.status(500).json({ error: error.message || JSON.stringify(error) }); }
  console.log(`[MSG] Agendada para ${group_name || group_id} em ${scheduled_time}: ${(text || '').slice(0, 60)}`);
  res.status(201).json({ message: data });
});

app.get('/api/messages', authenticateToken, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ error: 'Erro ao buscar mensagens.' });
  res.json({ messages: data });
});

app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const { data: msg, error: fetchErr } = await supabase
    .from('messages')
    .select('user_id, sent')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr || !msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Sem permissão.' });
  if (msg.sent) return res.status(400).json({ error: 'Mensagem já enviada.' });

  const { error } = await supabase.from('messages').delete().eq('id', id);
  if (error) return res.status(500).json({ error: 'Erro ao cancelar mensagem.' });
  res.json({ ok: true });
});

// ─── Pages ───────────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ─── Boot ─────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  const { data: users } = await supabase.from('users').select('id');
  if (users?.length) {
    console.log(`[BOOT] Iniciando sessão WhatsApp para ${users.length} usuário(s)...`);
    users.forEach(u => whatsapp.initSession(u.id));
  }
});

// ─── Cron: disparo de mensagens a cada 30s ───────────────────

cron.schedule('*/30 * * * * *', async () => {
  const now = new Date().toISOString();

  const { data: pending, error } = await supabase
    .from('messages')
    .select('*')
    .eq('sent', false)
    .not('scheduled_time', 'is', null)
    .lte('scheduled_time', now);

  if (error) { console.error('[CRON] Erro ao buscar mensagens:', error.message); return; }
  if (!pending || pending.length === 0) return;

  console.log(`[CRON] ${pending.length} mensagem(ns) para enviar.`);

  for (const msg of pending) {
    const client = whatsapp.getClient(msg.user_id);
    if (!client) {
      console.error(`[CRON] WhatsApp não conectado para userId ${msg.user_id}, pulando mensagem ${msg.id}`);
      continue;
    }
    // Verifica estado real antes de tentar enviar
    try {
      const waState = await client.getState();
      if (waState !== 'CONNECTED') {
        console.error(`[CRON] Estado WhatsApp inválido para userId ${msg.user_id}: ${waState}. Pulando msg ${msg.id}.`);
        continue;
      }
    } catch (stateErr) {
      console.error(`[CRON] Erro ao verificar estado para userId ${msg.user_id}:`, stateErr.message);
      continue;
    }
    try {
      const waId = msg.group_id.includes('@') ? msg.group_id : `${msg.group_id}@g.us`;
      console.log(`[CRON] Enviando msg ${msg.id} para waId: ${waId}`);
      let sent;
      if (msg.media_data) {
        const media = new MessageMedia(msg.media_mimetype, msg.media_data, msg.media_filename);
        const isAudio = msg.media_mimetype?.startsWith('audio/');
        const sendOpts = isAudio ? { sendAudioAsVoice: true } : { caption: msg.text || undefined };
        sent = await client.sendMessage(waId, media, sendOpts);
        console.log(`[CRON] Mídia enviada para ${msg.group_id}: ${msg.media_filename} | msgId: ${sent?.id?._serialized}`);
        if (!sent?.id?._serialized) throw new Error('Sem confirmação de envio da mídia.');
      } else {
        sent = await client.sendMessage(waId, msg.text);
        console.log(`[CRON] Enviada para ${msg.group_id}: ${msg.text?.slice(0, 60)} | msgId: ${sent?.id?._serialized}`);
        if (!sent?.id?._serialized) throw new Error('Sem confirmação de envio.');
      }
      await supabase.from('messages').update({ sent: true }).eq('id', msg.id);
    } catch (err) {
      console.error(`[CRON] Falha ao enviar mensagem ${msg.id}:`, err);
    }
  }
});
