const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routeForHost } = require('../host-route.cjs');

const root = path.join(__dirname, '../..');

test('volOS root is host-specific and does not replace the Valhalla entrance', () => {
  assert.equal(routeForHost('valos.live', '/'), '/volos/index.html');
  assert.equal(routeForHost('www.valos.live', '/index.html'), '/volos/index.html');
  assert.equal(routeForHost('VALOS.LIVE:443', '/'), '/volos/index.html');
  assert.equal(routeForHost('valos.live', '/os/'), null);
  assert.equal(routeForHost('valos.live', '/app/'), null);
  assert.equal(routeForHost('valhalla-app.xyz', '/'), null);
  assert.equal(routeForHost('www.valhalla-app.xyz', '/'), null);
  assert.equal(routeForHost('www.valhalla-app.xyz', '/volos/'), null);
  assert.equal(routeForHost('valos.live.evil.example', '/'), null);
  assert.equal(routeForHost('notvalos.live', '/'), null);
  assert.equal(routeForHost('', '/'), null);
});

test('deployment config keeps the proxy on the entrance paths only', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(config.proxy.entrypoint, 'website/proxy.mjs');
  assert.deepEqual(config.proxy.matcher, ['/', '/index.html']);
  assert.deepEqual(config.redirects, [{ source: '/app', destination: '/app/', permanent: true }]);
  const proxy = fs.readFileSync(path.join(root, 'website/proxy.mjs'), 'utf8');
  assert.match(proxy, /routeForHost/);
  assert.match(proxy, /rewrite/);
  assert.match(proxy, /next/);
});

test('proxy rewrites only a volOS root when the helper is installed', async (t) => {
  try {
    await import('@vercel/functions');
  } catch (error) {
    t.skip('install @vercel/functions to exercise the proxy response');
    return;
  }
  const { default: proxy } = await import('../proxy.mjs');
  const request = (host, pathname) => ({
    url: 'https://' + (host || 'valhalla-app.xyz') + pathname,
    headers: { get(name) { return name.toLowerCase() === 'host' ? host : null; } }
  });
  const volos = await proxy(request('valos.live', '/'));
  assert.match(volos.headers.get('x-middleware-rewrite'), /https:\/\/valos\.live\/volos\/index\.html$/);
  const www = await proxy(request('www.valos.live', '/index.html'));
  assert.match(www.headers.get('x-middleware-rewrite'), /\/volos\/index\.html$/);
  const home = await proxy(request('valhalla-app.xyz', '/'));
  assert.equal(home.headers.get('x-middleware-next'), '1');
  assert.equal(home.headers.get('x-middleware-rewrite'), null);
  const wwwHome = await proxy(request('www.valhalla-app.xyz', '/'));
  assert.equal(wwwHome.headers.get('x-middleware-next'), '1');
  const desk = await proxy(request('valos.live', '/os/'));
  assert.equal(desk.headers.get('x-middleware-next'), '1');
});
