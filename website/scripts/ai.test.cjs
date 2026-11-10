const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { handleAi, resetAiLimits, DEFAULT_MODEL, FALLBACK_MODEL, MAX_TOKENS } = require('./ai-core.cjs');

const root = path.join(__dirname, '../..');

function supabase(ok) {
  return { ok: ok, json: async () => (ok ? { id: 'user-1' } : {}) };
}

function ask(message, model) {
  return JSON.stringify(model ? { message: message, model: model } : { message: message });
}

test('a missing OpenRouter key returns AI not configured and never calls OpenRouter', async () => {
  resetAiLimits();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('What is valOS?')
  }, {}, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'no' } }] }) };
  }, 1_000);
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'AI not configured' });
  assert.equal(calls.some(url => url.includes('openrouter')), false);
});

test('the assistant requires a Supabase session', async () => {
  resetAiLimits();
  const missing = await handleAi({ method: 'POST', headers: {}, body: ask('Hello') }, { OPENROUTER_API_KEY: 'server-only-key' }, async () => { throw new Error('no'); }, 2_000);
  assert.equal(missing.status, 401);
  const rejected = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer bad' },
    body: ask('Hello')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async () => supabase(false), 3_000);
  assert.equal(rejected.status, 401);
});

test('a non-free model is rejected before any completion call', async () => {
  resetAiLimits();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('Hello', 'openai/gpt-4o')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    return { ok: true, json: async () => ({}) };
  }, 4_000);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Model not allowed.');
  assert.equal(calls.some(url => url.includes('openrouter')), false);
});

test('assistant requests are limited per signed-in user', async () => {
  resetAiLimits();
  const env = { OPENROUTER_API_KEY: 'server-only-key' };
  const fetchImpl = async (url) => String(url).includes('/auth/v1/user')
    ? supabase(true)
    : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  let limited = null;
  for (let i = 0; i < 7; i += 1) {
    limited = await handleAi({ method: 'POST', headers: { authorization: 'Bearer good' }, body: ask('Hello') }, env, fetchImpl, 10_000);
  }
  assert.equal(limited.status, 429);
});

test('a free-model failure falls back to the other free model and hides the key', async () => {
  resetAiLimits();
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('What can you do?')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async (url, init) => {
    calls.push({ url: String(url), init: init });
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    const body = JSON.parse(init.body);
    assert.equal(body.model.endsWith(':free'), true);
    assert.equal(body.max_tokens, MAX_TOKENS);
    assert.equal(init.headers['HTTP-Referer'], 'https://valhalla-app.xyz');
    assert.equal(init.headers['X-Title'], 'ValhallaOS');
    assert.match(body.messages[0].content, /do not give financial advice/i);
    assert.match(body.messages[0].content, /do not know/i);
    if (body.model === DEFAULT_MODEL) return { ok: false, json: async () => ({ error: 'busy' }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'I can explain the desk. I do not trade.' } }] }) };
  }, 5_000);
  assert.equal(result.status, 200);
  assert.equal(result.body.model, FALLBACK_MODEL);
  assert.equal(result.body.reply.includes('server-only-key'), false);
  const models = calls.filter(call => call.url.includes('openrouter')).map(call => JSON.parse(call.init.body).model);
  assert.deepEqual(models, [DEFAULT_MODEL, FALLBACK_MODEL]);
});

test('a 429 from the primary free model falls through to gemma', async () => {
  resetAiLimits();
  assert.equal(DEFAULT_MODEL, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(FALLBACK_MODEL, 'google/gemma-4-31b-it:free');
  const calls = [];
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('What is the desk?')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async (url, init) => {
    calls.push(String(url) + (init && init.body ? ' ' + JSON.parse(init.body).model : ''));
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    const model = JSON.parse(init.body).model;
    assert.equal(model.endsWith(':free'), true);
    if (model === DEFAULT_MODEL) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'From the fallback free model.' } }] }) };
  }, 7_000);
  assert.equal(result.status, 200);
  assert.equal(result.body.model, FALLBACK_MODEL);
  assert.equal(calls.filter(call => call.includes('openrouter')).join(' | '), 'https://openrouter.ai/api/v1/chat/completions ' + DEFAULT_MODEL + ' | https://openrouter.ai/api/v1/chat/completions ' + FALLBACK_MODEL);
});

