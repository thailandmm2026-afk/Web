'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const mysql = require('mysql2/promise');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const TELEGRAM_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_ADMIN_ID = String(process.env.TELEGRAM_ADMIN_USER_ID || '').trim();
const ALLOWED_PLATFORMS = new Set(['SHWELOTTERY', '6LOTTERY', '777BIGWIN', 'CKLOTTERY']);
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/user.html', 'user.html'],
  ['/client-services.js', 'client-services.js'],
  ['/ultra-ui.css', 'public/ultra-ui.css'],
  ['/ultra-mark.svg', 'public/ultra-mark.svg'],
  ['/manus-routes.json', 'manus-routes.json']
]);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const requestLimits = new Map();
let pool = null;
let databaseReady = false;
let telegramReady = false;
let telegramOffset = 0;
let adminPendingAction = null; // 'broadcast' | 'remove' | null
const ADMIN_REPLY_KEYBOARD = {
  keyboard: [
    [{ text: 'Allowed ID' }],
    [{ text: 'Remove ID' }, { text: 'User Status' }],
    [{ text: 'Broadcast' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};
let stopping = false;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const SESSION_COOKIE_NAME = 'ultra_session';
const PLATFORM_API = Object.freeze({
  CKLOTTERY: { baseUrl: 'https://ckygjf6r.com/api/webapi/', language: 0 },
  '777BIGWIN': { baseUrl: 'https://api.bigwinqaz.com/api/webapi/', language: 7 },
  '6LOTTERY': { baseUrl: 'https://6lotteryapi.com/api/webapi/', language: 7 },
  SHWELOTTERY: { baseUrl: 'https://api.shweshwbb.com/api/webapi/', language: 7 }
});

function createPool() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL_MISSING');
  const dsn = new URL(raw);
  if (!['mysql:', 'mysqls:'].includes(dsn.protocol)) throw new Error('DATABASE_URL_INVALID');
  const sslValue = String(dsn.searchParams.get('ssl') || dsn.searchParams.get('ssl-mode') || '').toLowerCase();
  const useTls = dsn.protocol === 'mysqls:' || !['0', 'false', 'off', 'disabled', 'disable'].includes(sslValue);
  return mysql.createPool({
    host: dsn.hostname,
    port: Number(dsn.port) || 3306,
    user: decodeURIComponent(dsn.username),
    password: decodeURIComponent(dsn.password),
    database: decodeURIComponent(dsn.pathname.replace(/^\/+/, '')),
    ssl: useTls ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,
    charset: 'utf8mb4',
    timezone: 'Z',
    decimalNumbers: true
  });
}

async function initializeDatabase() {
  pool = createPool();
  await pool.query('SELECT 1');
  await pool.query(`CREATE TABLE IF NOT EXISTS approved_accounts (
    platform VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    approved_by VARCHAR(32) NOT NULL,
    approved_at BIGINT NOT NULL,
    PRIMARY KEY (platform, account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_requests (
    request_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    platform VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT NOT NULL,
    decided_at BIGINT NULL,
    notified_at BIGINT NULL,
    telegram_message_id BIGINT NULL,
    PRIMARY KEY (request_id),
    UNIQUE KEY uq_approval_account (platform, account_id),
    KEY idx_approval_pending (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    platform VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message VARCHAR(1000) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_chat_created (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
    session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    platform VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    csrf_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (session_hash),
    KEY idx_user_sessions_identity (platform, account_id),
    KEY idx_user_sessions_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS broadcasts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    message VARCHAR(2000) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_broadcasts_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  databaseReady = true;
  console.log('Managed Database ready; application tables initialized.');
}

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(body);
}

async function readJson(req, maxBytes = 8192) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('JSON_REQUIRED');
    error.statusCode = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('PAYLOAD_TOO_LARGE');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON');
    return value;
  } catch {
    const error = new Error('INVALID_JSON');
    error.statusCode = 400;
    throw error;
  }
}

function validPlatform(value) {
  return typeof value === 'string' && ALLOWED_PLATFORMS.has(value);
}

function validAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function extractPlatformAccountId(response) {
  const root = response?.data || response || {};
  const data = root.userInfo || root.userinfo || root.user || root.memberInfo || root.data || root;
  for (const object of [data, root, response]) {
    if (!object || typeof object !== 'object') continue;
    const value = object.userid ?? object.userId ?? object.UserId ?? object.uid ?? object.UID ?? object.id ?? object.accountId ?? object.accountID;
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

function platformInfoPayload(settings) {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = String(randomBytes(6).readUIntBE(0, 6));
  const unsigned = { language: settings.language, random };
  const sorted = Object.keys(unsigned).sort().reduce((result, key) => {
    result[key] = unsigned[key];
    return result;
  }, {});
  const signature = createHash('md5').update(JSON.stringify(sorted)).digest('hex').toUpperCase();
  return { language: settings.language, timestamp, random, signature };
}

async function verifyPlatformIdentity(platform, accountId, platformToken) {
  const settings = PLATFORM_API[platform];
  if (!settings || !validAccountId(accountId)) {
    return { ok: false, status: 400, error: 'ပလက်ဖောင်း သို့မဟုတ် အကောင့် ID မမှန်ပါ။' };
  }
  if (typeof platformToken !== 'string' || platformToken.length < 8 || platformToken.length > 4096 || /[\s\x00-\x1f\x7f]/.test(platformToken)) {
    return { ok: false, status: 401, error: 'ပလက်ဖောင်း session မမှန်ပါ။ ပြန်လည်ဝင်ရောက်ပါ။' };
  }
  try {
    const response = await fetch(new URL('GetUserInfo', settings.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${platformToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(platformInfoPayload(settings)),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return { ok: false, status: 502, error: 'ပလက်ဖောင်း ID ကို အတည်မပြုနိုင်ပါ။ ပြန်လည်ဝင်ရောက်ပြီး ကြိုးစားပါ။' };
    const result = await response.json();
    if (result?.code !== 0 || !result?.data) {
      return { ok: false, status: 401, error: 'ပလက်ဖောင်း session သက်တမ်းမမှန်ပါ။ ပြန်လည်ဝင်ရောက်ပါ။' };
    }
    const verifiedId = extractPlatformAccountId(result);
    if (!verifiedId || verifiedId !== accountId) {
      return { ok: false, status: 403, error: 'ပလက်ဖောင်းအကောင့် ID မကိုက်ညီပါ။ ပြန်လည်ဝင်ရောက်ပါ။' };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 502, error: 'ပလက်ဖောင်း ID ကို ဆာဗာမှ အတည်မပြုနိုင်ပါ။ ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ထပ်ကြိုးစားပါ။' };
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function readSessionCookie(req) {
  for (const item of String(req.headers.cookie || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = item.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
  }
  return null;
}

async function getUserSession(req) {
  const rawToken = readSessionCookie(req);
  if (!rawToken || !databaseReady) return null;
  const [rows] = await pool.execute(
    'SELECT session_hash, platform, account_id, csrf_hash, expires_at FROM user_sessions WHERE session_hash = ? AND expires_at > ? LIMIT 1',
    [sha256(rawToken), Date.now()]
  );
  return rows[0] || null;
}

function validCsrf(req, session) {
  const supplied = req.headers['x-ultra-csrf'];
  if (typeof supplied !== 'string' || supplied.length < 24 || supplied.length > 128) return false;
  const expectedHash = Buffer.from(String(session.csrf_hash), 'hex');
  const actualHash = Buffer.from(sha256(supplied), 'hex');
  return expectedHash.length === actualHash.length && timingSafeEqual(expectedHash, actualHash);
}

function sessionCookie(value, maxAge) {
  const secure = process.env.SESSION_COOKIE_SECURE !== 'false';
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=${secure ? 'None' : 'Lax'}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function validTelegramAdminId() {
  return /^\d{4,20}$/.test(TELEGRAM_ADMIN_ID);
}

function rateAllowed(key, max, windowMs) {
  const now = Date.now();
  let entry = requestLimits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    requestLimits.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= max;
}

function clientKey(req, suffix) {
  return `${req.socket.remoteAddress || 'unknown'}:${suffix}`;
}

function queryValue(url, name, max = 128) {
  const value = url.searchParams.get(name) || '';
  return value.length <= max ? value : '';
}

async function isApproved(platform, accountId, executor = pool) {
  const [rows] = await executor.execute(
    'SELECT 1 FROM approved_accounts WHERE platform = ? AND account_id = ? LIMIT 1',
    [platform, accountId]
  );
  return rows.length > 0;
}

async function telegramCall(method, payload, timeoutMs = 15000) {
  if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_NOT_CONFIGURED');
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new Error('TELEGRAM_NETWORK_ERROR');
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('TELEGRAM_BAD_RESPONSE'); }
  if (!response.ok || !result.ok) throw new Error('TELEGRAM_API_ERROR');
  return result.result;
}

function approvalKeyboard(requestId) {
  return {
    inline_keyboard: [[
      { text: '✅ ခွင့်ပြုမည်', callback_data: `a:${requestId}` },
      { text: '❌ ပယ်ချမည်', callback_data: `r:${requestId}` }
    ]]
  };
}

function approvalMessage(row) {
  return `🆕 ID အတည်ပြုရန် တောင်းဆိုမှု\nပလက်ဖောင်း: ${row.platform}\nအကောင့် ID: ${row.account_id}\n\nအုပ်ချုပ်သူက ခွင့်ပြုပြီးနောက် ဤ ID ဖြင့် နောက်တစ်ကြိမ် အကောင့်ဝင်ရာတွင် ထပ်မံခွင့်ပြုချက် တောင်းရန်မလိုပါ။`;
}

async function sendApprovalMessage(row, replaceMessage = false) {
  const sent = await telegramCall('sendMessage', {
    chat_id: TELEGRAM_ADMIN_ID,
    text: approvalMessage(row),
    reply_markup: approvalKeyboard(row.request_id)
  });
  if (row.status === 'pending') {
    await pool.execute(
      'UPDATE approval_requests SET telegram_message_id = ?, notified_at = ? WHERE request_id = ? AND status = ?',
      [sent.message_id, Date.now(), row.request_id, 'pending']
    );
  }
  return sent;
}

async function createOrReuseRequest(platform, accountId) {
  const requestId = randomBytes(16).toString('hex');
  const now = Date.now();
  await pool.execute(`
    INSERT INTO approval_requests
      (request_id, platform, account_id, status, created_at, decided_at, notified_at, telegram_message_id)
    VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL)
    ON DUPLICATE KEY UPDATE
      request_id = IF(status = 'pending', request_id, VALUES(request_id)),
      created_at = IF(status = 'pending', created_at, VALUES(created_at)),
      decided_at = IF(status = 'pending', decided_at, NULL),
      notified_at = IF(status = 'pending', notified_at, NULL),
      telegram_message_id = IF(status = 'pending', telegram_message_id, NULL),
      status = IF(status = 'pending', status, 'pending')`,
    [requestId, platform, accountId, now]
  );
  const [rows] = await pool.execute(
    'SELECT request_id, platform, account_id, status, notified_at, telegram_message_id FROM approval_requests WHERE platform = ? AND account_id = ? LIMIT 1',
    [platform, accountId]
  );
  if (!rows.length) throw new Error('REQUEST_CREATE_FAILED');
  return rows[0];
}

async function notifyPendingIfNeeded(row) {
  const previousClaim = row.notified_at === null ? null : Number(row.notified_at);
  const now = Date.now();
  const staleClaimCutoff = -(now - 60_000);
  if (previousClaim !== null && previousClaim > 0) return true;
  if (previousClaim !== null && previousClaim < 0 && previousClaim !== -1 && previousClaim <= staleClaimCutoff) return true;
  const claimValue = -now;
  const [claim] = await pool.execute(
    'UPDATE approval_requests SET notified_at = ? WHERE request_id = ? AND status = ? AND (notified_at IS NULL OR notified_at = -1 OR notified_at = 0 OR (notified_at < 0 AND notified_at > ?))',
    [claimValue, row.request_id, 'pending', staleClaimCutoff]
  );
  if (claim.affectedRows !== 1) return true;
  try {
    await sendApprovalMessage(row);
    return true;
  } catch {
    await pool.execute(
      'UPDATE approval_requests SET notified_at = NULL WHERE request_id = ? AND status = ? AND notified_at = ?',
      [row.request_id, 'pending', claimValue]
    );
    return false;
  }
}

async function requestApproval(platform, accountId) {
  if (!databaseReady) return { http: 503, body: { error: 'အတည်ပြုချက်ဒေတာဘေ့စ်ကို မပြင်ဆင်ရသေးပါ။' } };
  if (await isApproved(platform, accountId)) return { http: 200, body: { status: 'approved' } };
  if (!telegramReady || !validTelegramAdminId()) {
    return { http: 503, body: { error: 'Telegram ဘော့ချိတ်ဆက်မှုကို မပြင်ဆင်ရသေးပါ။ အုပ်ချုပ်သူကို အသိပေးပါ။' } };
  }
  const row = await createOrReuseRequest(platform, accountId);
  const notified = await notifyPendingIfNeeded(row);
  if (!notified) {
    return { http: 502, body: { error: 'ID ကို Telegram အုပ်ချုပ်သူထံ ပို့မရပါ။ အုပ်ချုပ်သူက Telegram ဘော့ထံ /start ပို့ထားကြောင်း စစ်ဆေးပြီး ထပ်ကြိုးစားပါ။', status: 'pending' } };
  }
  return { http: 200, body: { status: 'pending', requestId: row.request_id } };
}

async function approvalStatus(requestId, platform, accountId) {
  if (await isApproved(platform, accountId)) return { status: 'approved' };
  const [rows] = await pool.execute(
    'SELECT status FROM approval_requests WHERE request_id = ? AND platform = ? AND account_id = ? LIMIT 1',
    [requestId, platform, accountId]
  );
  return { status: rows[0]?.status || 'not_found' };
}

async function decideApproval(requestId, decision) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT request_id, platform, account_id, status FROM approval_requests WHERE request_id = ? FOR UPDATE',
      [requestId]
    );
    const row = rows[0];
    if (!row || row.status !== 'pending') {
      await connection.commit();
      return { outcome: 'already_handled', row: row || null };
    }
    const now = Date.now();
    if (decision === 'approve') {
      await connection.execute(`
        INSERT INTO approved_accounts (platform, account_id, approved_by, approved_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE approved_by = VALUES(approved_by), approved_at = VALUES(approved_at)`,
        [row.platform, row.account_id, TELEGRAM_ADMIN_ID, now]
      );
    }
    await connection.execute(
      'UPDATE approval_requests SET status = ?, decided_at = ? WHERE request_id = ? AND status = ?',
      [decision === 'approve' ? 'approved' : 'rejected', now, requestId, 'pending']
    );
    await connection.commit();
    return { outcome: decision, row };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function handleCallback(callback) {
  const adminOnly = String(callback.from?.id || '') === TELEGRAM_ADMIN_ID &&
    String(callback.message?.chat?.id || '') === TELEGRAM_ADMIN_ID &&
    callback.message?.chat?.type === 'private';
  if (!adminOnly) {
    try { await telegramCall('answerCallbackQuery', { callback_query_id: callback.id, text: 'ဤလုပ်ဆောင်မှုကို ခွင့်ပြုမထားပါ။', show_alert: true }); }
    catch { /* A stale callback needs no retry. */ }
    return;
  }
  const data = String(callback.data || '');
  // Remove approved ID callback: rm:platform:accountId
  const rmMatch = data.match(/^rm:([^:]+):(.+)$/);
  if (rmMatch) {
    try { await telegramCall('answerCallbackQuery', { callback_query_id: callback.id, text: 'ဖျက်နေသည်…' }); }
    catch { /* ignore */ }
    const platform = rmMatch[1];
    const accountId = rmMatch[2];
    const [res] = await pool.execute(
      'DELETE FROM approved_accounts WHERE platform = ? AND account_id = ?',
      [platform, accountId]
    );
    const msg = res.affectedRows > 0
      ? `✅ ဖျက်ပြီး: ${platform} / ${accountId}`
      : `❌ မတွေ့ပါ: ${platform} / ${accountId}`;
    try {
      await telegramCall('editMessageText', {
        chat_id: TELEGRAM_ADMIN_ID,
        message_id: callback.message.message_id,
        text: (callback.message.text || '') + `\n\n${msg}`,
        reply_markup: { inline_keyboard: [] }
      });
    } catch {
      await telegramCall('sendMessage', { chat_id: TELEGRAM_ADMIN_ID, text: msg });
    }
    return;
  }
  const match = data.match(/^([ar]):([a-f0-9]{32})$/);
  if (!match) {
    try { await telegramCall('answerCallbackQuery', { callback_query_id: callback.id, text: 'တောင်းဆိုမှု ID မမှန်ပါ။', show_alert: true }); }
    catch { /* A stale callback needs no retry. */ }
    return;
  }
  try { await telegramCall('answerCallbackQuery', { callback_query_id: callback.id, text: 'စစ်ဆေးနေပါသည်…' }); }
  catch { /* Continue the idempotent database decision if the spinner expired. */ }
  const decision = match[1] === 'a' ? 'approve' : 'reject';
  const result = await decideApproval(match[2], decision);
  if (!result.row) return;
  const stateText = result.outcome === 'approve' ? '✅ အတည်ပြုပြီး' : result.outcome === 'reject' ? '❌ ပယ်ချပြီး' : 'ℹ️ ယခင်က ဆုံးဖြတ်ပြီး';
  try {
    await telegramCall('editMessageText', {
      chat_id: TELEGRAM_ADMIN_ID,
      message_id: callback.message.message_id,
      text: `${approvalMessage(result.row)}\n\n${stateText}`,
      reply_markup: { inline_keyboard: [] }
    });
  } catch { console.error('Telegram approval message update failed.'); }
}

async function sendPendingList() {
  const [rows] = await pool.execute(
    "SELECT request_id, platform, account_id, status, notified_at FROM approval_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10"
  );
  if (!rows.length) {
    await telegramCall('sendMessage', { chat_id: TELEGRAM_ADMIN_ID, text: 'လက်ရှိ စောင့်ဆိုင်းနေသော ID တောင်းဆိုမှု မရှိပါ။' });
    return;
  }
  for (const row of rows) {
    try { await sendApprovalMessage(row, true); }
    catch { await telegramCall('sendMessage', { chat_id: TELEGRAM_ADMIN_ID, text: `တောင်းဆိုမှုကို ပြန်ပို့မရပါ: ${row.platform} / ${row.account_id}` }); }
  }
}

async function sendAllowedList() {
  const [rows] = await pool.execute(
    'SELECT platform, account_id, approved_at FROM approved_accounts ORDER BY approved_at DESC LIMIT 50'
  );
  if (!rows.length) {
    await telegramCall('sendMessage', { chat_id: TELEGRAM_ADMIN_ID, text: 'အတည်ပြုပြီး ID မရှိသေးပါ။', reply_markup: ADMIN_REPLY_KEYBOARD });
    return;
  }
  let text = `✅ Allowed IDs (${rows.length}):\n\n`;
  const keyboard = [];
  for (const row of rows) {
    const date = new Date(Number(row.approved_at)).toLocaleString('en-GB', { timeZone: 'Asia/Yangon' });
    text += `• ${row.platform} / ${row.account_id}\n  (${date})\n`;
    keyboard.push([{
      text: `🗑 Remove ${row.platform} ${row.account_id}`,
      callback_data: `rm:${row.platform}:${row.account_id}`.slice(0, 64)
    }]);
  }
  // Telegram limit ~4096 chars
  if (text.length > 3500) text = text.slice(0, 3500) + '\n…';
  await telegramCall('sendMessage', {
    chat_id: TELEGRAM_ADMIN_ID,
    text,
    reply_markup: { inline_keyboard: keyboard.slice(0, 20) }
  });
}

async function sendUserStatus() {
  const [approved] = await pool.execute('SELECT COUNT(*) AS c FROM approved_accounts');
  const [active] = await pool.execute(
    'SELECT COUNT(DISTINCT platform, account_id) AS c FROM user_sessions WHERE expires_at > ?',
    [Date.now()]
  );
  const [sessions] = await pool.execute(
    'SELECT platform, account_id, created_at, expires_at FROM user_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 30',
    [Date.now()]
  );
  let text = `📊 User Status\n\n`;
  text += `✅ အတည်ပြုပြီး ID အရေအတွက်: ${approved[0].c}\n`;
  text += `🟢 Login ဝင်ထားသူ (active session): ${active[0].c}\n\n`;
  if (sessions.length) {
    text += `Login ဝင်ထားသူများ:\n`;
    for (const s of sessions) {
      text += `• ${s.platform} / ${s.account_id}\n`;
    }
    text += `\n(မှတ်ချက်: Phone / Password ကို လုံခြုံရေးအရ သိမ်းမထားပါ။)`;
  } else {
    text += 'လက်ရှိ active session မရှိပါ။';
  }
  await telegramCall('sendMessage', {
    chat_id: TELEGRAM_ADMIN_ID,
    text,
    reply_markup: ADMIN_REPLY_KEYBOARD
  });
}

async function handleBotMessage(message) {
  const isAdmin = String(message.from?.id || '') === TELEGRAM_ADMIN_ID &&
    String(message.chat?.id || '') === TELEGRAM_ADMIN_ID &&
    message.chat?.type === 'private';
  if (!isAdmin) return;
  const text = String(message.text || '').trim();
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    adminPendingAction = null;
    await telegramCall('sendMessage', {
      chat_id: TELEGRAM_ADMIN_ID,
      text: 'ULTRA ID အတည်ပြုရေး Bot ချိတ်ဆက်ပြီးပါပြီ။\n\nခလုတ်များ:\n• Allowed ID – အတည်ပြုပြီး ID များ\n• Remove ID – အတည်ပြုပြီး ID ပယ်ဖျက်ရန်\n• User Status – အသုံးပြုသူနှင့် Login အခြေအနေ\n• Broadcast – User များထံ စာပို့ရန်\n\n/pending ဖြင့် စောင့်ဆိုင်းနေသော တောင်းဆိုမှုများ ကြည့်နိုင်သည်။',
      reply_markup: ADMIN_REPLY_KEYBOARD
    });
  } else if (/^\/pending(?:@\w+)?(?:\s|$)/i.test(text)) {
    adminPendingAction = null;
    await sendPendingList();
  } else if (text === 'Allowed ID') {
    adminPendingAction = null;
    await sendAllowedList();
  } else if (text === 'Remove ID') {
    adminPendingAction = 'remove';
    await telegramCall('sendMessage', {
      chat_id: TELEGRAM_ADMIN_ID,
      text: 'ပယ်ဖျက်လိုသော ID ကို ပို့ပါ။\nပုံစံ: platform accountId\nဥပမာ: 4d 101479\n\nသို့မဟုတ် “Allowed ID” ဖြင့် စာရင်းကြည့်ပြီး callback ခလုတ်သုံးပါ။\nပယ်ဖျက်မှု ပယ်ဖျက်ရန် /start နှိပ်ပါ။'
    });
  } else if (text === 'User Status') {
    adminPendingAction = null;
    await sendUserStatus();
  } else if (text === 'Broadcast') {
    adminPendingAction = 'broadcast';
    await telegramCall('sendMessage', {
      chat_id: TELEGRAM_ADMIN_ID,
      text: '📢 Broadcast လုပ်မည့် စာသားကို ပို့ပါ။\nUser များထံ လှပသော Dialog ဖြင့် ပေါ်ပါမည်။\nပယ်ဖျက်ရန် /start နှိပ်ပါ။'
    });
  } else if (adminPendingAction === 'broadcast') {
    adminPendingAction = null;
    const msg = text.slice(0, 2000);
    if (!msg) {
      await telegramCall('sendMessage', { chat_id: TELEGRAM_ADMIN_ID, text: 'စာသား မရှိပါ။' });
      return;
    }
    const [result] = await pool.execute(
      'INSERT INTO broadcasts (message, created_at) VALUES (?, ?)',
      [msg, Date.now()]
    );
    await telegramCall('sendMessage', {
      chat_id: TELEGRAM_ADMIN_ID,
      text: `✅ Broadcast သိမ်းပြီးပါပြီ (ID: ${result.insertId})။ Login ဝင်ထားသော User များထံ Dialog ပေါ်ပါမည်။`,
      reply_markup: ADMIN_REPLY_KEYBOARD
    });
  } else if (adminPendingAction === 'remove') {
    adminPendingAction = null;
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await telegramCall('sendMessage', { chat_id: TELEGRAM_ADMIN_ID, text: 'ပုံစံ မမှန်ပါ။ platform accountId ပုံစံဖြင့် ပို့ပါ။' });
      return;
    }
    const platform = parts[0];
    const accountId = parts.slice(1).join(' ');
    const [res] = await pool.execute(
      'DELETE FROM approved_accounts WHERE platform = ? AND account_id = ?',
      [platform, accountId]
    );
    if (res.affectedRows > 0) {
      await telegramCall('sendMessage', {
        chat_id: TELEGRAM_ADMIN_ID,
        text: `✅ ဖျက်ပြီး: ${platform} / ${accountId}`,
        reply_markup: ADMIN_REPLY_KEYBOARD
      });
    } else {
      await telegramCall('sendMessage', {
        chat_id: TELEGRAM_ADMIN_ID,
        text: `❌ မတွေ့ပါ: ${platform} / ${accountId}`,
        reply_markup: ADMIN_REPLY_KEYBOARD
      });
    }
  }
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleBotMessage(update.message);
}

async function pollTelegram() {
  while (!stopping) {
    if (!telegramReady) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      try {
        await telegramCall('deleteWebhook', { drop_pending_updates: false });
        await telegramCall('getMe', {});
        telegramReady = true;
        console.log('Telegram Bot reconnected.');
      } catch { continue; }
      continue;
    }
    try {
      const updates = await telegramCall('getUpdates', {
        offset: telegramOffset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      }, 35000);
      for (const update of updates) {
        try {
          await handleTelegramUpdate(update);
          telegramOffset = Math.max(telegramOffset, Number(update.update_id) + 1);
        } catch {
          console.error('Telegram update handling failed; update will be retried.');
          await new Promise(resolve => setTimeout(resolve, 3000));
          break;
        }
      }
    } catch {
      if (!stopping) {
        telegramReady = false;
        console.error('Telegram polling paused; retrying connection.');
      }
    }
  }
}

async function initializeTelegram() {
  if (!TELEGRAM_TOKEN || !validTelegramAdminId()) {
    console.log('Telegram Bot credentials are not configured yet.');
    return;
  }
  try {
    await telegramCall('deleteWebhook', { drop_pending_updates: false });
    await telegramCall('getMe', {});
    telegramReady = true;
    console.log('Telegram Bot connected; long polling is active.');
  } catch {
    telegramReady = false;
    console.error('Telegram Bot could not connect yet; retrying in the background.');
  }
  void pollTelegram();
}

async function handleApprovalRequest(req, res) {
  if (!databaseReady) return sendJson(res, 503, { error: 'အတည်ပြုချက်ဒေတာဘေ့စ်ကို မပြင်ဆင်ရသေးပါ။' });
  if (!rateAllowed(clientKey(req, 'approval'), 12, 10 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'တောင်းဆိုမှုများလွန်းပါသည်။ ခဏစောင့်ပြီး ပြန်ကြိုးစားပါ။' });
  }
  let body;
  try { body = await readJson(req, 2048); }
  catch (error) { return sendJson(res, error.statusCode || 400, { error: 'တောင်းဆိုမှုပုံစံ မမှန်ပါ။' }); }
  const platform = body.platform;
  const accountId = body.accountId;
  const platformToken = body.platformToken;
  if (!validPlatform(platform)) return sendJson(res, 400, { error: 'ပလက်ဖောင်း မမှန်ပါ။' });
  if (!validAccountId(accountId)) return sendJson(res, 400, { error: 'အကောင့် ID ပုံစံ မမှန်ပါ။' });
  const verification = await verifyPlatformIdentity(platform, accountId, platformToken);
  if (!verification.ok) return sendJson(res, verification.status, { error: verification.error });
  try {
    const result = await requestApproval(platform, accountId);
    return sendJson(res, result.http, result.body);
  } catch {
    return sendJson(res, 502, { error: 'အတည်ပြုချက်တောင်းဆိုမှုကို ဆောင်ရွက်ရာတွင် အမှားဖြစ်နေပါသည်။' });
  }
}

async function handleApprovalStatus(req, res, url) {
  if (!databaseReady) return sendJson(res, 503, { error: 'အတည်ပြုချက်ဒေတာဘေ့စ်ကို မပြင်ဆင်ရသေးပါ။' });
  const requestId = queryValue(url, 'requestId', 32);
  const platform = queryValue(url, 'platform', 32);
  const accountId = queryValue(url, 'accountId', 64);
  if (!/^[a-f0-9]{32}$/.test(requestId) || !validPlatform(platform) || !validAccountId(accountId)) {
    return sendJson(res, 400, { error: 'တောင်းဆိုမှု အချက်အလက် မမှန်ပါ။' });
  }
  try { return sendJson(res, 200, await approvalStatus(requestId, platform, accountId)); }
  catch { return sendJson(res, 502, { error: 'အတည်ပြုချက်အခြေအနေကို စစ်ဆေးမရပါ။' }); }
}

async function handleApprovalCheck(req, res) {
  if (!databaseReady) return sendJson(res, 503, { error: 'အတည်ပြုချက်ဒေတာဘေ့စ်ကို မပြင်ဆင်ရသေးပါ။' });
  let body;
  try { body = await readJson(req, 6144); }
  catch (error) { return sendJson(res, error.statusCode || 400, { error: 'တောင်းဆိုမှုပုံစံ မမှန်ပါ။' }); }
  const platform = body.platform;
  const accountId = body.accountId;
  if (!validPlatform(platform) || !validAccountId(accountId)) return sendJson(res, 400, { error: 'အကောင့်အချက်အလက် မမှန်ပါ။' });
  const verification = await verifyPlatformIdentity(platform, accountId, body.platformToken);
  if (!verification.ok) return sendJson(res, verification.status, { error: verification.error });
  try { return sendJson(res, 200, { approved: await isApproved(platform, accountId) }); }
  catch { return sendJson(res, 502, { error: 'အတည်ပြုချက်ကို စစ်ဆေးမရပါ။' }); }
}

async function handleSessionStart(req, res) {
  if (!databaseReady) return sendJson(res, 503, { error: 'ဒေတာဘေ့စ်နှင့် ချိတ်ဆက်၍မရပါ။' });
  if (!rateAllowed(clientKey(req, 'session-start'), 20, 10 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'အကောင့်ဝင်ရန် ကြိုးစားမှုများလွန်းနေပါသည်။ ခဏစောင့်ပြီး ထပ်ကြိုးစားပါ။' });
  }
  let body;
  try { body = await readJson(req, 6144); }
  catch (error) { return sendJson(res, error.statusCode || 400, { error: 'တောင်းဆိုမှုပုံစံ မမှန်ပါ။' }); }
  const { platform, accountId, platformToken } = body;
  if (!validPlatform(platform) || !validAccountId(accountId)) return sendJson(res, 400, { error: 'အကောင့်အချက်အလက် မမှန်ပါ။' });
  const verification = await verifyPlatformIdentity(platform, accountId, platformToken);
  if (!verification.ok) return sendJson(res, verification.status, { error: verification.error });
  try {
    if (!await isApproved(platform, accountId)) return sendJson(res, 403, { error: 'ဤ ID ကို အုပ်ချုပ်သူက အတည်ပြုပြီးမှ ဝင်ရောက်နိုင်ပါသည်။' });
    const rawSession = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    await pool.execute(
      'INSERT INTO user_sessions (session_hash, platform, account_id, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [sha256(rawSession), platform, accountId, sha256(csrfToken), now, now + SESSION_TTL_MS]
    );
    return sendJson(res, 200, { ok: true, csrfToken, expiresAt: now + SESSION_TTL_MS }, {
      'Set-Cookie': sessionCookie(rawSession, SESSION_TTL_SECONDS)
    });
  } catch { return sendJson(res, 502, { error: 'ဆာဗာ session ဖန်တီးမရပါ။ ထပ်ကြိုးစားပါ။' }); }
}

async function handleSessionLogout(req, res) {
  const clearCookie = sessionCookie('', 0);
  let session;
  try { session = await getUserSession(req); }
  catch { return sendJson(res, 502, { error: 'အကောင့်ဝင်မှုကို ပိတ်မရပါ။' }, { 'Set-Cookie': clearCookie }); }
  if (!session) return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  if (!validCsrf(req, session)) return sendJson(res, 403, { error: 'တောင်းဆိုမှုလုံခြုံရေးစစ်ဆေးမှု မအောင်မြင်ပါ။ စာမျက်နှာကို ပြန်ဖွင့်ပြီး ထပ်ကြိုးစားပါ။' });
  try {
    await pool.execute('DELETE FROM user_sessions WHERE session_hash = ?', [session.session_hash]);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  } catch { return sendJson(res, 502, { error: 'အကောင့်ဝင်မှုကို ပိတ်မရပါ။' }); }
}

function chatDto(row) {
  const timestamp = Number(row.created_at);
  return {
    id: Number(row.id),
    platform: row.platform,
    username: row.account_id,
    message: row.message,
    timestamp,
    time: new Date(timestamp).toLocaleTimeString('my-MM', { hour: '2-digit', minute: '2-digit' })
  };
}

async function handleChatGet(req, res, url) {
  if (!databaseReady) return sendJson(res, 503, { error: 'စကားပြောခန်းဒေတာဘေ့စ်ကို မပြင်ဆင်ရသေးပါ။' });
  const afterRaw = queryValue(url, 'after', 20) || '0';
  const after = /^\d+$/.test(afterRaw) ? Number(afterRaw) : NaN;
  if (!Number.isSafeInteger(after) || after < 0) return sendJson(res, 400, { error: 'စကားပြောခန်းအညွှန်း မမှန်ပါ။' });
  try {
    const session = await getUserSession(req);
    if (!session) return sendJson(res, 401, { error: 'အကောင့်ဝင်ခွင့် သက်တမ်းကုန်ပါပြီ။ ပြန်လည်ဝင်ရောက်ပါ။' });
    if (!await isApproved(session.platform, session.account_id)) return sendJson(res, 403, { error: 'အုပ်ချုပ်သူအတည်ပြုထားသော အကောင့်များသာ စကားပြောခန်း အသုံးပြုနိုင်ပါသည်။' });
    let rows;
    if (after === 0) {
      [rows] = await pool.execute('SELECT id, platform, account_id, message, created_at FROM chat_messages ORDER BY id DESC LIMIT 60');
      rows.reverse();
    } else {
      [rows] = await pool.execute('SELECT id, platform, account_id, message, created_at FROM chat_messages WHERE id > ? ORDER BY id ASC LIMIT 60', [after]);
    }
    return sendJson(res, 200, { messages: rows.map(chatDto) });
  } catch { return sendJson(res, 502, { error: 'စကားပြောခန်းစာများကို ဖတ်မရပါ။' }); }
}

async function handleChatPost(req, res) {
  if (!databaseReady) return sendJson(res, 503, { error: 'စကားပြောခန်းဒေတာဘေ့စ်ကို မပြင်ဆင်ရသေးပါ။' });
  if (!rateAllowed(clientKey(req, 'chat'), 30, 60 * 1000)) return sendJson(res, 429, { error: 'စကားပြောခန်းစာပို့မှု များလွန်းနေပါသည်။' });
  let session;
  try { session = await getUserSession(req); }
  catch { return sendJson(res, 502, { error: 'အကောင့်ဝင်မှုကို စစ်ဆေးမရပါ။' }); }
  if (!session) return sendJson(res, 401, { error: 'အကောင့်ဝင်ခွင့် သက်တမ်းကုန်ပါပြီ။ ပြန်လည်ဝင်ရောက်ပါ။' });
  if (!validCsrf(req, session)) return sendJson(res, 403, { error: 'တောင်းဆိုမှုလုံခြုံရေးစစ်ဆေးမှု မအောင်မြင်ပါ။ စာမျက်နှာကို ပြန်ဖွင့်ပြီး ထပ်ကြိုးစားပါ။' });
  try {
    if (!await isApproved(session.platform, session.account_id)) return sendJson(res, 403, { error: 'အုပ်ချုပ်သူအတည်ပြုထားသော အကောင့်များသာ စကားပြောခန်း အသုံးပြုနိုင်ပါသည်။' });
  } catch { return sendJson(res, 502, { error: 'အတည်ပြုချက်ကို စစ်ဆေးမရပါ။' }); }
  let body;
  try { body = await readJson(req, 4096); }
  catch (error) { return sendJson(res, error.statusCode || 400, { error: 'တောင်းဆိုမှုပုံစံ မမှန်ပါ။' }); }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 1000) return sendJson(res, 400, { error: 'စာတိုသည် စာလုံး ၁ မှ ၁၀၀၀ အတွင်း ရှိရပါမည်။' });
  try {
    const timestamp = Date.now();
    const [result] = await pool.execute(
      'INSERT INTO chat_messages (platform, account_id, message, created_at) VALUES (?, ?, ?, ?)',
      [session.platform, session.account_id, message, timestamp]
    );
    return sendJson(res, 201, { message: chatDto({ id: result.insertId, platform: session.platform, account_id: session.account_id, message, created_at: timestamp }) });
  } catch { return sendJson(res, 502, { error: 'စကားပြောခန်းစာကို သိမ်းမရပါ။' }); }
}

async function handleBroadcastsGet(req, res, url) {
  if (!databaseReady) return sendJson(res, 503, { error: 'ဒေတာဘေ့စ်ကို မပြင်ဆင်ရသေးပါ။' });
  // Optional after= id for polling
  const after = Number(url.searchParams.get('after') || 0) || 0;
  try {
    const [rows] = await pool.execute(
      'SELECT id, message, created_at FROM broadcasts WHERE id > ? ORDER BY id ASC LIMIT 5',
      [after]
    );
    return sendJson(res, 200, {
      broadcasts: rows.map(r => ({
        id: Number(r.id),
        message: r.message,
        createdAt: Number(r.created_at)
      }))
    });
  } catch {
    return sendJson(res, 502, { error: 'Broadcast များကို ဖတ်မရပါ။' });
  }
}

async function handleApi(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, databaseReady ? 200 : 503, { ok: databaseReady, databaseReady, telegramReady });
  }
  if (pathname === '/api/session/start' && req.method === 'POST') return handleSessionStart(req, res);
  if (pathname === '/api/session/logout' && req.method === 'POST') return handleSessionLogout(req, res);
  if (pathname === '/api/approval/request' && req.method === 'POST') return handleApprovalRequest(req, res);
  if (pathname === '/api/approval/status' && req.method === 'GET') return handleApprovalStatus(req, res, url);
  if (pathname === '/api/approval/check' && req.method === 'POST') return handleApprovalCheck(req, res);
  if (pathname === '/api/chat/messages' && req.method === 'GET') return handleChatGet(req, res, url);
  if (pathname === '/api/chat/messages' && req.method === 'POST') return handleChatPost(req, res);
  if (pathname === '/api/broadcasts' && req.method === 'GET') return handleBroadcastsGet(req, res, url);
  return sendJson(res, 404, { error: 'API လမ်းကြောင်း မတွေ့ပါ။' });
}

function serveStatic(req, res, pathname) {
  const relative = STATIC_FILES.get(pathname);
  if (!relative) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end('မတွေ့ပါ။');
  }
  const target = path.join(ROOT, relative);
  fs.readFile(target, (error, content) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('မတွေ့ပါ။');
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); }
  catch { res.writeHead(400); return res.end('တောင်းဆိုမှု မမှန်ပါ။'); }
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch { if (!res.headersSent) sendJson(res, 500, { error: 'ဆာဗာအမှား ဖြစ်နေပါသည်။' }); }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD', 'Cache-Control': 'no-store' });
    return res.end('ဤနည်းလမ်းကို ခွင့်မပြုပါ။');
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('တောင်းဆိုမှု မမှန်ပါ။'); }
  serveStatic(req, res, pathname);
});

async function start() {
  try { await initializeDatabase(); }
  catch {
    databaseReady = false;
    console.error('Managed Database initialization failed; data APIs will remain closed.');
  }
  if (databaseReady) await initializeTelegram();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ULTRA user app listening on port ${PORT}; database ready: ${databaseReady}; Telegram ready: ${telegramReady}`);
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestLimits) if (entry.resetAt <= now) requestLimits.delete(key);
}, 60_000).unref();

process.on('SIGTERM', async () => {
  stopping = true;
  server.close(async () => {
    try { if (pool) await pool.end(); } catch { /* Closing best-effort. */ }
    process.exit(0);
  });
});
process.on('SIGINT', async () => {
  stopping = true;
  server.close(async () => {
    try { if (pool) await pool.end(); } catch { /* Closing best-effort. */ }
    process.exit(0);
  });
});

if (require.main === module) void start();

module.exports = { extractPlatformAccountId, platformInfoPayload, verifyPlatformIdentity };
