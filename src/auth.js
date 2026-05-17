const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('./supabase');
const whatsapp = require('./whatsapp');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing)
    return res.status(409).json({ error: 'Email já cadastrado.' });

  const hashed = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('users')
    .insert([{ email, password: hashed }])
    .select('id, email')
    .single();

  if (error)
    return res.status(500).json({ error: 'Erro ao criar usuário.' });

  const token = jwt.sign({ id: data.id, email: data.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

  res.status(201).json({ token, user: { id: data.id, email: data.email } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, password')
    .eq('email', email)
    .maybeSingle();

  if (error || !user)
    return res.status(401).json({ error: 'Credenciais inválidas.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid)
    return res.status(401).json({ error: 'Credenciais inválidas.' });

  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

  whatsapp.initSession(user.id);

  res.json({ token, user: { id: user.id, email: user.email } });
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token)
    return res.status(401).json({ error: 'Token ausente.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err)
      return res.status(403).json({ error: 'Token inválido.' });
    req.user = user;
    next();
  });
}

module.exports = { router, authenticateToken };
