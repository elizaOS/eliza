import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runIsolatedAndroidTest } from "./isolated-android-test.mjs";

function fixture(t, mode = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-android-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state.json"),
    log = path.join(root, "commands.jsonl");
  fs.writeFileSync(
    state,
    JSON.stringify({
      packages: mode === "existing" ? ["org.example.consumer"] : [],
      home: "stock/.Home",
    }),
  );
  fs.writeFileSync(log, "");
  const adb = path.join(root, "adb.cjs"),
    aapt = path.join(root, "aapt.cjs");
  fs.writeFileSync(
    adb,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(4);const file=${JSON.stringify(state)};const state=JSON.parse(fs.readFileSync(file));const mode=${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes('ro.kernel.qemu'))console.log('1');
if(args.includes('ro.product.cpu.abi'))console.log('x86_64');
if(args.includes('getenforce'))console.log(mode==='permissive'?'Permissive':'Enforcing');
if(args.includes('packages'))console.log(state.packages.map(p=>'package:'+p).join('\\n'));
if(args.includes('resolve-activity'))console.log(state.home);
if(args[0]==='install'){const id=args.at(-1).includes('test.apk')?'org.example.consumer.test':'org.example.consumer';state.packages.push(id);fs.writeFileSync(file,JSON.stringify(state));if(mode==='install-failure'&&id.endsWith('.test'))process.exit(1);}
if(args[0]==='uninstall'){if(mode==='cleanup-failure')process.exit(1);state.packages=state.packages.filter(p=>p!==args[1]);fs.writeFileSync(file,JSON.stringify(state));}
if(args.includes('instrument')){
 if(mode==='home-change'){state.home='other/.Home';fs.writeFileSync(file,JSON.stringify(state));}
 console.log('INSTRUMENTATION_STATUS: class=org.example.consumer.Probe\\nINSTRUMENTATION_STATUS: test=probe\\nINSTRUMENTATION_STATUS: numtests=1\\nINSTRUMENTATION_STATUS_CODE: 1');
 if(mode!=='partial')console.log('INSTRUMENTATION_STATUS: class=org.example.consumer.Probe\\nINSTRUMENTATION_STATUS: test=probe\\nINSTRUMENTATION_STATUS: numtests=1\\nINSTRUMENTATION_STATUS_CODE: 0');
 console.log('OK (1 test)\\nINSTRUMENTATION_CODE: -1');
}
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    aapt,
    `#!/usr/bin/env node
const args=process.argv.slice(2);const wrong=${JSON.stringify(mode === "wrong-apk")};
if(args[1]==='badging')console.log("package: name='"+(wrong?'org.unrelated.app':args[2].includes('test.apk')?'org.example.consumer.test':'org.example.consumer')+"'");
else console.log('E: manifest\\n  E: instrumentation\\n    A: android:name="androidx.test.runner.AndroidJUnitRunner"\\n    A: android:targetPackage="${mode === "wrong-target" ? "org.unrelated.app" : "org.example.consumer"}"');
`,
    { mode: 0o700 },
  );
  for (const file of ["app.apk", "test.apk"])
    fs.writeFileSync(path.join(root, file), file);
  return {
    root,
    log,
    state,
    options: {
      serial: `emulator-${40000 + process.pid}`,
      adb,
      aapt,
      packageName: "org.example.consumer",
      testClass: "org.example.consumer.Probe",
      requiredAbi: "x86_64",
      directory: path.join(root, "results"),
      variants: ["standalone", "launcher"].map((name) => ({
        name,
        apk: path.join(root, "app.apk"),
        testApk: path.join(root, "test.apk"),
      })),
    },
    commands: () =>
      fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(JSON.parse),
  };
}
test("external consumer variants execute fully, clean packages and preserve HOME", async (t) => {
  const f = fixture(t);
  const prepared = [],
    collected = [];
  const report = await runIsolatedAndroidTest({
    ...f.options,
    prepareVariant: async (c) => prepared.push(c.variant),
    collectVariant: (c) => collected.push(c.variant),
  });
  assert.deepEqual(prepared, ["standalone", "launcher"]);
  assert.deepEqual(collected, prepared);
  assert.equal(report.variants.length, 2);
  assert.ok(
    report.variants.every(
      (r) => r.instrumentation.totalTests === 1 && r.passed,
    ),
  );
  assert.equal(report.cleaned, true);
  assert.equal(report.homeUnchanged, true);
  assert.ok(
    f
      .commands()
      .filter((c) => c[0] === "install")
      .every((c) => !c.includes("-r")),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).packages, []);
});
for (const mode of ["existing", "permissive", "wrong-apk", "wrong-target"])
  test(`${mode} is rejected before mutation`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(runIsolatedAndroidTest(f.options));
    assert.ok(
      !f.commands().some((c) => ["install", "uninstall"].includes(c[0])),
    );
  });
for (const mode of [
  "partial",
  "install-failure",
  "home-change",
  "cleanup-failure",
])
  test(`${mode} fails with cleanup evidence`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(runIsolatedAndroidTest(f.options));
    const report = JSON.parse(
      fs.readFileSync(path.join(f.options.directory, "verification.json")),
    );
    assert.equal(report.cleaned, mode !== "cleanup-failure");
    assert.equal(report.homeUnchanged, mode !== "home-change");
    if (mode === "cleanup-failure") assert.ok(report.cleanupErrors.length > 0);
  });
test("callback failure cleans owned packages and releases the device lease", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    runIsolatedAndroidTest({
      ...f.options,
      prepareVariant: () => {
        throw new Error("fixture failed");
      },
    }),
    /fixture failed/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).packages, []);
  const report = await runIsolatedAndroidTest(f.options);
  assert.equal(report.cleaned, true);
});
test("runner arguments cannot replace the requested test selection", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    runIsolatedAndroidTest({
      ...f.options,
      runnerArgs: ["-e", "class", "org.example.Other"],
    }),
  );
  assert.equal(f.commands().length, 0);
});
