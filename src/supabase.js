const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[Supabase] ERRO: variáveis de ambiente ausentes.');
  console.error('[Supabase] Defina SUPABASE_URL e SUPABASE_KEY no Railway (Settings → Variables).');
  process.exit(1);
}

module.exports = createClient(supabaseUrl, supabaseKey);
