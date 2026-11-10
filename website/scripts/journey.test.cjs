const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');
const homeSource = fs.readFileSync(path.join(root, 'website/home.js'), 'utf8');

function entrance({ storageError = false } = {}) {
  const store = {};
  const validity = [];
  const input = {
    value: 'person@example.test',
    setCustomValidity(message) { validity.push(message); },
    reportValidity() { this.reported = true; },
    addEventListener() {}
  };
  const form = { handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } };
  const link = { handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } };
  const assigned = [];
  const sessionStorage = {
    setItem(key, value) { if (storageError) throw new Error('denied'); store[key] = String(value); },
    getItem(key) { return store[key] || null; }
  };
  vm.runInNewContext(homeSource, {
    document: {
      getElementById(id) {
        if (id === 'home-email') return form;
        if (id === 'home-email-address') return input;
        return null;
      },
      querySelectorAll() { return [link]; }
    },
    window: { location: { assign(url) { assigned.push(url); } } },
    sessionStorage
  });
  return { form, input, link, store, assigned, validity };
}

test('homepage continue stores the return preference and opens sign-in', () => {
  const page = entrance();
  page.form.handlers.submit({ preventDefault() {} });
  assert.deepEqual(page.assigned, ['/app/']);
  assert.equal(page.store['valhalla-entry-desk'], '1');
  assert.equal(page.store['valhalla-entry-email'], 'person@example.test');
  assert.equal(page.store['valhalla-auth'], undefined);
  page.link.handlers.click({ preventDefault() {} });
  assert.deepEqual(page.assigned, ['/app/', '/app/']);
  assert.equal(page.store['valhalla-auth'], undefined);
});

test('blocked storage does not pretend the entrance completed sign-in', () => {
  const page = entrance({ storageError: true });
  page.form.handlers.submit({ preventDefault() {} });
  assert.deepEqual(page.assigned, []);
  assert.match(page.validity[0], /sign-in link/i);
  page.link.handlers.click({ preventDefault() {} });
  assert.deepEqual(page.assigned, ['/app/']);
});

test('entrance and volOS copy stay honest', () => {
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const volos = fs.readFileSync(path.join(root, 'website/volos/index.html'), 'utf8');
  assert.match(home, /Continue to sign-in/);
  assert.match(home, /ValhallaOS Citadel/);
  assert.match(home, /\/assets\/poster\.jpg/);
  assert.match(home, /Live trading is off/);
  assert.doesNotMatch(home, /Trade Solana/);
  const desk = fs.readFileSync(path.join(root, 'website/os/index.html'), 'utf8');
  for (const text of [home, volos, desk]) {
    assert.doesNotMatch(text, /enterWorkstationSession|keene\.jos|operator-01@|Valhalla2033|pk_test_/);
  }
  assert.match(desk, /data-open="wallet"/);
  assert.match(desk, /LIVE TRADING OFF/);
  assert.match(desk, /disabled/);
  assert.doesNotMatch(desk, /data-enter-desk/);
  assert.match(desk, /href="\/app\/"/);
  const mobile = fs.readFileSync(path.join(root, 'website/os/os.css'), 'utf8').split('@media (max-width: 720px)')[1];
  assert.doesNotMatch(mobile, /top:\s*118px/);
  assert.doesNotMatch(mobile, /z-index:\s*\d+\s*!important/);
  assert.match(mobile, /\.menu-bar,\s*\.dock\s*\{\s*z-index:\s*1/);
  assert.match(volos, /Not published/);
  assert.match(volos, /can fall to zero/);
  assert.match(volos, /https:\/\/valhalla-app\.xyz\//);
  assert.doesNotMatch(volos, /pump\.fun/i);
  assert.doesNotMatch(volos, /will pump/i);
  assert.doesNotMatch(volos, /0x[0-9a-fA-F]{40}/);
});
