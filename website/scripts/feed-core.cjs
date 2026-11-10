'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALOS_MINT = 'AwRR84BRbzPKSvWnw4BBNYmFYmRdRTBkLxCiKzTvpump';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WINDOW_MS = 60 * 1000;
const LIMIT = 8;
const hits = new Map();

function publicSupabase() {
  const text = fs.readFileSync(path.join(__dirname, '../site-config.js'), 'utf8');
  function read(name) {
    const match = text.match(new RegExp(name + ':\\s*"([^"]*)"'));
    return match ? match[1] : '';
  }
  return { url: read('SUPABASE_URL'), key: read('SUPABASE_PUBLISHABLE_KEY') };
}

function resetFeedLimits() {
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

function walletFrom(url) {
  const query = String(url || '').split('?')[1] || '';
  const params = new URLSearchParams(query);
  const wallet = params.get('wallet') || '';
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) ? wallet : '';
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

async function rpc(key, method, params, fetchImpl) {
  const response = await fetchImpl('https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
  });
  if (!response || !response.ok) return null;
  const body = await response.json();
  return body && body.result ? body.result : null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readFeed(key, wallet, fetchImpl) {
  const priceResult = await rpc(key, 'getAsset', { id: SOL_MINT }, fetchImpl);
  const price = priceResult && priceResult.token_info && priceResult.token_info.price_info
    ? finite(priceResult.token_info.price_info.price_per_token)
    : null;
  let activity = [];
  const activityResponse = await fetchImpl(
    'https://api.helius.xyz/v0/addresses/' + VALOS_MINT + '/transactions?api-key=' + encodeURIComponent(key) + '&limit=5',
    { headers: { accept: 'application/json' } }
  );
  if (activityResponse && activityResponse.ok) {
    const rows = await activityResponse.json();
    activity = (Array.isArray(rows) ? rows : []).slice(0, 5).map(function (row) {
      return {
        signature: typeof row.signature === 'string' ? row.signature : '',
        type: typeof row.type === 'string' ? row.type : '',
        timestamp: finite(row.timestamp)
      };
    }).filter(function (row) { return row.signature; });
  }
  let balances = null;
  if (wallet) {
    const lamports = await rpc(key, 'getBalance', [wallet], fetchImpl);
    const accounts = await rpc(key, 'getTokenAccountsByOwner', [wallet, { mint: VALOS_MINT }, { encoding: 'jsonParsed' }], fetchImpl);
    const first = accounts && accounts.value && accounts.value[0];
    const parsed = first && first.account && first.account.data && first.account.data.parsed;
    const amount = parsed && parsed.info && parsed.info.tokenAmount;
    balances = {
      address: wallet,
      sol: lamports && finite(lamports.value) !== null ? finite(lamports.value) / 1000000000 : null,
      valos: amount ? finite(amount.uiAmount) : null
    };
  }
  return { solPriceUsd: price, valosActivity: activity, wallet: balances };
}

async function handleFeed(req, env, fetchImpl, now) {
  if (!req || req.method !== 'GET') return { status: 405, body: { error: 'Method not allowed.' } };
  const token = bearer(req.headers);
  if (!token) return { status: 401, body: { error: 'Sign-in required.' } };
  let user;
  try {
    user = await verifyUser(token, fetchImpl);
  } catch (error) {
    return { status: 401, body: { error: 'Sign-in required.' } };
  }
  if (!user) return { status: 401, body: { error: 'Sign-in required.' } };
  if (!allow(user.id, now || Date.now())) return { status: 429, body: { error: 'Too many feed requests.' } };
  const key = String(env && env.HELIUS_API_KEY || '');
  if (!key) return { status: 503, body: { error: 'feed not configured' } };
  try {
    const body = await readFeed(key, walletFrom(req.url), fetchImpl);
    return { status: 200, body: body };
  } catch (error) {
    return { status: 502, body: { error: 'Feed not connected' } };
  }
}

module.exports = {
  VALOS_MINT: VALOS_MINT,
  handleFeed: handleFeed,
  resetFeedLimits: resetFeedLimits,
  publicSupabase: publicSupabase
};
