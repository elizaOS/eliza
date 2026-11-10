const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');
const adsSource = fs.readFileSync(path.join(root, 'website/volos/ads.js'), 'utf8');

function page(host, slotId) {
  const scripts = [];
  const unit = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const slot = { hidden: true, querySelector() { return unit; } };
  const document = {
    head: { appendChild(node) { scripts.push(node); } },
    getElementById(id) { return id === 'valos-ad' ? slot : null; },
    createElement() { return { async: false, crossOrigin: '', src: '', onload: null }; }
  };
  vm.runInNewContext(adsSource, {
    document: document,
    location: { hostname: host },
    window: { VALHALLA_SITE: { ADSENSE_SLOT: slotId } }
  });
  return { slot: slot, unit: unit, scripts: scripts };
}

test('the entrance and the desk do not reference AdSense', () => {
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const desk = fs.readFileSync(path.join(root, 'website/os/index.html'), 'utf8');
  assert.doesNotMatch(home, /adsbygoogle|pagead2/);
  assert.doesNotMatch(desk, /adsbygoogle|pagead2/);
});

test('ads stay hidden off valos.live and when the slot is empty', () => {
  const other = page('valhalla-app.xyz', '1234567890');
  assert.equal(other.slot.hidden, true);
  assert.equal(other.scripts.length, 0);
  const empty = page('valos.live', '');
  assert.equal(empty.slot.hidden, true);
  assert.equal(empty.scripts.length, 0);
  const www = page('www.valos.live', '  ');
  assert.equal(www.slot.hidden, true);
  assert.equal(www.scripts.length, 0);
});

test('valos.live loads one async AdSense script when a slot is set', () => {
  const live = page('valos.live', '1234567890');
  assert.equal(live.slot.hidden, false);
  assert.equal(live.unit.attrs['data-ad-slot'], '1234567890');
  assert.equal(live.scripts.length, 1);
  assert.equal(live.scripts[0].async, true);
  assert.equal(live.scripts[0].crossOrigin, 'anonymous');
  assert.equal(live.scripts[0].src, 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6504655762357230');
  const html = fs.readFileSync(path.join(root, 'website/volos/index.html'), 'utf8');
  assert.match(html, />Advertisement</);
  assert.equal(html.includes('pagead2.googlesyndication.com'), false);
  const config = fs.readFileSync(path.join(root, 'website/site-config.js'), 'utf8');
  assert.match(config, /ADSENSE_SLOT:\s*""/);
});
