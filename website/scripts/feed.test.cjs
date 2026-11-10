const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { handleFeed, resetFeedLimits, VALOS_MINT } = require('./feed-core.cjs');

const root = path.join(__dirname, '../..');
const WALLET = '11111111111111111111111111111111';

function supabase(ok) {
  return { ok: ok, json: async () => (ok ? { id: 'user-1' } : {}) };
}

function helius(url, init) {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (body && body.method === 'getAsset') {
    return { ok: true, json: async () => ({ result: { token_info: { price_info: { price_per_token: 142.5 } } } }) };
  }
  if (body && body.method === 'getBalance') {
    return { ok: true, json: async () => ({ result: { value: 2000000000 } }) };
  }
  if (body && body.method === 'getTokenAccountsByOwner') {
    return { ok: true, json: async () => ({ result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 3.5 } } } } } }] } }) };
  }
  if (String(url).includes('/transactions')) {
    return { ok: true, json: async () => ([{ signature: 'sig12345678', type: 'TRANSFER', timestamp: 10 }]) };
  }
  return { ok: false, json: async () => ({}) };
}

test('a missing Helius key returns feed not configured and never calls Helius', async () => {
  resetFeedLimits();
  const calls = [];
  const result = await handleFeed({
    method: 'GET',
    headers: { authorization: 'Bearer good' },
    url: '/api/feed'
  }, {}, async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    return helius(url, init);
  }, 1_000);
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'feed not configured' });
  assert.equal(calls.some(url => url.includes('helius')), false);
});

test('the feed requires a Supabase session and hides the key', async () => {
  resetFeedLimits();
  const missing = await handleFeed({ method: 'GET', headers: {}, url: '/api/feed' }, { HELIUS_API_KEY: 'server-only-key' }, async () => { throw new Error('no'); }, 2_000);
  assert.equal(missing.status, 401);
  const rejected = await handleFeed({
    method: 'GET',
    headers: { authorization: 'Bearer bad' },
    url: '/api/feed'
  }, { HELIUS_API_KEY: 'server-only-key' }, async () => supabase(false), 3_000);
  assert.equal(rejected.status, 401);
  const calls = [];
  const ok = await handleFeed({
    method: 'GET',
    headers: { authorization: 'Bearer good' },
    url: '/api/feed?wallet=' + WALLET
  }, { HELIUS_API_KEY: 'server-only-key' }, async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    if (String(url).includes('/auth/v1/user')) {
      assert.equal(init.headers.apikey.includes('sb_publishable_'), true);
      return supabase(true);
    }
    return helius(url, init);
  }, 4_000);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.solPriceUsd, 142.5);
  assert.equal(ok.body.valosActivity[0].type, 'TRANSFER');
  assert.equal(ok.body.wallet.sol, 2);
  assert.equal(ok.body.wallet.valos, 3.5);
  assert.equal(JSON.stringify(ok.body).includes('server-only-key'), false);
  const methods = calls.map(call => call.body).filter(Boolean).map(body => JSON.parse(body).method);
  assert.deepEqual(methods.sort(), ['getAsset', 'getBalance', 'getTokenAccountsByOwner']);
  assert.equal(calls.some(call => call.url.includes(VALOS_MINT) && call.url.includes('api-key=server-only-key')), true);
  assert.equal(calls.some(call => /sendTransaction|signTransaction/.test(call.url + (call.body || ''))), false);
});

test('feed requests are limited per signed-in user', async () => {
  resetFeedLimits();
  const env = { HELIUS_API_KEY: 'server-only-key' };
  const fetchImpl = async (url, init) => String(url).includes('/auth/v1/user') ? supabase(true) : helius(url, init);
  let limited = null;
  for (let i = 0; i < 9; i += 1) {
    limited = await handleFeed({ method: 'GET', headers: { authorization: 'Bearer good' }, url: '/api/feed' }, env, fetchImpl, 10_000);
  }
  assert.equal(limited.status, 429);
});

test('a valOS balance shows without a SOL amount and a later wallet reloads the feed', async () => {
  const feedSource = fs.readFileSync(path.join(root, 'website/os/feed.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'website/os/bridge.js'), 'utf8');
  assert.equal((bridge.match(/notifyWallet\(\);/g) || []).length, 2);
  const requests = [];
  const list = {
    children: [],
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); return child; }
  };
  const nodes = {
    'feed-status': { textContent: 'Feed not connected' },
    'feed-state': { textContent: 'NOT CONNECTED' },
    'feed-list': list
  };
  const listeners = {};
  const document = {
    body: { dataset: { session: 'in', wallet: '' } },
    getElementById(id) { return nodes[id]; },
    createElement() { return { textContent: '' }; }
  };
  const window = {
    ValhallaSupabase: {
      client: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } })
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }
  };
  vm.runInNewContext(feedSource, {
    document: document,
    window: window,
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => ({ solPriceUsd: null, valosActivity: [], wallet: { address: WALLET, sol: null, valos: 3.5 } }) };
    }
  });
  await listeners['valhalla-signed-in'][0]();
  assert.deepEqual(requests, ['/api/feed']);
  assert.equal(nodes['feed-status'].textContent, 'Live feed');
  assert.equal(nodes['feed-state'].textContent, 'CONNECTED');
  assert.deepEqual(list.children.map(item => item.textContent), ['3.5 valOS']);
  document.body.dataset.wallet = WALLET;
  await listeners['valhalla-wallet-changed'][0]();
  assert.equal(requests[1], '/api/feed?wallet=' + encodeURIComponent(WALLET));
});

test('the desk says the feed is not connected until a response arrives', () => {
  const html = fs.readFileSync(path.join(root, 'website/os/index.html'), 'utf8');
  const feed = fs.readFileSync(path.join(root, 'website/os/feed.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api/feed.js'), 'utf8');
  assert.match(html, /Feed not connected/);
  assert.match(feed, /Feed not connected/);
  assert.doesNotMatch(feed, /HELIUS_API_KEY|api-key=/);
  const core = fs.readFileSync(path.join(root, 'website/scripts/feed-core.cjs'), 'utf8');
  assert.match(core, /env\.HELIUS_API_KEY/);
  assert.match(api, /process\.env/);
  assert.doesNotMatch(core + api, /HELIUS_API_KEY\s*=\s*['"][^'"]+['"]/);
});