test('both free models returning 429 says the model is busy', async () => {
  resetAiLimits();
  const result = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask('What is the desk?')
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async (url) => {
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    return { ok: false, status: 429, json: async () => ({}) };
  }, 8_000);
  assert.equal(result.status, 429);
  assert.equal(result.body.error, 'The free model is busy. Try again shortly.');
});

test('a seed-like message is refused before OpenRouter is called', async () => {
  resetAiLimits();
  const calls = [];
  const phrase = 'one two three four five six seven eight nine ten eleven twelve';
  const secret = await handleAi({
    method: 'POST',
    headers: { authorization: 'Bearer good' },
    body: ask(phrase)
  }, { OPENROUTER_API_KEY: 'server-only-key' }, async (url) => {
    calls.push(String(url));
    if (String(url).includes('/auth/v1/user')) return supabase(true);
    return { ok: true, json: async () => ({}) };
  }, 6_000);
  assert.equal(secret.status, 400);
  assert.match(secret.body.error, /seed phrase or private key/);
  assert.equal(calls.some(url => url.includes('openrouter')), false);
});

test('an empty ask keeps the last reply and a second ask waits', async () => {
  const source = fs.readFileSync(path.join(root, 'website/os/ai.js'), 'utf8');
  const nodes = {};
  function node(id) {
    return nodes[id] ||= { id: id, value: '', textContent: '', disabled: false, handlers: {}, addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }, querySelector() { return nodes['ai-button']; } };
  }
  node('ai-form');
  node('ai-status');
  node('ai-input');
  node('ai-state');
  nodes['ai-reply'] = { textContent: 'kept' };
  nodes['ai-button'] = { disabled: false };
  const calls = [];
  let release;
  const pending = new Promise(function (resolve) { release = resolve; });
  vm.runInNewContext(source, {
    document: { body: { dataset: { session: 'in' } }, getElementById(id) { return nodes[id]; } },
    window: { ValhallaSupabase: { client: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } }) } },
    fetch: async () => {
      calls.push('fetch');
      await pending;
      return { status: 200, ok: true, json: async () => ({ reply: 'answer' }) };
    },
    JSON: JSON
  });
  const submit = nodes['ai-form'].handlers.submit[0];
  nodes['ai-input'].value = '   ';
  await submit({ preventDefault() {} });
  assert.equal(nodes['ai-reply'].textContent, 'kept');
  assert.equal(calls.length, 0);
  nodes['ai-input'].value = 'What is the desk?';
  const first = submit({ preventDefault() {} });
  const second = submit({ preventDefault() {} });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(calls.length, 1);
  assert.equal(nodes['ai-button'].disabled, true);
  release();
  await first;
  await second;
  assert.equal(calls.length, 1);
  assert.equal(nodes['ai-reply'].textContent, 'answer');
  assert.equal(nodes['ai-button'].disabled, false);
});

test('the desk says the assistant is not connected until a reply arrives', () => {
  const html = fs.readFileSync(path.join(root, 'website/os/index.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'website/os/ai.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api/ai.js'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'website/scripts/ai-core.cjs'), 'utf8');
  assert.match(html, /Assistant not connected/);
  assert.match(client, /Assistant not connected/);
  assert.match(client, /Sign-in required/);
  assert.match(client, /Too many assistant requests/);
  assert.match(client, /The free model is busy\. Try again shortly\./);
  assert.doesNotMatch(client, /OPENROUTER_API_KEY|openrouter\.ai/);
  assert.match(api, /process\.env/);
  assert.match(core, /env\.OPENROUTER_API_KEY/);
  assert.doesNotMatch(core + api, /OPENROUTER_API_KEY\s*=\s*['"][^'"]+['"]/);
  assert.match(core, /:free/);
});
