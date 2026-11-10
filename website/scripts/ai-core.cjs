'use strict';

const { publicSupabase } = require('./feed-core.cjs');

const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning:free';
const FALLBACK_MODEL = 'google/gemma-4-31b-it:free';
const ALLOWED = new Set([DEFAULT_MODEL, FALLBACK_MODEL]);
const WINDOW_MS = 60 * 1000;
const LIMIT = 6;
const MAX_INPUT = 2000;
const MAX_TOKENS = 600;
const SYSTEM = [
  'You are the ValOS assistant.',
  'You answer with information only.',
  'You do not give financial advice.',
  'You never claim to trade, sign, or move funds.',
  'If you do not know, say so plainly.'
].join(' ');
const hits = new Map();

function resetAiLimits() {
  hits.clear();
}

function allow(userId, now) {
  const recent = (hits.get(userId) || []).filter(function (at) { return now - at < WINDOW_MS; });
  if (recent.length >= LIMIT) {
    hits.set(userId, recent);
    return false;
  }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

function bearer(headers) {
  const raw = headers && (headers.authorization || headers.Authorization) || '';
  const match = String(raw).match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

function allowedModel(id) {
  return typeof id === 'string' && id.endsWith(':free') && ALLOWED.has(id);
}

function secretLike(text) {
  const words = String(text || '').trim().toLowerCase().split(/\s+/);
  const phrase = words.length >= 12 && words.length <= 24 && words.every(function (word) { return /^[a-z]+$/.test(word); });
  return phrase || /[1-9A-HJ-NP-Za-km-z]{64,}/.test(String(text || ''));
}

async function verifyUser(token, fetchImpl) {
  const site = publicSupabase();
  if (!site.url || !site.key || !token) return null;
  const response = await fetchImpl(site.url + '/auth/v1/user', {
    headers: { authorization: 'Bearer ' + token, apikey: site.key }
  });
  if (!response || !response.ok) return null;
  const user = await response.json();
  return user && typeof user.id === 'string' && user.id ? user : null;
}

function messageFrom(raw) {
  let payload;
  try {
    payload = JSON.parse(raw || '');
  } catch (error) {
    return { error: { status: 400, body: { error: 'A message is required.' } } };
  }
  if (!payload || typeof payload.message !== 'string' || !payload.message.trim()) {
    return { error: { status: 400, body: { error: 'A message is required.' } } };
  }
  const message = payload.message.trim();
  if (message.length > MAX_INPUT) {
    return { error: { status: 400, body: { error: 'Message is too long.' } } };
  }
  if (secretLike(message)) {
    return { error: { status: 400, body: { error: 'Do not share a seed phrase or private key.' } } };
  }
  if (payload.model != null && !allowedModel(payload.model)) {
    return { error: { status: 400, body: { error: 'Model not allowed.' } } };
  }
  return { message: message, model: payload.model || DEFAULT_MODEL };
}

async function complete(key, model, message, fetchImpl) {
  if (!allowedModel(model)) return { rejected: true };
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://valhalla-app.xyz',
      'X-Title': 'ValhallaOS'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: message }
      ]
    })
  });
  if (!response) return { reply: '' };
  if (response.status === 429) return { limited: true, reply: '' };
  if (!response.ok) return { reply: '' };
  const body = await response.json();
  const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return { reply: typeof text === 'string' ? text.trim() : '' };
}

async function handleAi(req, env, fetchImpl, now) {
  if (!req || req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed.' } };
  const token = bearer(req.headers);
  if (!token) return { status: 401, body: { error: 'Sign-in required.' } };
  let user;
  try {
    user = await verifyUser(token, fetchImpl);
  } catch (error) {
    return { status: 401, body: { error: 'Sign-in required.' } };
  }
  if (!user) return { status: 401, body: { error: 'Sign-in required.' } };
  const parsed = messageFrom(req.body);
  if (parsed.error) return parsed.error;
  const key = String(env && env.OPENROUTER_API_KEY || '');
  if (!key) return { status: 503, body: { error: 'AI not configured' } };
  if (!allow(user.id, now || Date.now())) return { status: 429, body: { error: 'Too many assistant requests.' } };
  try {
    let used = parsed.model;
    let result = await complete(key, used, parsed.message, fetchImpl);
    if (result.rejected) return { status: 400, body: { error: 'Model not allowed.' } };
    const next = used === DEFAULT_MODEL ? FALLBACK_MODEL : (used === FALLBACK_MODEL ? DEFAULT_MODEL : '');
    if ((!result.reply || result.limited) && next) {
      used = next;
      result = await complete(key, used, parsed.message, fetchImpl);
    }
    if (result && result.limited && !result.reply) return { status: 429, body: { error: 'The free model is busy. Try again shortly.' } };
    if (!result || result.rejected || !result.reply) return { status: 502, body: { error: 'Assistant not connected' } };
    if (result.reply.includes(key)) return { status: 502, body: { error: 'Assistant not connected' } };
    return { status: 200, body: { reply: result.reply, model: used } };
  } catch (error) {
    return { status: 502, body: { error: 'Assistant not connected' } };
  }
}

function readRawBody(req) {
  if (!req || req.body == null) {
    if (!req || typeof req.on !== 'function') return Promise.resolve('');
  } else {
    if (typeof req.body === 'string') return Promise.resolve(req.body);
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));
    if (typeof req.body === 'object') return Promise.resolve(JSON.stringify(req.body));
  }
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

module.exports = {
  DEFAULT_MODEL: DEFAULT_MODEL,
  FALLBACK_MODEL: FALLBACK_MODEL,
  MAX_TOKENS: MAX_TOKENS,
  handleAi: handleAi,
  readRawBody: readRawBody,
  resetAiLimits: resetAiLimits
};
