const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'site-build/desk.js'), 'utf8');
const mint = 'So11111111111111111111111111111111111111112';
const names = ['VALHALLA CORE', 'MECHA BRAIN', 'ASK VALHALLA', 'ODIN FEED', 'FORGE LAB', 'HEIMDALL GATE', 'SENTINEL WATCH'];

function fixture(options = {}) {
  const data = {};
  const calls = [];
  const window = {
    VALHALLA_SITE: { STATUS_URL: options.statusURL || '' },
    setTimeout, clearTimeout,
    localStorage: {
      getItem(key) { if (options.readError) throw Error('denied'); return data[key] || null; },
      setItem(key, value) { if (options.writeError) throw Error('quota'); data[key] = value; }
    }
  };
  const fetch = async (url, init) => {
    calls.push({url, init});
    if (options.fetch) return options.fetch(url, init);
    throw Error('offline');
  };
  vm.runInNewContext(source, { window, fetch, AbortController, TextDecoder, URL, Blob });
  return { desk: window.ValhallaDesk, data, calls, window };
}

function response(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let done = false;
  return { ok: true, body: { getReader() { return { async read() {
    if (done) return {done: true};
    done = true;
    return {done: false, value: bytes};
  } }; } } };
}

test('status uses configured existing feed contract, rejects failures and stale or malformed data', async () => {
  const unconfigured = fixture();
  assert.equal((await unconfigured.desk.checkDeskStatus()).state, 'unconfigured');
  assert.equal(unconfigured.calls.length, 0);
  let body = {checkedAt: Date.now(), lines: names.map(name => ({name, state: 'LIVE'}))};
  const f = fixture({statusURL: 'https://status.example.test/', fetch: async () => response(body)});
  assert.equal((await f.desk.checkDeskStatus()).state, 'LIVE');
  assert.equal(f.calls[0].url, 'https://status.example.test/');
  assert.equal(f.calls[0].init.credentials, 'omit');
  body.lines[1].state = 'DEGRADED';
  assert.equal((await f.desk.checkDeskStatus()).state, 'DEGRADED');
  body.lines[0].state = 'OFFLINE';
  assert.equal((await f.desk.checkDeskStatus()).state, 'OFFLINE');
  body.checkedAt = Date.now() - 901000;
  assert.equal((await f.desk.checkDeskStatus()).state, 'unavailable');
  body.checkedAt = Date.now() + 100000;
  assert.equal((await f.desk.checkDeskStatus()).state, 'unavailable');
  body = {checkedAt: Date.now(), lines: []};
  assert.equal((await f.desk.checkDeskStatus()).state, 'unavailable');
  assert.equal((await fixture({statusURL: 'https://status.example.test/'}).desk.checkDeskStatus()).state, 'unavailable');
});

test('requests abort on timeout, supersession, and oversized response', async () => {
  const pending = [];
  const f = fixture({statusURL: 'https://status.example.test/', fetch: (url, init) => new Promise((resolve, reject) => {
    pending.push(init.signal);
    init.signal.addEventListener('abort', () => reject(Error('aborted')));
  })});
  const first = f.desk.checkDeskStatus();
  const second = f.desk.checkDeskStatus();
  assert.equal(pending[0].aborted, true);
  pending[1].dispatchEvent(new Event('abort'));
  assert.equal((await first).state, 'unavailable');
  assert.equal((await second).state, 'unavailable');
  const huge = fixture({fetch: async () => response('x'.repeat(262145))});
  assert.equal((await huge.desk.loadPumpRadar()).state, 'unavailable');
  const timed = fixture({statusURL: 'https://status.example.test/', fetch: (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Error('timeout')));
  })});
  timed.window.setTimeout = fn => setTimeout(fn, 0);
  assert.equal((await timed.desk.checkDeskStatus()).state, 'unavailable');
});

