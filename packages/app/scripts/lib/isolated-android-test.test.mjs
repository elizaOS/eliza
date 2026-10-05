import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireDeviceLease,
  deviceLeaseStateDir,
  readDeviceLease,
} from "./device-lease.ts";
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
  const fixturePackage = mode.startsWith("calendar-")
    ? "example.calendar.consumer"
    : "org.example.consumer";
  const adb = path.join(root, "adb.cjs"),
    aapt = path.join(root, "aapt.cjs");
  fs.writeFileSync(
    adb,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(4);const file=${JSON.stringify(state)};const state=JSON.parse(fs.readFileSync(file));const mode=${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes('get-current-user'))console.log(state.foreground||0);
if(args.includes('create-user')){state.userExists=true;fs.writeFileSync(file,JSON.stringify(state));console.log('Success: created user id 10');}
if(args.includes('switch-user')){state.foreground=Number(args.at(-1));fs.writeFileSync(file,JSON.stringify(state));}
if(args.includes('get-started-user-state'))console.log('RUNNING_UNLOCKED');
if(args.includes('remove-user')){state.userExists=false;fs.writeFileSync(file,JSON.stringify(state));console.log('Success');}

if(args[0]==='emu')console.log('owned-test-fixture\\nOK');
if(args.includes('ro.kernel.qemu'))console.log('1');
if(args.includes('ro.product.cpu.abi'))console.log('x86_64');
if(args.includes('getenforce'))console.log(mode==='permissive'?'Permissive':'Enforcing');
if(args.includes('packages')&&mode==='appeared'){state.reads=(state.reads||0)+1;if(state.reads===2)state.packages.push('org.example.consumer');fs.writeFileSync(file,JSON.stringify(state));}
if(args.includes('packages'))console.log(state.packages.map(p=>'package:'+p).join('\\n'));
if(args.includes('resolve-activity'))console.log(state.home);
if(args[0]==='install'){const id=args.at(-1).includes('test.apk')?'org.example.consumer.test':'org.example.consumer';state.packages=[...new Set([...state.packages,id])];(state.files??={})[id]=file+'.'+id+'.apk';fs.copyFileSync(args.at(-1),state.files[id]);fs.writeFileSync(file,JSON.stringify(state));if(mode==='install-failure'&&id.endsWith('.test'))process.exit(1);console.log('Success');}
if(args.slice(0,3).join(' ')==='shell pm path')console.log('package:/data/'+args.at(-1)+'.apk');
if(args[0]==='pull'){const id=args[1].slice('/data/'.length,-4);fs.copyFileSync(state.files[id],args[2]);}

if(args.includes('force-stop')&&((mode.endsWith('stop-failure-test')&&args.at(-1).endsWith('.test'))||(mode.endsWith('stop-failure-app')&&!args.at(-1).endsWith('.test'))))process.exit(1);
if(args[0]==='uninstall'){if(mode==='cleanup-failure')process.exit(1);state.packages=state.packages.filter(p=>p!==args[1]);fs.writeFileSync(file,JSON.stringify(state));}
if(args.includes('instrument')){
 if(mode==='hanging'){fs.writeFileSync(${JSON.stringify(path.join(root, "instrumentation-started"))},'started');setInterval(()=>{},1000);return;}

 if(mode.startsWith('calendar-')){
  const [cls,method]=args[args.indexOf('class')+1].split('#');
  for(const code of mode.includes('stop-failure')?[1]:[1,0])console.log(['INSTRUMENTATION_STATUS: class='+cls,'INSTRUMENTATION_STATUS: test='+method,'INSTRUMENTATION_STATUS: numtests=1','INSTRUMENTATION_STATUS_CODE: '+code].join(String.fromCharCode(10)));
  console.log('OK (1 test)'+String.fromCharCode(10)+'INSTRUMENTATION_CODE: -1');return;
 }
 if(mode.startsWith('suite')){
  const cases=mode==='suite-missing'?['org.example.consumer.Probe#first','org.example.consumer.Probe#second']:['org.example.consumer.Probe#first','org.example.consumer.Probe#second','org.example.consumer.Second#probe'];
  if(mode==='suite-unexpected')cases[2]='org.unrelated.Injected#probe';
  for(const item of cases){const [cls,method]=item.split('#');for(const code of [1,0])console.log(['INSTRUMENTATION_STATUS: class='+cls,'INSTRUMENTATION_STATUS: test='+method,'INSTRUMENTATION_STATUS: numtests='+cases.length,'INSTRUMENTATION_STATUS_CODE: '+code].join(String.fromCharCode(10)));}
  console.log('OK ('+cases.length+' tests)'+String.fromCharCode(10)+'INSTRUMENTATION_CODE: -1');return;
 }
 if(mode==='home-change'){state.home='other/.Home';fs.writeFileSync(file,JSON.stringify(state));}
 console.log('INSTRUMENTATION_STATUS: class=org.example.consumer.Probe\\nINSTRUMENTATION_STATUS: test=probe\\nINSTRUMENTATION_STATUS: numtests=1\\nINSTRUMENTATION_STATUS_CODE: 1');
 if(mode!=='partial')console.log('INSTRUMENTATION_STATUS: class=org.example.consumer.Probe\\nINSTRUMENTATION_STATUS: test=probe\\nINSTRUMENTATION_STATUS: numtests=1\\nINSTRUMENTATION_STATUS_CODE: 0');
 console.log('OK (1 test)\\nINSTRUMENTATION_CODE: -1');
}
`.replaceAll("org.example.consumer", fixturePackage),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    aapt,
    `#!/usr/bin/env node
const args=process.argv.slice(2);const wrong=${JSON.stringify(mode === "wrong-apk")}||(${JSON.stringify(mode === "wrong-upgrade")}&&args[2].includes('candidate'));
if(args[1]==='badging')console.log("package: name='"+(wrong?'org.unrelated.app':args[2].includes('test.apk')?'org.example.consumer.test':'org.example.consumer')+"'");
else console.log('E: manifest\\n  E: instrumentation\\n    A: android:name="androidx.test.runner.AndroidJUnitRunner"\\n    A: android:targetPackage="${mode === "wrong-target" ? "org.unrelated.app" : "org.example.consumer"}"');
`.replaceAll("org.example.consumer", fixturePackage),
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
      expectedAvdName: "owned-test-fixture",
      androidUser: 0,
      env: {
        ...process.env,
        ELIZA_DEVICE_LEASE_DIR: path.join(root, "leases"),
      },
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
    assert.equal(
      fs.existsSync(f.options.directory),
      false,
      "Preflight must reject before admitting the run",
    );
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

test("an installation appearing after admission is never deleted as owned data", async (t) => {
  const f = fixture(t, "appeared");
  await assert.rejects(
    runIsolatedAndroidTest(f.options),
    /appeared after preflight/,
  );
  assert.ok(!f.commands().some((c) => ["install", "uninstall"].includes(c[0])));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).packages, [
    "org.example.consumer",
  ]);
});

test("artifact changes between variants are rejected before the next installation", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    runIsolatedAndroidTest({
      ...f.options,
      collectVariant: () =>
        fs.writeFileSync(f.options.variants[0].apk, "changed"),
    }),
    /APK changed after preflight/,
  );
  assert.equal(f.commands().filter((c) => c[0] === "install").length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).packages, []);
});

test("caller cancellation stops a running command and cleans only owned packages", async (t) => {
  const f = fixture(t, "hanging"),
    controller = new AbortController();
  const running = runIsolatedAndroidTest({
    ...f.options,
    signal: controller.signal,
  });
  const assertion = assert.rejects(
    running,
    (error) => error.name === "AbortError",
  );
  const started = path.join(f.root, "instrumentation-started");
  while (!fs.existsSync(started))
    await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assertion;
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).packages, []);
  assert.ok(f.commands().some((c) => c.includes("force-stop")));
  const report = JSON.parse(
    fs.readFileSync(path.join(f.options.directory, "verification.json")),
  );
  assert.equal(report.cleaned, true);
  assert.equal(report.homeUnchanged, true);
});

test("caller-selected instrumentation deadlines are not subject to a shared duration policy", async (t) => {
  const f = fixture(t, "hanging");
  await assert.rejects(
    runIsolatedAndroidTest({ ...f.options, instrumentationTimeoutMs: 200 }),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).packages, []);
  const second = fixture(t);
  const result = await runIsolatedAndroidTest({
    ...second.options,
    instrumentationTimeoutMs: 900000,
  });
  assert.equal(result.cleaned, true);
});

test("the fixture AVD identity is required before installation", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    runIsolatedAndroidTest({
      ...f.options,
      expectedAvdName: "somebody-elses-avd",
    }),
    /fixture AVD/,
  );
  assert.ok(!f.commands().some((c) => ["install", "uninstall"].includes(c[0])));
});

test("explicit suites preserve requested class membership and complete test counts", async (t) => {
  const f = fixture(t, "suite"),
    testClasses = ["org.example.consumer.Probe", "org.example.consumer.Second"];
  const report = await runIsolatedAndroidTest({
    ...f.options,
    testClass: undefined,
    testClasses,
    expectedTests: 3,
    prepareVariant: () => testClasses.push("org.unrelated.Injected"),
  });
  assert.equal(report.cleaned, true);
  assert.deepEqual(report.testClasses, [
    "org.example.consumer.Probe",
    "org.example.consumer.Second",
  ]);
  assert.ok(
    report.variants.every((record) => record.instrumentation.totalTests === 3),
  );
  for (const args of f.commands().filter((args) => args.includes("instrument")))
    assert.equal(
      args[args.indexOf("class") + 1],
      "org.example.consumer.Probe,org.example.consumer.Second",
    );
});
for (const mode of ["suite-missing", "suite-unexpected"])
  test(`${mode} fails and cleans owned installation`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(
      runIsolatedAndroidTest({
        ...f.options,
        testClass: undefined,
        testClasses: [
          "org.example.consumer.Probe",
          "org.example.consumer.Second",
        ],
        expectedTests: 3,
      }),
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(f.options.directory, "verification.json")),
      ).cleaned,
      true,
    );
  });
test("invalid or ambiguous class selections fail before any device mutation", async (t) => {
  const f = fixture(t);
  for (const selection of [
    { testClasses: ["org.example.consumer.Second"] },
    { testClass: undefined, testClasses: [] },
    {
      testClass: undefined,
      testClasses: ["org.example.consumer.Probe", "org.example.consumer.Probe"],
    },
    {
      testClass: undefined,
      testClasses: ["org.example.consumer.Probe;injected"],
    },
    { testClass: undefined, testClasses: "org.example.consumer.Probe" },
  ])
    await assert.rejects(
      runIsolatedAndroidTest({ ...f.options, ...selection }),
    );
  assert.deepEqual(f.commands(), []);
});

test("caller ownership spans successful and cancelled consumer execution", async (t) => {
  for (const mode of ["", "hanging"]) {
    const f = fixture(t, mode);
    const deviceKey = `android:${f.options.serial}`;
    const stateDir = deviceLeaseStateDir(f.options.env);
    const deviceLease = await acquireDeviceLease(deviceKey, {
      waitMs: 0,
      ttlMs: Number.MAX_SAFE_INTEGER,
      stateDir,
    });
    try {
      const controller = new AbortController();
      const execution = runIsolatedAndroidTest({
        ...f.options,
        deviceLease,
        signal: controller.signal,
      });
      if (mode === "hanging") {
        while (!fs.existsSync(path.join(f.root, "instrumentation-started")))
          await new Promise((resolve) => setTimeout(resolve, 5));
        controller.abort();
        await assert.rejects(execution, (error) => error.name === "AbortError");
      } else await execution;
      assert.deepEqual(
        readDeviceLease(deviceKey, { stateDir }),
        deviceLease.lease,
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(f.options.directory, "verification.json")),
        ).cleaned,
        true,
      );
      await assert.rejects(
        acquireDeviceLease(deviceKey, { waitMs: 0, stateDir }),
      );
    } finally {
      deviceLease.release();
    }
    assert.equal(readDeviceLease(deviceKey, { stateDir }), null);
  }
});

test("foreign and released caller leases reject before device commands", async (t) => {
  const f = fixture(t);
  const stateDir = deviceLeaseStateDir(f.options.env);
  const foreign = await acquireDeviceLease("android:emulator-2", {
    waitMs: 0,
    stateDir,
  });
  try {
    await assert.rejects(
      runIsolatedAndroidTest({ ...f.options, deviceLease: foreign }),
    );
  } finally {
    foreign.release();
  }
  const released = await acquireDeviceLease(`android:${f.options.serial}`, {
    waitMs: 0,
    ttlMs: Number.MAX_SAFE_INTEGER,
    stateDir,
  });
  released.release();
  await assert.rejects(
    runIsolatedAndroidTest({ ...f.options, deviceLease: released }),
  );
  const finite = await acquireDeviceLease(`android:${f.options.serial}`, {
    waitMs: 0,
    stateDir,
  });
  try {
    await assert.rejects(
      runIsolatedAndroidTest({ ...f.options, deviceLease: finite }),
      /live fixture lifecycle/,
    );
  } finally {
    finite.release();
  }
  assert.deepEqual(f.commands(), []);
});

test("calendar caller rejects a leased fixture before creating users", async (t) => {
  const f = fixture(t);
  const lease = await acquireDeviceLease(`android:${f.options.serial}`, {
    waitMs: 0,
    stateDir: deviceLeaseStateDir(f.options.env),
  });
  try {
    const caller = fileURLToPath(
      new URL(
        "../../../../plugins/plugin-native-calendar/test/android-consumer/run-consumer.mjs",
        import.meta.url,
      ),
    );
    const result = spawnSync(
      process.execPath,
      [
        caller,
        "--adb",
        f.options.adb,
        "--aapt",
        f.options.aapt,
        "--serial",
        f.options.serial,
        "--avd",
        f.options.expectedAvdName,
        "--abi",
        "x86_64",
      ],
      { env: f.options.env, encoding: "utf8" },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /leased by/);
    assert.deepEqual(f.commands(), []);
  } finally {
    lease.release();
  }
});

for (const mode of ["stop-failure-test", "stop-failure-app"])
  test(`${mode} preserves both packages when termination is uncertain`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(
      runIsolatedAndroidTest({
        ...f.options,
        prepareVariant: () => {
          throw new Error("Fixture setup interrupted");
        },
      }),
      /Fixture setup interrupted/,
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(f.options.directory, "verification.json")),
    );
    assert.equal(report.cleaned, false);
    assert.equal(report.cleanupDeferred, true);
    assert.ok(
      report.cleanupErrors.some((error) => error.startsWith("Could not stop")),
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).packages.sort(), [
      "org.example.consumer",
      "org.example.consumer.test",
    ]);
    assert.equal(
      f.commands().filter((command) => command.includes("force-stop")).length,
      2,
    );
    assert.equal(
      f.commands().some((command) => command[0] === "uninstall"),
      false,
    );
  });

test("single-method selection requires the exact completed method", async (t) => {
  const f = fixture(t);
  await runIsolatedAndroidTest({ ...f.options, testMethod: "probe" });
  assert.ok(
    f
      .commands()
      .filter((args) => args.includes("instrument"))
      .every(
        (args) =>
          args[args.indexOf("class") + 1] ===
          "org.example.consumer.Probe#probe",
      ),
  );
  await assert.rejects(
    runIsolatedAndroidTest({ ...f.options, testMethod: "other" }),
    /Requested method missing/,
  );
});
test("invalid method selections reject before device commands", async (t) => {
  const f = fixture(t);
  for (const options of [
    { testMethod: "probe;bad" },
    { testMethod: "probe", expectedTests: 2 },
    {
      testClass: undefined,
      testClasses: [
        "org.example.consumer.Probe",
        "org.example.consumer.Second",
      ],
      testMethod: "probe",
    },
  ])
    await assert.rejects(runIsolatedAndroidTest({ ...f.options, ...options }));
  assert.deepEqual(f.commands(), []);
});

for (const [selectedCase, method, granted] of [
  ["recovery", "committedMarkerRecoveryAndMissingMarkerNeverReplay", true],
  ["bridge", "permissionAndReviewedProviderLifecycle", false],
  ["workflow-permission", "workflowPermissionCallback", false],
  [
    "stop-failure-test",
    "committedMarkerRecoveryAndMissingMarkerNeverReplay",
    true,
  ],
])
  test(`Calendar consumer ${selectedCase} preserves phase and user ownership`, async (t) => {
    const f = fixture(t, `calendar-${selectedCase}`);
    const caller = fileURLToPath(
      new URL(
        "../../../../plugins/plugin-native-calendar/test/android-consumer/run-consumer.mjs",
        import.meta.url,
      ),
    );
    const result = spawnSync(
      process.execPath,
      [
        caller,
        "--adb",
        f.options.adb,
        "--aapt",
        f.options.aapt,
        "--serial",
        f.options.serial,
        "--avd",
        f.options.expectedAvdName,
        "--abi",
        "x86_64",
        "--apk",
        f.options.variants[0].apk,
        "--test-apk",
        f.options.variants[0].testApk,
        "--output-root",
        path.join(f.root, "reports"),
        "--case",
        selectedCase.startsWith("stop-") ? "recovery" : selectedCase,
      ],
      { env: f.options.env, encoding: "utf8", timeout: 15000 },
    );
    const deferred = selectedCase.startsWith("stop-");
    assert.equal(result.status, deferred ? 1 : 0, result.stderr);
    const commands = f.commands(),
      instruments = commands.filter((args) => args.includes("instrument"));
    assert.equal(instruments.length, 1);
    assert.ok(
      instruments[0][instruments[0].indexOf("class") + 1].endsWith(
        `#${method}`,
      ),
    );
    assert.equal(
      commands.filter((args) => args.includes("grant")).length,
      granted ? 2 : 0,
    );
    assert.equal(
      commands.some((args) => args.includes("remove-user")),
      !deferred,
    );
    const state = JSON.parse(fs.readFileSync(f.state));
    assert.equal(state.foreground, 0);
    assert.equal(state.userExists, deferred);
    assert.equal(state.packages.length, deferred ? 2 : 0);
    const reportRoot = path.join(f.root, "reports");
    const receipts = JSON.parse(
      fs.readFileSync(
        path.join(reportRoot, fs.readdirSync(reportRoot)[0], "receipts.json"),
      ),
    );
    assert.equal(
      receipts[0].selectedCase,
      deferred ? "recovery" : selectedCase,
    );
    assert.equal(Boolean(receipts[0].cleanupDeferred), deferred);
  });

