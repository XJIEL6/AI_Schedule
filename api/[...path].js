const https = require('https');
const nodemailer = require('nodemailer');
const {
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
} = require('../lib/supabaseStore');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch (_error) {
    return {};
  }
}

function fmtDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function proxyChat(body) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return { statusCode: 500, body: { error: '未配置 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY' } };
  }

  const payload = JSON.stringify({
    model: body.model || 'deepseek-chat',
    messages: body.messages,
    tools: body.tools,
    stream: body.stream !== false,
    max_tokens: body.max_tokens || 4096,
  });

  const response = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.deepseek.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, apiResponse => {
      let chunks = '';
      apiResponse.on('data', chunk => { chunks += chunk; });
      apiResponse.on('end', () => resolve({ statusCode: apiResponse.statusCode || 500, body: chunks }));
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });

  if (response.statusCode !== 200) {
    return { statusCode: response.statusCode, body: { error: response.body } };
  }

  return { statusCode: 200, body: JSON.parse(response.body) };
}

async function sendReminders() {
  const config = await getEmailConfig();
  if (!config.smtp_host || !config.recipients) {
    return { skipped: true, reason: 'missing-email-config' };
  }

  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: Number(config.smtp_port) || 465,
    secure: Number(config.smtp_port) !== 587,
    auth: { user: config.smtp_user, pass: config.smtp_pass },
  });

  const versions = await listVersions();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = fmtDate(tomorrow);

  let rows = '';
  for (const version of versions) {
    const brd = new Date(version.brd_date + 'T00:00:00');
    const schedule = new Date(brd);
    schedule.setDate(schedule.getDate() + 12);
    const devFreeze = new Date(schedule);
    devFreeze.setDate(devFreeze.getDate() + 6);
    const launch = new Date(version.launch_date + 'T00:00:00');

    const phases = [];
    if (fmtDate(brd) === tomorrowStr) phases.push('BRD初评');
    if (fmtDate(new Date(brd.getTime() + 3 * 86400000)) === tomorrowStr) phases.push('BRD终评');
    if (fmtDate(devFreeze) === tomorrowStr) phases.push('需求开发完成&提测截止');
    if (fmtDate(launch) === tomorrowStr) phases.push('iOS提审/发版');

    if (phases.length) {
      rows += `<tr><td>${version.name}</td><td>${phases.join('、')}</td><td>${tomorrowStr}</td></tr>`;
    }
  }

  if (!rows) return { skipped: true, reason: 'no-reminders' };

  const html = `<h3>发版日历 - 明日提醒</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse"><tr><th>版本</th><th>事项</th><th>日期</th></tr>${rows}</table>`;
  await transporter.sendMail({
    from: config.smtp_user,
    to: config.recipients,
    subject: `发版日历提醒 - ${tomorrowStr}`,
    html,
  });
  return { sent: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    const body = parseJsonBody(req);

    if (segments[0] !== 'api') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const route = segments[1] || '';

    if (route === 'health' && req.method === 'GET') {
      const versions = await countVersions();
      sendJson(res, 200, { status: 'ok', db: 'supabase', versions, provider: 'deepseek' });
      return;
    }

    if (route === 'versions') {
      if (req.method === 'GET') {
        const versions = await listVersions();
        sendJson(res, 200, versions.map(item => ({ name: item.name, brdDate: item.brd_date, launchDate: item.launch_date })));
        return;
      }

      if (req.method === 'PUT' && segments[2]) {
        const updated = await updateVersion(segments[2], body);
        if (!updated) {
          sendJson(res, 404, { error: `版本 ${segments[2]} 不存在` });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (route === 'holidays') {
      if (req.method === 'GET') {
        sendJson(res, 200, await listHolidays());
        return;
      }

      if (req.method === 'POST') {
        if (!body.start || !body.end) {
          sendJson(res, 400, { error: '缺少参数' });
          return;
        }
        const id = await addHoliday(body);
        sendJson(res, 200, { ok: true, id });
        return;
      }

      if (req.method === 'DELETE' && segments[2]) {
        await removeHoliday(Number(segments[2]));
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (route === 'no-release') {
      if (req.method === 'GET') {
        sendJson(res, 200, await listNoRelease());
        return;
      }

      if (req.method === 'POST') {
        if (!body.start || !body.end) {
          sendJson(res, 400, { error: '缺少参数' });
          return;
        }
        const id = await addNoRelease(body);
        sendJson(res, 200, { ok: true, id });
        return;
      }

      if (req.method === 'DELETE' && segments[2]) {
        await removeNoRelease(Number(segments[2]));
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (route === 'email-config') {
      if (req.method === 'GET') {
        const config = await getEmailConfig();
        sendJson(res, 200, {
          smtpHost: config.smtp_host || '',
          smtpPort: config.smtp_port || 465,
          smtpUser: config.smtp_user || '',
          smtpPass: config.smtp_pass || '',
          recipients: config.recipients || '',
        });
        return;
      }

      if (req.method === 'POST') {
        await saveEmailConfig(body);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (route === 'send-reminder' && req.method === 'POST') {
      const result = await sendReminders();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (route === 'chat' && req.method === 'POST') {
      const result = await proxyChat(body);
      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (route === 'conversations') {
      if (req.method === 'GET') {
        const conversations = await listConversations();
        sendJson(res, 200, conversations);
        return;
      }

      if (req.method === 'POST') {
        const { title } = body;
        if (!title) {
          sendJson(res, 400, { error: '缺少 title' });
          return;
        }
        const id = await createConversation(title);
        sendJson(res, 200, { ok: true, id });
        return;
      }

      if (req.method === 'PUT' && segments[2]) {
        const { title } = body;
        if (!title) {
          sendJson(res, 400, { error: '缺少 title' });
          return;
        }
        await updateConversationTitle(Number(segments[2]), title);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE' && segments[2]) {
        await deleteConversation(Number(segments[2]));
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (route === 'chat-messages') {
      if (req.method === 'GET') {
        const conversationId = url.searchParams.get('conversation_id');
        if (!conversationId) {
          sendJson(res, 400, { error: '缺少 conversation_id' });
          return;
        }
        const messages = await listChatMessages(Number(conversationId));
        sendJson(res, 200, messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
          label: m.label,
        })));
        return;
      }

      if (req.method === 'POST') {
        const { conversation_id, role, content, tool_calls, label } = body;
        if (!conversation_id || !role || !content) {
          sendJson(res, 400, { error: '缺少 conversation_id、role 或 content' });
          return;
        }
        const id = await addChatMessage({ conversation_id: Number(conversation_id), role, content, tool_calls, label });
        sendJson(res, 200, { ok: true, id });
        return;
      }

      if (req.method === 'DELETE') {
        if (segments[2]) {
          await deleteChatMessageById(Number(segments[2]));
          sendJson(res, 200, { ok: true });
        } else {
          const conversationId = url.searchParams.get('conversation_id');
          if (!conversationId) {
            sendJson(res, 400, { error: '缺少 conversation_id' });
            return;
          }
          await clearChatMessagesByConversation(Number(conversationId));
          sendJson(res, 200, { ok: true });
        }
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
};