test('address validation is syntax only and never claims an audit', () => {
  const {desk} = fixture();
  assert.equal(desk.auditTokenAddress(mint).valid, true);
  assert.equal(desk.auditTokenAddress('0x' + 'a'.repeat(40)).valid, true);
  for (const invalid of ['', '0x123', '0'.repeat(44), 'z'.repeat(44), '1'.repeat(33)]) {
    assert.equal(desk.auditTokenAddress(invalid).valid, false, invalid);
  }
  assert.match(desk.auditTokenAddress(mint).message, /unconfigured.*syntax does not verify token safety/i);
});

test('radar reads only valid unique Solana boosted addresses, and reports unavailable feeds', async () => {
  const f = fixture({fetch: async () => response([
    {chainId: 'solana', tokenAddress: mint},
    {chainId: 'solana', tokenAddress: mint},
    {chainId: 'ethereum', tokenAddress: '0x' + 'a'.repeat(40)},
    {chainId: 'solana', tokenAddress: '<img src=x>'}
  ])});
  const result = await f.desk.loadPumpRadar();
  assert.equal(result.state, 'available');
  assert.deepEqual(Array.from(result.tokens), [mint]);
  assert.equal(f.calls[0].url, 'https://api.dexscreener.com/token-boosts/top/v1');
  assert.equal((await fixture().desk.loadPumpRadar()).state, 'unavailable');
  assert.equal((await fixture({fetch: async () => response({})}).desk.loadPumpRadar()).state, 'unavailable');
});

test('paper trades validate inputs, bound journal, and handle storage failures', () => {
  const {desk, data} = fixture();
  for (const [label, quantity, price] of [['', 1, 1], ['x', 0, 1], ['x', -1, 1], ['x', Infinity, 1], ['x', 1, NaN], ['x', 1e308, 1e308], ['x'.repeat(81), 1, 1]]) {
    assert.ok(desk.simulatePaperTrade(label, quantity, price).error);
  }
  assert.equal(Object.keys(data).length, 0);
  for (let i = 0; i < 101; i++) assert.ok(desk.simulatePaperTrade('token ' + i, 2, 3).entry);
  const entries = JSON.parse(data['valhalla-paper-journal-v1']);
  assert.equal(entries.length, 100);
  assert.equal(entries[0].token, 'token 1');
  assert.equal(entries[99].total, 6);
  assert.match(fixture({writeError: true}).desk.simulatePaperTrade('x', 1, 1).error, /could not be saved/);
  assert.match(fixture({readError: true}).desk.simulatePaperTrade('x', 1, 1).error, /unavailable/);
  data['valhalla-paper-journal-v1'] = '{bad';
  assert.match(desk.simulatePaperTrade('x', 1, 1).error, /not overwritten/);
  assert.equal(data['valhalla-paper-journal-v1'], '{bad');
});

test('CSV escapes quotes and newlines and neutralizes spreadsheet formulas', () => {
  const {desk} = fixture();
  for (const label of ['=1+1', ' \t+2', '-3', '@sum', '\ttext', 'a,"b"\nnext']) {
    assert.ok(desk.simulatePaperTrade(label, 1, 2).entry);
  }
  const csv = desk.exportJournalCSV().csv;
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"' \t\+2"/);
  assert.match(csv, /"'-3"/);
  assert.match(csv, /"'@sum"/);
  assert.match(csv, /"a,""b""\nnext"/);
  assert.match(fixture({readError: true}).desk.exportJournalCSV().error, /unavailable/);
});

test('built OS references versioned desk assets and preserves disabled live trading', () => {
  const html = fs.readFileSync(path.join(root, 'site-build/os/index.html'), 'utf8');
  assert.match(html, /href="\/desk\.css\?v=1\.4\.2"/);
  assert.match(html, /src="\/desk\.js\?v=1\.4\.2"/);
  assert.ok(fs.statSync(path.join(root, 'site-build/desk.css')).size > 0);
  assert.match(fs.readFileSync(path.join(root, 'site-build/site-config.js'), 'utf8'), /LIVE_TRADING:\s*false/);
});
