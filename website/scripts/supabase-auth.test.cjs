const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('public config holds the Supabase URL and publishable key only', () => {
  const config = read('website/site-config.js');
  assert.match(config, /https:\/\/girltjnrrwlyeufrcors\.supabase\.co/);
  assert.match(config, /sb_publishable_PKNzsuQZMMs4Sb81gnoFaw_PCgSbclp/);
  assert.doesNotMatch(config, /service_role|sb_secret_/);
  const home = read('website/home.js');
  const session = read('website/os/session.js');
  assert.doesNotMatch(home + session, /girltjnrrwlyeufrcors|sb_publishable_|service_role|signInWithWeb3|user_metadata/);
});

test('Google and magic link report a disabled provider instead of failing quietly', () => {
  const supabase = read('website/supabase.js');
  const context = { location: { hostname: 'valhalla-app.xyz' }, VALHALLA_SITE: {} };
  vm.runInNewContext(supabase, context);
  assert.equal(context.ValhallaSupabase.config(), null);
  assert.equal(context.ValhallaSupabase.osReturnTo(), 'https://valhalla-app.xyz/os/');
  context.location.hostname = 'www.valhalla-app.xyz';
  assert.equal(context.ValhallaSupabase.osReturnTo(), 'https://www.valhalla-app.xyz/os/');
  assert.match(context.ValhallaSupabase.providerMessage({ message: 'Unsupported provider: provider is not enabled' }), /not enabled/);
  assert.equal(context.ValhallaSupabase.levelLabel(''), 'Free');
  assert.equal(context.ValhallaSupabase.levelLabel('pro'), 'Pro');
  assert.doesNotMatch(supabase, /user_metadata/);
  context.VALHALLA_SITE = {
    SUPABASE_URL: 'https://girltjnrrwlyeufrcors.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example'
  };
  let creates = 0;
  const loader = function () {
    return Promise.resolve({
      createClient: function () {
        creates += 1;
        return { id: creates };
      }
    });
  };
  return Promise.all([
    context.ValhallaSupabase.client(loader),
    context.ValhallaSupabase.client(loader)
  ]).then(function (clients) {
    assert.equal(clients[0], clients[1]);
    assert.equal(creates, 1);
    assert.match(read('website/home.js'), /getSession/);
    assert.match(read('website/home.js'), /location\.replace\('\/os\/'\)/);
    assert.match(read('website/home.js'), /event\.persisted/);
    var home = read('website/home.js');
    assert.ok(home.indexOf("form.addEventListener('submit'") < home.indexOf('getSession'));
  });
});

test('the public site has no repository link or paper desk entry', () => {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|js)$/.test(entry.name)) files.push(full);
    }
  }
  walk(path.join(root, 'website'));
  const blob = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(blob, /github\.com\/TokenJunction/);
  assert.doesNotMatch(blob, /Public desk|Preview the public paper desk|Explore the public ValhallaOS desk/);
  assert.match(read('website/app/index.html'), /location\.replace\('\/'\)/);
  assert.match(read('website/os/session.js'), /location\.replace\('\/'\)/);
  assert.match(read('website/os/index.html'), /id="desktop" hidden/);
  assert.match(read('supabase/migrations/20261110000000_profiles.sql'), /auth\.uid\(\) = id/);
  assert.match(read('supabase/migrations/20261110000000_profiles.sql'), /account_level text not null default 'free'/);
});
