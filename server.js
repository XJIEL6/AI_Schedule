// ============================================================
// 1号会员店发版日历 — Express + Prisma + DeepSeek AI
// 兼容 Vercel Serverless 部署（无文件系统写入依赖）
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const PORT = process.env.PORT || 3456;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || '';

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 版本管理 ──
app.get('/api/versions', async (_req, res) => {
  const rows = await prisma.version.findMany({ orderBy: { sortOrder: 'asc' } });
  res.json(rows.map(r => ({ name: r.name, brdDate: r.brdDate.toISOString().slice(0,10), launchDate: r.launchDate.toISOString().slice(0,10) })));
});

app.put('/api/versions/:name', async (req, res) => {
  const { name } = req.params;
  const { brdDate, launchDate } = req.body;
  const existing = await prisma.version.findUnique({ where: { name } });
  if (!existing) return res.status(404).json({ error: `版本 ${name} 不存在` });
  const data = {};
  if (brdDate) data.brdDate = new Date(brdDate);
  if (launchDate) data.launchDate = new Date(launchDate);
  await prisma.version.update({ where: { name }, data });
  res.json({ ok: true });
});

// ── 假期管理 ──
app.get('/api/holidays', async (_req, res) => {
  const rows = await prisma.holiday.findMany({ orderBy: { id: 'asc' } });
  res.json(rows.map(r => ({ id: Number(r.id), start: r.startDate.toISOString().slice(0,10), end: r.endDate.toISOString().slice(0,10), type: r.type })));
});

app.post('/api/holidays', async (req, res) => {
  const { start, end, type } = req.body;
  if (!start || !end) return res.status(400).json({ error: '缺少参数' });
  const row = await prisma.holiday.create({ data: { startDate: new Date(start), endDate: new Date(end), type: type || 'holiday' } });
  res.json({ ok: true, id: Number(row.id) });
});

app.delete('/api/holidays/:id', async (req, res) => {
  await prisma.holiday.delete({ where: { id: BigInt(req.params.id) } });
  res.json({ ok: true });
});

// ── 不能发版日期 ──
app.get('/api/no-release', async (_req, res) => {
  const rows = await prisma.noRelease.findMany({ orderBy: { id: 'asc' } });
  res.json(rows.map(r => ({ id: Number(r.id), start: r.startDate.toISOString().slice(0,10), end: r.endDate.toISOString().slice(0,10) })));
});

app.post('/api/no-release', async (req, res) => {
  const { start, end } = req.body;
  if (!start || !end) return res.status(400).json({ error: '缺少参数' });
  const row = await prisma.noRelease.create({ data: { startDate: new Date(start), endDate: new Date(end) } });
  res.json({ ok: true, id: Number(row.id) });
});

app.delete('/api/no-release/:id', async (req, res) => {
  await prisma.noRelease.delete({ where: { id: BigInt(req.params.id) } });
  res.json({ ok: true });
});

// ── AI 聊天代理（DeepSeek）──
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

app.get('/api/email-config', async (_req, res) => {
  const cfg = await prisma.emailConfig.findUnique({ where: { id: 1 } }) || { smtpHost:'', smtpPort:465, smtpUser:'', smtpPass:'', recipients:'' };
  res.json(cfg);
});

app.post('/api/email-config', async (req, res) => {
  const data = {};
  if (req.body.smtpHost !== undefined) data.smtpHost = req.body.smtpHost;
  if (req.body.smtpPort !== undefined) data.smtpPort = req.body.smtpPort;
  if (req.body.smtpUser !== undefined) data.smtpUser = req.body.smtpUser;
  if (req.body.smtpPass !== undefined) data.smtpPass = req.body.smtpPass;
  if (req.body.recipients !== undefined) data.recipients = req.body.recipients;
  await prisma.emailConfig.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  res.json({ ok: true });
});

// ── 发送提醒 ──
async function sendReminders() {
  const cfg = await prisma.emailConfig.findUnique({ where: { id: 1 } });
  if (!cfg || !cfg.smtpHost || !cfg.recipients) return;

  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost, port: cfg.smtpPort, secure: true,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
  });

  const versions = await prisma.version.findMany({ orderBy: { sortOrder: 'asc' } });
  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const fmtLocal = d => { const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; };
  const tStr = fmtLocal(tomorrow);

  let body = '';
  for (const v of versions) {
    const phases = [];
    const brd = v.brdDate;
    const schedule = new Date(brd); schedule.setDate(schedule.getDate() + 12);
    const devFreeze = new Date(schedule); devFreeze.setDate(devFreeze.getDate() + 6);
    const launch = v.launchDate;

    if (fmtLocal(brd) === tStr) phases.push('BRD初评');
    if (fmtLocal(new Date(brd.getTime()+3*86400000)) === tStr) phases.push('BRD终评');
    if (fmtLocal(devFreeze) === tStr) phases.push('需求开发完成&提测截止');
    if (fmtLocal(launch) === tStr) phases.push('iOS提审/发版');
    if (phases.length) body += `<tr><td>${v.name}</td><td>${phases.join('、')}</td><td>${tStr}</td></tr>`;
  }

  if (!body) return;
  const html = `<h3>📅 发版日历 — 明日提醒</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse"><tr><th>版本</th><th>事项</th><th>日期</th></tr>${body}</table>`;
  try {
    await transporter.sendMail({ from: cfg.smtpUser, to: cfg.recipients, subject: `发版日历提醒 — ${tStr}`, html });
    console.log('[Mail] 提醒已发送:', tStr);
  } catch(e) { console.error('[Mail] 发送失败:', e.message); }
}

app.post('/api/send-reminder', async (_req, res) => {
  await sendReminders();
  res.json({ ok: true });
});

// ── 定时检查 ─┐
try {
  const cron = require('node-cron');
  cron.schedule('0 8 * * *', () => sendReminders());
  console.log('[Cron] 每日 8:00 邮件提醒已启动');
} catch(e) { console.log('[Cron] 跳过（可选）'); }

// ── 健康检查 ──
app.get('/api/health', async (_req, res) => {
  const vCnt = await prisma.version.count();
  res.json({ status: 'ok', db: 'prisma+supabase', versions: vCnt, provider: 'deepseek' });
});

// ── Vercel / 本地兼容启动 ──
if (process.env.VERCEL) {
  // Vercel Serverless: export app
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`[Server] http://localhost:${PORT}`);
    console.log(`[Server] DB: Prisma + Supabase PostgreSQL`);
    console.log(`[Server] API: /api/versions | /api/holidays | /api/no-release | /api/chat | /api/health`);
  });
}
