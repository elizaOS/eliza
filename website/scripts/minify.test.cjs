const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('production transform keeps desk hooks, omits maps, and bounds the unused trail', async () => {
  const { generateTrail, minifySource } = await import('./minify-site.mjs');
  const source = fs.readFileSync(path.join(__dirname, '../os/app.js'), 'utf8');
  const minified = await minifySource(source, 'js');
  const trail = generateTrail();
  const shipped = minified + '\n' + trail;
  assert.match(minified, /getElementById\("desktop"\)|getElementById\('desktop'\)/);
  assert.match(minified, /dataset\.open/);
  assert.doesNotMatch(minified, /sourceMappingURL/);
  assert.doesNotMatch(shipped, /enterWorkstationSession|keene\.jos|operator-01@|Valhalla2033|pk_test_|BEGIN PRIVATE KEY/);
  assert.match(trail, /function vho0/);
  assert.match(trail, /if\(false\)/);
  const bytes = Buffer.byteLength(trail);
  assert.ok(bytes >= 8 * 1024 && bytes <= 40 * 1024, bytes);
  const called = [];
  const vm = require('node:vm');
  vm.runInNewContext(trail + '\n;if (typeof vho0 === "function") called.push("present");', { called });
  assert.deepEqual(called, ['present']);
});