function upgradeFixture(t, mode) {
  const f = fixture(t, mode);
  for (const name of ["candidate.apk", "candidate-test.apk"])
    fs.writeFileSync(path.join(f.root, name), name);
  f.options.variants = f.options.variants.slice(0, 1).map((variant) => ({
    ...variant,
    upgrade: {
      apk: path.join(f.root, "candidate.apk"),
      testApk: path.join(f.root, "candidate-test.apk"),
    },
  }));
  f.options.runnerArgs = ["-e", "upgradePhase", "seed"];
  f.options.upgradeRunnerArgs = ["-e", "upgradePhase", "verify"];
  return f;
}
test("installed upgrade admits both APK pairs, preserves installation between exact phases and verifies hashes", async (t) => {
  const f = upgradeFixture(t),
    hooks = [];
  const report = await runIsolatedAndroidTest({
    ...f.options,
    beforeUpgrade: () => hooks.push("before"),
    afterUpgrade: () => hooks.push("after"),
  });
  assert.deepEqual(hooks, ["before", "after"]);
  assert.equal(report.variants[0].upgrade.instrumentation.totalTests, 1);
  const commands = f.commands(),
    phases = commands.filter((c) => c.includes("instrument"));
  assert.equal(phases.length, 2);
  assert.ok(phases[0].includes("seed"));
  assert.ok(phases[1].includes("verify"));
  const between = commands.slice(
    commands.indexOf(phases[0]) + 1,
    commands.indexOf(phases[1]),
  );
  assert.equal(
    between.filter((c) => c[0] === "install" && c.includes("-r")).length,
    2,
  );
  assert.ok(!between.some((c) => c[0] === "uninstall"));
  assert.ok(report.cleaned);
  assert.ok(
    fs.existsSync(path.join(f.options.directory, "standalone-baseline.log")),
  );
  assert.ok(
    fs.existsSync(path.join(f.options.directory, "standalone-candidate.log")),
  );
});
test("changed candidate APK is refused before replacement", async (t) => {
  const f = upgradeFixture(t);
  await assert.rejects(
    runIsolatedAndroidTest({
      ...f.options,
      beforeUpgrade: () =>
        fs.writeFileSync(f.options.variants[0].upgrade.apk, "changed"),
    }),
    /changed after preflight/,
  );
  assert.ok(!f.commands().some((c) => c[0] === "install" && c.includes("-r")));
});
test("changed installed code preserves both packages for explicit recovery", async (t) => {
  const f = upgradeFixture(t);
  await assert.rejects(
    runIsolatedAndroidTest({
      ...f.options,
      beforeUpgrade: () => {
        const state = JSON.parse(fs.readFileSync(f.state));
        state.files["org.example.consumer"] = f.options.variants[0].upgrade.apk;
        fs.writeFileSync(f.state, JSON.stringify(state));
      },
    }),
    /changed before replacement/,
  );
  assert.ok(!f.commands().some((c) => c[0] === "uninstall"));
  const report = JSON.parse(
    fs.readFileSync(path.join(f.options.directory, "verification.json")),
  );
  assert.equal(report.cleanupDeferred, true);
});
test("upgrade runner selectors are rejected before any device mutation", async (t) => {
  const f = upgradeFixture(t);
  await assert.rejects(
    runIsolatedAndroidTest({
      ...f.options,
      upgradeRunnerArgs: ["-e", "class", "org.other.Probe"],
    }),
    /selection is owned/,
  );
  assert.deepEqual(f.commands(), []);
});

test("candidate identity is admitted before the baseline can install", async (t) => {
  const f = upgradeFixture(t, "wrong-upgrade");
  await assert.rejects(
    runIsolatedAndroidTest(f.options),
    /APK identity differs/,
  );
  assert.deepEqual(f.commands(), []);
});
test("identical baseline and candidate are refused before device mutation", async (t) => {
  const f = upgradeFixture(t);
  fs.copyFileSync(f.options.variants[0].apk, f.options.variants[0].upgrade.apk);
  await assert.rejects(
    runIsolatedAndroidTest(f.options),
    /Upgrade must change/,
  );
  assert.deepEqual(f.commands(), []);
});
