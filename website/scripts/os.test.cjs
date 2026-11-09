const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('web shell navigates only to its two local pages', () => {
  const nodes = {};
  function node(id) {
    return nodes[id] ||= {
      hidden: true, dataset: {}, style: {}, textContent: '', handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; },
      setAttribute() {}, replaceChildren() {}, querySelector() { return null; }
    };
  }
  const iframe = { src: '/' }, link = { href: '/' };
  const document = {
    getElementById: node,
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === '#window-browser iframe') return iframe;
      if (selector === '#window-browser .address-row a') return link;
      return node(selector);
    },
    addEventListener() {}
  };
  const window = { setTimeout() {}, clearTimeout() {}, setInterval() {}, addEventListener() {} };
  const source = fs.readFileSync(path.join(__dirname, '../../site-build/os/app.js'), 'utf8');
  vm.runInNewContext(source, {
    document, window, Date, AbortController,
    fetch: () => new Promise(() => {})
  });
  const change = node('browser-page').handlers.change;
  change({ target: { value: '/status/' } });
  assert.equal(iframe.src, '/status/');
  assert.equal(link.href, '/status/');
  change({ target: { value: 'javascript:alert(1)' } });
  assert.equal(iframe.src, '/status/');
  assert.equal(link.href, '/status/');
  change({ target: { value: '/' } });
  assert.equal(iframe.src, '/');
  assert.equal(link.href, '/');
});
