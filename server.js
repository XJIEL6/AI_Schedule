// ===== 1号会员店发版日历 - 后端服务 =====
// Express + SQLite(sql.js) + DeepSeek AI 代理

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const initSqlJs = require('sql.js');

const PORT = process.env.PORT || 3456;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const DB_PATH = path.join(__dirname, 'db', 'calendar.db');

// 确保 db 目录存在
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ===== 数据库 =====
let db;

function saveDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) { console.error('[DB] 保存失败:', e.message); }
}

function loadOrCreateDB(SQL) {
  if (fs.existsSync(DB_PATH)) {
    try {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
      console.log('[DB] 已加载数据库');
      return;
    } catch (e) { console.log('[DB] 数据库损坏，重新创建'); }
  }
  db = new SQL.Database();
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      brd_date TEXT NOT NULL,
      launch_date TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'holiday',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS no_release (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 默认版本数据
  const cnt = db.exec('SELECT COUNT(*) as cnt FROM versions');
  if (cnt.length && cnt[0].values[0][0] === 0) {
    const defaults = [
      ['S7-1', '2026-06-16', '2026-07-15'],
      ['S7-2', '2026-07-01', '2026-07-30'],
      ['S8-1', '2026-08-03', '2026-08-28'],
      ['S8-2', '2026-09-01', '2026-09-25'],
      ['S9-1', '2026-09-28', '2026-10-30'],
      ['S9-2', '2026-11-02', '2026-11-27'],
    ];
    for (const [name, brd, launch] of defaults) {
      db.run('INSERT INTO versions (name, brd_date, launch_date) VALUES (?, ?, ?)', [name, brd, launch]);
    }
    saveDB();
    console.log('[DB] 已初始化默认版本');
  }
  saveDB();
}

// 辅助: 将 sql.js 查询结果转为对象数组
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryRun(sql, params = []) {
  db.run(sql, params);
  saveDB();
  // 获取 lastInsertRowid
  const r = db.exec('SELECT last_insert_rowid() as id');
  return r.length ? r[0].values[0][0] : null;
}

// ===== Express 应用 =====
async function start() {
  const SQL = await initSqlJs();
  loadOrCreateDB(SQL);
  initSchema();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── 版本管理 ──
  app.get('/api/versions', (_req, res) => {
    res.json(queryAll('SELECT name, brd_date, launch_date FROM versions ORDER BY id')
      .map(r => ({ name: r.name, brdDate: r.brd_date, launchDate: r.launch_date })));
  });

  app.put('/api/versions/:name', (req, res) => {
    const { name } = req.params;
    const { brdDate, launchDate } = req.body;
    const existing = queryAll('SELECT id FROM versions WHERE name = ?', [name]);
    if (!existing.length) return res.status(404).json({ error: `版本 ${name} 不存在` });
    if (brdDate) db.run('UPDATE versions SET brd_date = ? WHERE name = ?', [brdDate, name]);
    if (launchDate) db.run('UPDATE versions SET launch_date = ? WHERE name = ?', [launchDate, name]);
    db.run("UPDATE versions SET updated_at = datetime('now','localtime') WHERE name = ?", [name]);
    saveDB();
    res.json({ ok: true });
  });

  // ── 假期管理 ──
  app.get('/api/holidays', (_req, res) => {
    res.json(queryAll('SELECT id, start_date, end_date, type FROM holidays ORDER BY id')
      .map(r => ({ id: r.id, start: r.start_date, end: r.end_date, type: r.type })));
  });

  app.post('/api/holidays', (req, res) => {
    const { start, end, type } = req.body;
    if (!start || !end) return res.status(400).json({ error: '缺少参数' });
    const id = queryRun('INSERT INTO holidays (start_date, end_date, type) VALUES (?, ?, ?)',
      [start, end, type || 'holiday']);
    res.json({ ok: true, id });
  });

  app.delete('/api/holidays/:id', (req, res) => {
    db.run('DELETE FROM holidays WHERE id = ?', [req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  // ── 不能发版日期 ──
  app.get('/api/no-release', (_req, res) => {
    res.json(queryAll('SELECT id, start_date, end_date FROM no_release ORDER BY id')
      .map(r => ({ id: r.id, start: r.start_date, end: r.end_date })));
  });

  app.post('/api/no-release', (req, res) => {
    const { start, end } = req.body;
    if (!start || !end) return res.status(400).json({ error: '缺少参数' });
    const id = queryRun('INSERT INTO no_release (start_date, end_date) VALUES (?, ?)', [start, end]);
    res.json({ ok: true, id });
  });

  app.delete('/api/no-release/:id', (req, res) => {
    db.run('DELETE FROM no_release WHERE id = ?', [req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  // ── AI 聊天代理 ──
  app.post('/api/chat', (req, res) => {
    const { model, messages, tools, stream } = req.body;
    if (!messages) return res.status(400).json({ error: '缺少 messages' });
    if (!DEEPSEEK_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });

    const payload = JSON.stringify({
      model: model || 'deepseek-chat', messages, tools,
      stream: stream !== false, max_tokens: 4096,
    });

    const apiReq = https.request({
      hostname: 'api.deepseek.com', port: 443,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Length': Buffer.byteLength(payload) },
    }, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let e = ''; apiRes.on('data', c => e += c);
        apiRes.on('end', () => res.status(apiRes.statusCode).json({ error: e }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      apiRes.on('data', c => res.write(c));
      apiRes.on('end', () => res.end());
      apiRes.on('error', () => res.end());
    });
    apiReq.on('error', (e) => res.status(502).json({ error: e.message }));
    apiReq.write(payload);
    apiReq.end();
  });

  // ── 邮件配置 ──
  const nodemailer = require('nodemailer');
  let mailConfig = { smtpHost: '', smtpPort: 465, smtpUser: '', smtpPass: '', recipients: '' };

  app.get('/api/email-config', (_req, res) => res.json(mailConfig));

  app.post('/api/email-config', (req, res) => {
    const { smtpHost, smtpPort, smtpUser, smtpPass, recipients } = req.body;
    if (smtpHost !== undefined) mailConfig.smtpHost = smtpHost;
    if (smtpPort !== undefined) mailConfig.smtpPort = smtpPort;
    if (smtpUser !== undefined) mailConfig.smtpUser = smtpUser;
    if (smtpPass !== undefined) mailConfig.smtpPass = smtpPass;
    if (recipients !== undefined) mailConfig.recipients = recipients;
    res.json({ ok: true });
  });

  // ── 发送提醒 ──
  async function sendReminders() {
    if (!mailConfig.smtpHost || !mailConfig.recipients) return;
    const transporter = nodemailer.createTransport({
      host: mailConfig.smtpHost, port: mailConfig.smtpPort, secure: true,
      auth: { user: mailConfig.smtpUser, pass: mailConfig.smtpPass },
    });

    const versions = queryAll('SELECT name, brd_date, launch_date FROM versions ORDER BY id');
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const fmtLocal = d => { const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; };
    const tStr = fmtLocal(tomorrow);

    // 从数据库取假期/禁发信息
    const holidays = queryAll('SELECT start_date, end_date, type FROM holidays');
    const noRelease = queryAll('SELECT start_date, end_date FROM no_release');

    let body = '';
    for (const v of versions) {
      const phases = [];
      // 模拟前端计算各阶段（简化版，直接用固定偏移估算）
      const brd = new Date(v.brd_date + 'T00:00:00');
      const schedule = new Date(brd); schedule.setDate(schedule.getDate() + 12);
      const devFreeze = new Date(schedule); devFreeze.setDate(devFreeze.getDate() + 6);
      const launch = new Date(v.launch_date + 'T00:00:00');

      if (fmtLocal(brd) === tStr) phases.push('BRD初评');
      if (fmtLocal(new Date(brd.getTime()+3*86400000)) === tStr) phases.push('BRD终评');
      if (fmtLocal(devFreeze) === tStr) phases.push('需求开发完成&提测截止');
      if (fmtLocal(launch) === tStr) phases.push('iOS提审/发版');

      if (phases.length) body += `<tr><td>${v.name}</td><td>${phases.join('、')}</td><td>${tStr}</td></tr>`;
    }

    if (!body) return;
    const html = `<h3>📅 发版日历 — 明日提醒</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse"><tr><th>版本</th><th>事项</th><th>日期</th></tr>${body}</table>`;
    try {
      await transporter.sendMail({ from: mailConfig.smtpUser, to: mailConfig.recipients, subject: `发版日历提醒 — ${tStr}`, html });
      console.log('[Mail] 提醒已发送:', tStr);
    } catch(e) { console.error('[Mail] 发送失败:', e.message); }
  }

  app.post('/api/send-reminder', async (_req, res) => {
    await sendReminders();
    res.json({ ok: true });
  });

  // ── 定时检查（每天 8:00 检查）─┐
  try {
    const cron = require('node-cron');
    cron.schedule('0 8 * * *', () => sendReminders());
    console.log('[Cron] 每日 8:00 邮件提醒已启动');
  } catch(e) { console.log('[Cron] 跳过（可选）'); }

  app.get('/api/health', (_req, res) => {
    const vCnt = queryAll('SELECT COUNT(*) as c FROM versions')[0]?.c || 0;
    res.json({ status: 'ok', db: 'connected', versions: vCnt, provider: 'deepseek' });
  });

  app.listen(PORT, () => {
    console.log(`[Server] http://localhost:${PORT}`);
    console.log(`[Server] API: /api/versions | /api/holidays | /api/no-release | /api/chat | /api/health | /api/email-config | /api/send-reminder`);
    console.log(`[Server] DB: ${DB_PATH}`);
  });
}

start().catch(e => { console.error('启动失败:', e); process.exit(1); });
