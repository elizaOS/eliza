import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extractor = fileURLToPath(
  new URL("./extract-ci-webview.py", import.meta.url),
);
const writer = `import sys, zipfile, stat
archive, kind = sys.argv[1:]
names = ['ChromePublic','ContentShell','SystemWebView','SystemWebViewShell']
with zipfile.ZipFile(archive,'w') as target:
 for name in names:
  member = zipfile.ZipInfo('chrome-android-desktop/apks/'+name+'.apk')
  member.create_system = 3
  member.external_attr = ((stat.S_IFLNK if kind == 'symlink' and name == 'ChromePublic' else stat.S_IFREG) | 0o644) << 16
  target.writestr(member, 'fixture:'+name)
 if kind == 'extra': target.writestr('unreviewed','extra')
 if kind == 'duplicate': target.writestr('chrome-android-desktop/apks/SystemWebView.apk','replacement')
 if kind == 'traversal': target.writestr('../escaped','escape')
`;
function fixture(t, kind = "valid") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webview-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "input.zip"),
    output = path.join(root, "output.apk");
  execFileSync("python3", ["-c", writer, archive, kind], { stdio: "pipe" });
  const extract = () =>
    spawnSync("python3", [extractor, archive, output], {
      encoding: "utf8",
      env: { ...process.env, PYTHONOPTIMIZE: "1" },
    });
  return { root, output, extract };
}
test("validated archive extracts only SystemWebView and never overwrites an output", (t) => {
  const f = fixture(t);
  assert.equal(f.extract().status, 0);
  assert.equal(fs.readFileSync(f.output, "utf8"), "fixture:SystemWebView");
  fs.writeFileSync(f.output, "retained");
  assert.notEqual(f.extract().status, 0);
  assert.equal(fs.readFileSync(f.output, "utf8"), "retained");
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["input.zip", "output.apk"]);
});
for (const kind of ["extra", "duplicate", "traversal", "symlink"])
  test(`optimized Python refuses ${kind} before creating an APK`, (t) => {
    const f = fixture(t, kind);
    assert.notEqual(f.extract().status, 0);
    assert.equal(fs.existsSync(f.output), false);
  });
