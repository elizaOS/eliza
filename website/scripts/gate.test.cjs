const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../site-build/app/gate.js'), 'utf8');

function storage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: key => data[key] ?? null,
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; }
  };
}

function fixture({ restored = false, reject = false, human = true } = {}) {
  const now = Date.now();
  const localStorage = storage(restored ? {
    'valhalla-account': JSON.stringify({ hint: 'a***@example.test', method: 'email', termsAccepted: true })
  } : {});
  const sessionStorage = storage({
    ...(human ? { 'valhalla-human': JSON.stringify({ ok: true, at: now }) } : {}),
    'valhalla-terms-session': '2026-11-03',
    ...(restored ? { 'valhalla-auth': '1', 'valhalla-code-ok': '1' } : {})
  });
  const nodes = {}, events = {}, calls = [];
  function node(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id, hidden: true, dataset: {}, value: '', checked: false, disabled: false,
        parentElement: { clientWidth: 480 }, handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; },
        focus() {}, appendChild() {}, setAttribute() {},
        getContext() { return { fillRect() {}, beginPath() {}, arc() {}, fill() {} }; }
      };
    }
    return nodes[id];
  }
  const document = {
    readyState: 'loading',
    getElementById: node,
    querySelector: () => null,
    addEventListener(type, fn) { (events['document:' + type] ||= []).push(fn); },
    createElement: () => node('created'),
    head: { appendChild() {} }
  };
  const assigned = [];
  const window = {
    VALHALLA_SITE: { AUTH_URL: 'https://auth.example.test', TERMS_VERSION: '2026-11-03' },
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); },
    setInterval() { return 1; },
    location: {
      assign(url) { assigned.push(String(url)); },
      reload() {}
    }
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const body = url.endsWith('/auth/nonce') ? { nonce: 'fixture' }
      : url.endsWith('/auth/email/start') ? { ok: true, pending: 'pending', hint: 'a***@example.test' }
        : url.endsWith('/auth/email/verify') ? (reject ? { ok: false, error: 'code' } : { ok: true, hint: 'a***@example.test', session: 'fixture-session' })
          : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const context = {
    window, document, localStorage, sessionStorage, fetch, Date, Intl, Number, Math,
    Event: function (type) { this.type = type; },
    ValhallaErrors: { show() {} }, location: window.location,
    IntersectionObserver: function () { this.observe = () => {}; }
  };
  vm.runInNewContext(source, context);
  return {
    node, window, sessionStorage, localStorage, calls, assigned,
    ready() { for (const fn of events['document:DOMContentLoaded'] || []) fn(); }
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('restored authenticated desk announces readiness after later scripts can subscribe', () => {
  const f = fixture({ restored: true });
  let ready = 0;
  f.window.addEventListener('valhalla-desk', () => { ready++; });
  assert.equal(f.node('desk').hidden, true);
  f.ready();
  assert.equal(f.node('desk').hidden, false);
  assert.equal(ready, 1);
  assert.equal(f.node('modeBadge').textContent, 'READ ONLY');
});

for (const reject of [false, true]) {
  test(`email verification ${reject ? 'rejection keeps the gate closed' : 'opens and initializes the desk'}`, async () => {
    const f = fixture({ reject });
    let ready = 0;
    f.window.addEventListener('valhalla-desk', () => { ready++; });
    f.ready();
    f.node('magicEmail').value = 'a@example.test';
    f.node('emailForm').handlers.submit({ preventDefault() {} });
    await flush();
    assert.equal(f.node('gateCode').hidden, false);
    f.node('emailCodeInput').value = '123456';
    f.node('codeForm').handlers.submit({ preventDefault() {} });
    await flush();
    assert.equal(f.node('desk').hidden, reject);
    assert.equal(ready, reject ? 0 : 1);
    assert.equal(f.sessionStorage.getItem('valhalla-auth-token'), reject ? null : 'fixture-session');
    assert.equal(f.calls.filter(call => call.url.endsWith('/auth/nonce')).length, 2);
    assert.ok(f.calls.every(call => call.options.credentials === 'include'));
  });
}

test('missing human-check configuration does not advance the gate', () => {
  const f = fixture({ human: false });
  f.ready();
  assert.equal(f.node('gateHuman').hidden, false);
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.node('humanPlaceholder').handlers.click, undefined);
});

test('verified entrance sign-in opens the OS desk and does not show the console', async () => {
  const f = fixture();
  f.sessionStorage.setItem('valhalla-entry-desk', '1');
  f.ready();
  f.node('magicEmail').value = 'a@example.test';
  f.node('emailForm').handlers.submit({ preventDefault() {} });
  await flush();
  f.node('emailCodeInput').value = '123456';
  f.node('codeForm').handlers.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(f.assigned, ['/os/']);
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.sessionStorage.getItem('valhalla-entry-desk'), null);
  assert.equal(f.sessionStorage.getItem('valhalla-code-ok'), '1');
});

test('public paper desk control does not create a session', () => {
  const f = fixture();
  f.ready();
  f.node('openPaper').handlers.click();
  assert.deepEqual(f.assigned, ['/os/']);
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.sessionStorage.getItem('valhalla-auth'), null);
  assert.equal(f.localStorage.getItem('valhalla-session'), null);
});

test('a display name is not stored or accepted as a credential', async () => {
  const f = fixture();
  f.ready();
  f.node('createName').value = 'Not A Password';
  f.node('createEmail').value = 'a@example.test';
  f.node('createWallet').value = 'solflare';
  f.node('createForm').handlers.submit({ preventDefault() {} });
  await flush();
  const account = JSON.parse(f.localStorage.getItem('valhalla-account'));
  assert.equal(JSON.stringify(account).includes('Not A Password'), false);
  assert.equal(account.name, undefined);
  assert.equal(account.email, undefined);
  assert.equal(f.sessionStorage.getItem('valhalla-auth'), null);
  assert.equal(f.node('desk').hidden, true);
  assert.equal(f.node('gateCode').hidden, false);
});
