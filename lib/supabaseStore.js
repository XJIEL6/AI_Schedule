const { createClient } = require('@supabase/supabase-js');

const DEFAULT_VERSIONS = [
  ['S7-1', '2026-06-16', '2026-07-15'],
  ['S7-2', '2026-07-01', '2026-07-30'],
  ['S8-1', '2026-08-03', '2026-08-28'],
  ['S8-2', '2026-09-01', '2026-09-25'],
  ['S9-1', '2026-09-28', '2026-10-30'],
  ['S9-2', '2026-11-02', '2026-11-27'],
];

let supabase;
let readyPromise;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  }

  if (!supabase) {
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return supabase;
}

async function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const db = getSupabase();

      const { count: versionCount, error: versionCountError } = await db
        .from('versions')
        .select('*', { count: 'exact', head: true });
      if (versionCountError) throw versionCountError;

      if (!versionCount) {
        const seedRows = DEFAULT_VERSIONS.map(([name, brdDate, launchDate], index) => ({
          name,
          brd_date: brdDate,
          launch_date: launchDate,
          sort_order: index + 1,
        }));
        const { error: seedError } = await db.from('versions').insert(seedRows);
        if (seedError) throw seedError;
      }

      const { count: emailCount, error: emailCountError } = await db
        .from('email_config')
        .select('*', { count: 'exact', head: true });
      if (emailCountError) throw emailCountError;

      if (!emailCount) {
        const { error: emailSeedError } = await db.from('email_config').insert([{ id: 1 }]);
        if (emailSeedError) throw emailSeedError;
      }
    })().catch(error => {
      readyPromise = null;
      throw error;
    });
  }

  return readyPromise;
}

async function listVersions() {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('versions')
    .select('name, brd_date, launch_date')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function updateVersion(name, patch) {
  await ensureReady();
  const updates = {};
  if (patch.brdDate) updates.brd_date = patch.brdDate;
  if (patch.launchDate) updates.launch_date = patch.launchDate;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await getSupabase()
    .from('versions')
    .update(updates)
    .eq('name', name)
    .select('name');
  if (error) throw error;
  return data && data.length > 0;
}

async function listHolidays() {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('holidays')
    .select('id, start_date, end_date, type')
    .order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(row => ({
    id: row.id,
    start: row.start_date,
    end: row.end_date,
    type: row.type,
  }));
}

async function addHoliday({ start, end, type }) {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('holidays')
    .insert([{ start_date: start, end_date: end, type: type || 'holiday' }])
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function removeHoliday(id) {
  await ensureReady();
  const { error } = await getSupabase().from('holidays').delete().eq('id', id);
  if (error) throw error;
}

async function listNoRelease() {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('no_release')
    .select('id, start_date, end_date')
    .order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(row => ({ id: row.id, start: row.start_date, end: row.end_date }));
}

async function addNoRelease({ start, end }) {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('no_release')
    .insert([{ start_date: start, end_date: end }])
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function removeNoRelease(id) {
  await ensureReady();
  const { error } = await getSupabase().from('no_release').delete().eq('id', id);
  if (error) throw error;
}

async function getEmailConfig() {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('email_config')
    .select('smtp_host, smtp_port, smtp_user, smtp_pass, recipients')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return data || { smtp_host: '', smtp_port: 465, smtp_user: '', smtp_pass: '', recipients: '' };
}

async function saveEmailConfig(config) {
  await ensureReady();
  const row = {
    id: 1,
    smtp_host: config.smtpHost || '',
    smtp_port: Number(config.smtpPort) || 465,
    smtp_user: config.smtpUser || '',
    smtp_pass: config.smtpPass || '',
    recipients: config.recipients || '',
    updated_at: new Date().toISOString(),
  };
  const { error } = await getSupabase().from('email_config').upsert(row, { onConflict: 'id' });
  if (error) throw error;
}

async function countVersions() {
  await ensureReady();
  const { count, error } = await getSupabase().from('versions').select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

async function listConversations() {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function createConversation(title) {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('conversations')
    .insert([{ title }])
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function updateConversationTitle(id, title) {
  await ensureReady();
  const { error } = await getSupabase()
    .from('conversations')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

async function deleteConversation(id) {
  await ensureReady();
  const { error } = await getSupabase().from('conversations').delete().eq('id', id);
  if (error) throw error;
}

async function listChatMessages(conversationId) {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('chat_messages')
    .select('id, role, content, tool_calls, label, created_at')
    .eq('conversation_id', conversationId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addChatMessage({ conversation_id, role, content, tool_calls, label }) {
  await ensureReady();
  const { data, error } = await getSupabase()
    .from('chat_messages')
    .insert([{ conversation_id, role, content, tool_calls: tool_calls || null, label: label || null }])
    .select('id')
    .single();
  if (error) throw error;
  
  // 更新对话的 updated_at
  await getSupabase()
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversation_id);
  
  return data.id;
}

async function deleteChatMessageById(id) {
  await ensureReady();
  const { error } = await getSupabase().from('chat_messages').delete().eq('id', id);
  if (error) throw error;
}

async function clearChatMessagesByConversation(conversationId) {
  await ensureReady();
  const { error } = await getSupabase().from('chat_messages').delete().eq('conversation_id', conversationId);
  if (error) throw error;
}

module.exports = {
  ensureReady,
  listVersions,
  updateVersion,
  listHolidays,
  addHoliday,
  removeHoliday,
  listNoRelease,
  addNoRelease,
  removeNoRelease,
  getEmailConfig,
  saveEmailConfig,
  countVersions,
  listConversations,
  createConversation,
  updateConversationTitle,
  deleteConversation,
  listChatMessages,
  addChatMessage,
  deleteChatMessageById,
  clearChatMessagesByConversation,
};