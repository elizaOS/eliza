const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');
const appSource = fs.readFileSync(path.join(root, 'site-build/os/app.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(root, 'site-build/os/bridge.js'), 'utf8');

function element(id) {
  return {
    id, hidden: false, dataset: {}, style: {}, textContent: '', children: [], handlers: {}, attributes: {},
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    contains(target) { return target === this; },
    focus() { this.focused = true; },
    querySelector(selector) {
      const found = selector.match(/data-task="([^"]+)"/);
      if (!found) return null;
      return this.children.find(child => child.dataset.task === found[1]) || null;
    }
  };
}

function loadDesktop(fetchImpl, options = {}) {
  const nodes = {};
  const events = {};
  function node(id) { return nodes[id] ||= element(id); }
  const windows = ['status', 'swarm', 'memory', 'browser', 'wallet'].map(name => {
    const view = node('window-' + name);
    view.hidden = true;
    view.dataset.window = name;
    const title = { textContent: name + ' title' };
    view.querySelector = selector => selector === '.title-bar h2' ? title : null;
    return view;
  });
  node('start-menu').hidden = true;
  const document = {
    getElementById: node,
    createElement() { return element('created-' + Math.random()); },
    querySelector(selector) {
      if (selector === '.status-light') return node('status-light');
      if (selector === '#window-browser iframe') return node('iframe');
      if (selector === '#window-browser .address-row a') return node('browser-link');
      return null;
    },
    querySelectorAll(selector) { return selector === '[data-window]' ? windows : []; },
    addEventListener(type, fn) { (events[type] ||= []).push(fn); }
  };
  const window = {
    setTimeout(fn) {
      if (options.timeoutImmediately) fn();
      return 1;
    },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener() {},
    innerWidth: 1280,
    innerHeight: 800
  };
  vm.runInNewContext(appSource, {
    document, window, Date, AbortController,
    fetch: (...args) => fetchImpl(...args)
  });
  return { node, windows, events, document };
}

function click(desktop, target) {
  for (const fn of desktop.handlers.click) fn({ target, preventDefault() {}, button: 0 });
}

function jsonResponse(body, type = 'application/json') {
  return { ok: true, headers: { get: () => type }, json: async () => body };
}

test('desktop icons open and Escape closes without treating HTML health as live', async () => {
  const page = loadDesktop(async () => jsonResponse('<html></html>', 'text/html'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.node('backend-status').textContent, /Not reported as live/);
  assert.equal(page.node('backend-status').dataset.state, 'error');
  click(page.node('desktop'), {
    closest(selector) { return selector === '[data-open]' ? { dataset: { open: 'wallet' } } : null; }
  });
  assert.equal(page.node('window-wallet').hidden, false);
  assert.match(page.node('desktop-announcement').textContent, /opened/);
  for (const fn of page.events.keydown) fn({ key: 'Escape', target: { tagName: 'BODY' } });
  assert.equal(page.node('window-wallet').hidden, true);
  click(page.node('desktop'), {
    closest(selector) { return selector === '[data-open]' ? { dataset: { open: 'status' } } : null; }
  });
  for (const fn of page.events.keydown) fn({ key: 'Escape', target: { tagName: 'TEXTAREA' } });
  assert.equal(page.node('window-status').hidden, false);
});

test('health accepts only an explicit service status and fails closed on timeout', async () => {
  let mode = 'live';
  const page = loadDesktop(async () => mode === 'ok'
    ? jsonResponse({ status: 'ok', engine: 'fixture' })
    : jsonResponse({ status: 'live' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.node('backend-status').dataset.state, 'error');
  assert.doesNotMatch(page.node('backend-status').textContent, /fixture/);
  mode = 'ok';
  click(page.node('desktop'), {
    closest(selector) {
      if (selector === '[data-refresh]') return {};
      return null;
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.node('backend-status').dataset.state, 'ok');
  assert.match(page.node('backend-status').textContent, /Service reports ok/);
  const timed = loadDesktop((url, init) => new Promise((resolve, reject) => {
    if (init.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), { timeoutImmediately: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(timed.node('backend-status').textContent, /timed out/);
  assert.equal(timed.node('backend-status').dataset.state, 'error');
});

test('tools menu opens from the keyboard path and closes on an outside click', () => {
  const page = loadDesktop(async () => jsonResponse({ status: 'ready' }));
  const start = page.node('start-button');
  for (const fn of start.handlers.click) fn();
  assert.equal(page.node('start-menu').hidden, false);
  assert.equal(start.attributes['aria-expanded'], 'true');
  for (const fn of page.events.click) fn({ target: page.node('desktop') });
  assert.equal(page.node('start-menu').hidden, true);
});

function loadChat(fetchImpl, site = { CHAT_URL: 'https://chat.example.test' }) {
  const nodes = {};
  function node(id) {
    return nodes[id] ||= {
      id, hidden: true, disabled: false, value: '', textContent: '', dataset: {}, children: [], handlers: {},
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      setAttribute() {},
      querySelector() { return node(id + '-button'); },
      focus() {},
      appendChild(child) { this.children.push(child); return child; }
    };
  }
  const calls = [];
  const document = {
    getElementById: node,
    querySelectorAll() { return []; },
    createElement(tag) { return { tag, textContent: '', children: [], appendChild(child) { this.children.push(child); return child; } }; },
    createTextNode(text) { return { text }; }
  };
  vm.runInNewContext(bridgeSource, {
    document, window: { VALHALLA_SITE: site, setTimeout() { return 1; }, clearTimeout() {} },
    fetch: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    AbortController, URL
  });
  return { node, calls };
}

function visible(node) {
  return [node.textContent || '', node.text || '', ...(node.children || []).map(visible)].join(' ');
}

async function send(chat, text) {
  chat.node('chat-input').value = text;
  const pending = chat.node('chat-form').handlers.submit[0]({ preventDefault() {} });
  await pending;
  await new Promise(resolve => setImmediate(resolve));
}

test('assistant chat fails closed unless a real reply arrives', async () => {
  const missing = loadChat(async () => jsonResponse({}), { CHAT_URL: '' });
  await send(missing, 'hello');
  assert.equal(missing.calls.length, 0);
  assert.match(missing.node('chat-status').textContent, /not configured/i);
  assert.equal(missing.node('chat-log').children.length, 0);

  const html = loadChat(async () => jsonResponse('<html>login</html>', 'text/html'));
  await send(html, 'hello');
  assert.match(html.node('chat-status').textContent, /did not return a reply/);
  assert.doesNotMatch(visible(html.node('chat-log')), /ASSISTANT/);

  const pending = loadChat(async () => jsonResponse({ ok: false, status: 'CONFIG_PENDING', reply: 'pretend live' }));
  await send(pending, 'hello');
  assert.match(pending.node('chat-status').textContent, /No model reply was generated/);
  assert.doesNotMatch(visible(pending.node('chat-log')), /pretend live/);

  const fallback = loadChat(async () => jsonResponse({ ok: true, provider: 'valhalla-fallback', reply: 'fallback live' }));
  await send(fallback, 'hello');
  assert.doesNotMatch(visible(fallback.node('chat-log')), /fallback live/);

  const secret = loadChat(async () => jsonResponse({ ok: true, reply: 'should not send' }));
  await send(secret, 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima');
  assert.equal(secret.calls.length, 0);
  assert.match(secret.node('chat-status').textContent, /seed phrase/i);

  const live = loadChat(async () => jsonResponse({ ok: true, reply: 'pong', provider: 'fixture' }));
  await send(live, 'ping');
  assert.equal(live.calls[0].url, 'https://chat.example.test/chat');
  assert.match(visible(live.node('chat-log')), /pong/);
  assert.match(live.node('chat-status').textContent, /Reply received from fixture/);
});

test('wallet bridge source does not request a transaction or signature', () => {
  assert.doesNotMatch(bridgeSource, /eth_sendTransaction|signTransaction|signMessage|personal_sign/);
  assert.match(bridgeSource, /eth_requestAccounts/);
  assert.match(bridgeSource, /No transaction or signature is requested/);
});
