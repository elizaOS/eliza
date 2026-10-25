import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAndroidTrust } from "./build-android.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ota build "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["source", "sdk/ndk/29.0.13113456", "jdk/bin", "bin"])
    fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(
    path.join(root, "sdk/ndk/29.0.13113456/source.properties"),
    "Pkg.Revision = 29.0.13113456\n",
  );
  const trace = path.join(root, "trace.jsonl");
  fs.writeFileSync(
    path.join(root, "bin/go"),
    `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.TRACE,JSON.stringify({args,cwd:process.cwd(),ndk:process.env.ANDROID_NDK_HOME,toolchain:process.env.GOTOOLCHAIN})+'\\n');
if(args[0]==='env'){console.log(process.env.GO_VERSION||'go1.27.1');process.exit(0);}
const output=args[args.indexOf('-o')+1];
fs.writeFileSync(output,args[0]==='build'?'gobind':'new-aar');
if(process.env.FAIL_BIND==='1'&&args[0]==='tool')process.exit(7);
`,
    { mode: 0o755 },
  );
  return {
    source: path.join(root, "source"),
    output: path.join(root, "output/trust.aar"),
    toolchain: {
      go: "1.27.1",
      ndk: "29.0.13113456",
      androidApi: 29,
      target: "android/arm64",
      javaPackage: "example.host.trust",
    },
    ldflags: "-X=example.policy=opaque",
    env: {
      ...process.env,
      PATH: path.join(root, "bin"),
      ANDROID_HOME: path.join(root, "sdk"),
      JAVA_HOME: path.join(root, "jdk"),
      TRACE: trace,
    },
    trace,
    root,
  };
}

test("build preserves host-selected binding and policy in paths containing spaces", (t) => {
  const f = fixture(t);
  assert.equal(buildAndroidTrust(f), f.output);
  assert.equal(fs.readFileSync(f.output, "utf8"), "new-aar");
  const calls = fs
    .readFileSync(f.trace, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (x) => x.cwd === fs.realpathSync(f.source) && x.toolchain === "local",
    ),
  );
  for (const value of [
    "-target=android/arm64",
    "-androidapi=29",
    "-javapkg=example.host.trust",
    "-ldflags=-X=example.policy=opaque",
  ])
    assert.ok(calls[2].args.includes(value));
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), ["trust.aar"]);
});
test("partial failed binding preserves previous AAR and removes temporary tools", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.output));
  fs.writeFileSync(f.output, "previous");
  f.env.FAIL_BIND = "1";
  assert.throws(() => buildAndroidTrust(f));
  assert.equal(fs.readFileSync(f.output, "utf8"), "previous");
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), ["trust.aar"]);
});
test("wrong toolchain rejects before output creation", (t) => {
  const f = fixture(t);
  f.env.GO_VERSION = "go1.25.0";
  assert.throws(() => buildAndroidTrust(f), /requires Go/);
  assert.ok(!fs.existsSync(path.dirname(f.output)));
  fs.writeFileSync(
    path.join(f.env.ANDROID_HOME, "ndk", f.toolchain.ndk, "source.properties"),
    "Pkg.Revision = 28.0.0\n",
  );
  assert.throws(() => buildAndroidTrust(f), /requires NDK/);
  assert.ok(!fs.existsSync(path.dirname(f.output)));
});
test("invalid host build inputs fail before invoking tools", (t) => {
  const f = fixture(t);
  for (const change of [
    { javaPackage: "example/host" },
    { ndk: "../other" },
    { target: "ios" },
    { androidApi: 0 },
  ])
    assert.throws(
      () =>
        buildAndroidTrust({ ...f, toolchain: { ...f.toolchain, ...change } }),
      /Invalid Android/,
    );
  assert.throws(
    () => buildAndroidTrust({ ...f, ldflags: "" }),
    /Invalid Android/,
  );
  assert.ok(!fs.existsSync(f.trace));
});

test("prerelease NDK revision must be explicit", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.env.ANDROID_HOME, "ndk", f.toolchain.ndk, "source.properties"),
    "Pkg.Revision = 29.0.13113456-beta1\n",
  );
  assert.throws(() => buildAndroidTrust(f), /requires NDK/);
  f.toolchain.ndkRevision = "29.0.13113456-beta1";
  assert.equal(buildAndroidTrust(f), f.output);
});
