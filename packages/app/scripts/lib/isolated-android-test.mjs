/** Explicit consumer APK acceptance. Never replaces an unowned installation.
 * Companion APKs require declared package identities and pinned SHA-256 values.
 * They share the app/test admission, installed-byte checks and cleanup ownership.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

import {
  androidInstrumentationEvidenceFromAapt,
  dumpAndroidArtifactBadgingAsync,
  dumpAndroidArtifactManifestAsync,
} from "../mobile/artifact-inspection/android-tools.ts";
import {
  acquireDeviceLease,
  activeLeaseStatus,
  deviceLeasePath,
  deviceLeaseStateDir,
  readDeviceLease,
} from "./device-lease.ts";
import { requireInstrumentationSuccess } from "./instrumentation-result.mjs";

const sha256 = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export async function runIsolatedAndroidTest({
  serial,
  adb,
  aapt,
  env = process.env,
  packageName,
  testPackage = `${packageName}.test`,
  runner = "androidx.test.runner.AndroidJUnitRunner",
  additionalInstrumentationRunners = [],
  testClass,
  testClasses,
  testMethod,
  expectedTests = 1,
  requiredAbi,
  expectedAvdName,
  androidUser,
  deviceLease,
  signal,
  commandTimeoutMs,
  cleanupTimeoutMs,
  variants,
  companionApks = [],
  directory,
  evidence,
  runnerArgs = [],
  upgradeRunnerArgs = [],
  beforeUpgrade,
  afterUpgrade,
  instrumentationTimeoutMs,
  preflightVariant,
  prepareVariant,
  collectVariant,
  cleanupVariant,
}) {
  assert.match(serial ?? "", /^emulator-\d+$/);
  const runnerEvidenceFor = (additionalRunners) => {
    assert.ok(
      Array.isArray(additionalRunners),
      "Explicit additional runner list required",
    );
    const admittedRunners = [runner, ...additionalRunners];
    assert.equal(
      new Set(admittedRunners).size,
      admittedRunners.length,
      "Duplicate instrumentation runner",
    );
    for (const name of admittedRunners)
      assert.match(name ?? "", packagePattern);
    return admittedRunners
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, targetPackage: packageName }));
  };
  const defaultRunnerEvidence = runnerEvidenceFor(
    additionalInstrumentationRunners,
  );
  assert.ok(
    testClasses === undefined || testClass === undefined,
    "Choose testClass or testClasses",
  );
  assert.ok(
    testClasses === undefined || Array.isArray(testClasses),
    "Explicit test class list required",
  );
  const classes = testClasses === undefined ? [testClass] : [...testClasses];
  assert.ok(classes.length > 0, "At least one test class required");
  assert.equal(
    new Set(classes).size,
    classes.length,
    "Duplicate requested class",
  );
  for (const name of [packageName, testPackage, runner, ...classes])
    assert.match(name ?? "", packagePattern);
  if (testMethod !== undefined) {
    assert.match(testMethod, /^[A-Za-z][A-Za-z0-9_]*$/);
    assert.equal(classes.length, 1, "Method selection requires one class");
    assert.equal(
      expectedTests,
      1,
      "Method selection requires exactly one test",
    );
  }
  assert.notEqual(packageName, testPackage);
  assert.ok(
    ["arm64-v8a", "x86_64"].includes(requiredAbi),
    "Explicit emulator ABI required",
  );
  assert.ok(
    Number.isSafeInteger(expectedTests) && expectedTests >= classes.length,
  );
  assert.ok(
    Number.isSafeInteger(androidUser) && androidUser >= 0,
    "Explicit Android user required",
  );
  assert.match(expectedAvdName ?? "", /^[A-Za-z0-9_.-]+$/);
  for (const deadline of [
    commandTimeoutMs,
    instrumentationTimeoutMs,
    cleanupTimeoutMs,
  ])
    assert.ok(
      deadline === undefined ||
        (Number.isSafeInteger(deadline) && deadline > 0),
      "A caller deadline must be positive milliseconds",
    );
  signal?.throwIfAborted();
  assert.ok(Array.isArray(variants) && variants.length > 0);
  // Freeze each artifact's exact declaration set before any asynchronous device work.
  // Historical instrumentation can differ from its replacement without widening either set.
  const artifactRunnerEvidence = new Map();
  for (const variant of variants) {
    for (const artifacts of [
      variant,
      ...(variant.upgrade ? [variant.upgrade] : []),
    ]) {
      artifactRunnerEvidence.set(
        artifacts,
        artifacts.additionalInstrumentationRunners === undefined
          ? defaultRunnerEvidence
          : runnerEvidenceFor(artifacts.additionalInstrumentationRunners),
      );
    }
  }

  assert.ok(
    path.isAbsolute(directory),
    "Explicit absolute report directory required",
  );
  const validateRunnerArgs = (runnerArgs) => {
    assert.ok(Array.isArray(runnerArgs) && runnerArgs.length % 3 === 0);
    for (let i = 0; i < runnerArgs.length; i += 3) {
      assert.equal(runnerArgs[i], "-e");
      assert.match(runnerArgs[i + 1], /^[A-Za-z][A-Za-z0-9_]*$/);
      assert.ok(
        ![
          "class",
          "package",
          "notClass",
          "notPackage",
          "func",
          "unit",
          "annotation",
          "notAnnotation",
          "size",
          "count",
          "log",
          "debug",
          "suiteAssignment",
          "numShards",
          "shardIndex",
        ].includes(runnerArgs[i + 1]),
        "Runner selection is owned by the harness",
      );
      assert.match(
        runnerArgs[i + 2],
        /^[A-Za-z0-9_.:-]+$/,
        "Instrumentation extras must be shell-safe scalar values",
      );
    }
  };
  validateRunnerArgs(runnerArgs);
  validateRunnerArgs(upgradeRunnerArgs);
  runnerArgs = [...runnerArgs];
  upgradeRunnerArgs = [...upgradeRunnerArgs];
  assert.ok(Array.isArray(companionApks), "Companion APK list required");
  const companions = companionApks.map(
    ({ apk, packageName, sha256: hash, updates = [] }) => {
      assert.ok(path.isAbsolute(apk), "Absolute companion APK path required");
      assert.match(packageName ?? "", packagePattern);
      assert.match(
        hash ?? "",
        /^[a-f0-9]{64}$/,
        "Pinned companion SHA-256 required",
      );
      assert.equal(sha256(apk), hash, "Companion APK differs from its pin");
      assert.ok(
        Array.isArray(updates),
        "Explicit companion update list required",
      );
      const declaredUpdates = updates.map(({ apk, sha256: hash }) => {
        assert.ok(path.isAbsolute(apk), "Absolute update APK path required");
        assert.match(
          hash ?? "",
          /^[a-f0-9]{64}$/,
          "Pinned update SHA-256 required",
        );
        assert.equal(sha256(apk), hash, "Update APK differs from its pin");
        return { apk, sha256: hash };
      });
      return {
        apk,
        packageName,
        sha256: hash,
        ...(declaredUpdates.length ? { updates: declaredUpdates } : {}),
      };
    },
  );
  const packageNames = [
    packageName,
    testPackage,
    ...companions.map((item) => item.packageName),
  ];
  assert.equal(
    new Set(packageNames).size,
    packageNames.length,
    "Duplicate companion package identity",
  );
  for (const item of companions.flatMap((item) => [
    item,
    ...(item.updates ?? []).map((update) => ({
      ...update,
      packageName: item.packageName,
    })),
  ])) {
    const badging = await dumpAndroidArtifactBadgingAsync(aapt, item.apk, {
      signal,
      timeout: commandTimeoutMs,
    });
    assert.equal(
      /package: name='([^']+)'/.exec(badging)?.[1],
      item.packageName,
      "Companion APK identity differs from declared package",
    );
  }
  const names = new Set();
  // Validate every artifact before the first install, including instrumentation's target.
  const records = [];
  for (const variant of variants) {
    signal?.throwIfAborted();
    assert.match(variant.name ?? "", /^[a-z0-9-]+$/);
    assert.ok(!names.has(variant.name));
    names.add(variant.name);
    for (const artifacts of [
      variant,
      ...(variant.upgrade ? [variant.upgrade] : []),
    ]) {
      for (const [apk, expected] of [
        [artifacts.apk, packageName],
        [artifacts.testApk, testPackage],
      ]) {
        assert.ok(path.isAbsolute(apk));
        const actual = /package: name='([^']+)'/.exec(
          await dumpAndroidArtifactBadgingAsync(aapt, apk, {
            signal,
            timeout: commandTimeoutMs,
          }),
        )?.[1];
        assert.equal(
          actual,
          expected,
          "APK identity differs from declared package",
        );
      }
      assert.deepEqual(
        androidInstrumentationEvidenceFromAapt(
          await dumpAndroidArtifactManifestAsync(aapt, artifacts.testApk, {
            signal,
            timeout: commandTimeoutMs,
          }),
        ).sort((a, b) => a.name.localeCompare(b.name)),
        artifactRunnerEvidence.get(artifacts),
        "Instrumentation target or runner mismatch",
      );
    }
    if (variant.upgrade)
      assert.notEqual(
        sha256(variant.apk),
        sha256(variant.upgrade.apk),
        "Upgrade must change the app APK",
      );
    records.push({
      variant: variant.name,
      appSha256: sha256(variant.apk),
      testSha256: sha256(variant.testApk),
      ...(variant.upgrade
        ? {
            upgrade: {
              appSha256: sha256(variant.upgrade.apk),
              testSha256: sha256(variant.upgrade.testApk),
            },
          }
        : {}),
    });
  }
  // Cleanup runs independently of an aborted operation signal and has its own caller deadline.
  let cleaning = false;
  const run = async (...args) =>
    (
      await executeFile(adb, ["-s", serial, ...args], {
        env,
        encoding: "utf8",
        signal: cleaning ? undefined : signal,
        timeout: cleaning
          ? cleanupTimeoutMs
          : args[0] === "shell" && args[1] === "am" && args[2] === "instrument"
            ? instrumentationTimeoutMs
            : commandTimeoutMs,
        maxBuffer: 4 * 1024 ** 2,
      })
    ).stdout;
  const home = async () =>
    (
      await run(
        "shell",
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.HOME",
      )
    ).trim();
  const packages = async () =>
    (await run("shell", "pm", "list", "packages", "-u", "--user", "all")).split(
      /\r?\n/,
    );
  const installed = async () =>
    (await packages()).some((line) =>
      packageNames.some((name) => line === `package:${name}`),
    );
  // The canonical lease still reclaims dead PIDs. It must not expire under a live caller's work.
  const deviceKey = `android:${serial}`;
  const stateDir = deviceLeaseStateDir(env);
  if (deviceLease) {
    assert.equal(deviceLease.path, deviceLeasePath(deviceKey, stateDir));
    assert.equal(
      deviceLease.lease.pid,
      process.pid,
      "Caller must own the lease",
    );
    assert.equal(
      deviceLease.lease.ttlMs,
      Number.MAX_SAFE_INTEGER,
      "Caller lease must cover the live fixture lifecycle",
    );
    assert.deepEqual(
      readDeviceLease(deviceKey, { stateDir }),
      deviceLease.lease,
    );
    assert.ok(
      activeLeaseStatus(deviceLease.lease).active,
      "Caller lease is stale",
    );
  }
  const lease =
    deviceLease ??
    (await acquireDeviceLease(deviceKey, {
      waitMs: 0,
      ttlMs: Number.MAX_SAFE_INTEGER,
      stateDir,
    }));
  const report = {
    serial,
    packageName,
    testPackage,
    companions,
    expectedAvdName,
    requiredAbi,
    androidUser,
    testClasses: classes,
    expectedTests,
    evidence,
    variants: [],
  };
  let admitted = false,
    campaignFinished = false,
    previousHome,
    failure,
    activeContext,
    scenarioCleanupFailure;
  const owned = new Map();
  const installedHash = async (name) => {
    const lines = (
      await run("shell", "pm", "path", "--user", String(androidUser), name)
    )
      .trim()
      .split(/\r?\n/);
    assert.equal(lines.length, 1, "Expected one installed APK");
    assert.match(lines[0], /^package:\/[^\r\n]+\.apk$/);
    const local = path.join(directory, `${name}-installed.apk`);
    try {
      await run("pull", lines[0].slice(8), local);
      return sha256(local);
    } finally {
      fs.rmSync(local, { force: true });
    }
  };
  const cleanupHashAllowed = (name, hash) =>
    hash === owned.get(name) ||
    companions.some(
      (item) =>
        item.packageName === name &&
        item.updates?.some((update) => update.sha256 === hash),
    );
  // The cleanup callback runs once, even after cancellation or partial setup.
  const restoreScenario = async () => {
    if (!activeContext) return;
    const context = activeContext;
    activeContext = undefined;
    const wasCleaning = cleaning;
    cleaning = true;
    try {
      await cleanupVariant?.({ ...context, signal: undefined });
    } catch (error) {
      scenarioCleanupFailure = error;
      throw error;
    } finally {
      cleaning = wasCleaning;
    }
  };
  const install = async (file, name, expectedHash, replace = false) => {
    assert.equal(sha256(file), expectedHash, "APK changed after preflight");
    if (replace)
      assert.equal(
        await installedHash(name),
        owned.get(name),
        "Installed APK changed before replacement",
      );
    owned.set(name, expectedHash);
    assert.match(
      await run(
        "install",
        ...(replace ? ["-r"] : []),
        "--user",
        String(androidUser),
        "-t",
        file,
      ),
      /^Success\s*$/m,
    );
    assert.equal(
      await installedHash(name),
      expectedHash,
      "Installed APK hash mismatch",
    );
  };
  try {
    assert.equal(
      (await run("shell", "getprop", "ro.kernel.qemu")).trim(),
      "1",
      "Disposable emulator required",
    );
    assert.equal(
      (await run("shell", "getprop", "ro.product.cpu.abi")).trim(),
      requiredAbi,
      "Emulator ABI mismatch",
    );
    assert.equal(
      (await run("emu", "avd", "name")).split(/\r?\n/)[0],
      expectedAvdName,
      "Selected emulator is not the caller-owned fixture AVD",
    );
    report.selinux = (await run("shell", "getenforce")).trim();
    assert.equal(
      report.selinux,
      "Enforcing",
      "App-domain acceptance requires SELinux enforcing",
    );
    assert.ok(
      !(await installed()),
      "App or retained package data already exists; refusing replacement",
    );
    previousHome = await home();
    fs.mkdirSync(directory, { recursive: true });
    admitted = true;
    for (const [index, variant] of variants.entries()) {
      const record = records[index];
      report.variants.push(record);
      assert.ok(!(await installed()), "Installation appeared after preflight");
      assert.equal(
        sha256(variant.apk),
        record.appSha256,
        "App APK changed after preflight",
      );
      assert.equal(
        sha256(variant.testApk),
        record.testSha256,
        "Test APK changed after preflight",
      );
      const context = {
        variant: variant.name,
        packageName,
        adb,
        env,
        serial,
        directory,
        androidUser,
        signal,
        run,
        deviceLease: lease,
        record,
      };
      // This caller hook is read-only admission; a rejection must not invoke cleanup.
      await preflightVariant?.(context);
      signal?.throwIfAborted();
      assert.ok(
        !(await installed()),
        "Installation appeared during scenario preflight",
      );
      activeContext = context;
      await install(variant.apk, packageName, record.appSha256);
      await install(variant.testApk, testPackage, record.testSha256);
      for (const item of companions)
        await install(item.apk, item.packageName, item.sha256);
      signal?.throwIfAborted();
      const instrument = async (args, label) => {
        for (const [name, expected] of owned)
          assert.equal(
            await installedHash(name),
            expected,
            "Installed APK changed before instrumentation",
          );
        let output;
        try {
          output = await run(
            "shell",
            "am",
            "instrument",
            "--user",
            String(androidUser),
            "-w",
            "-r",
            "-e",
            "class",
            testMethod === undefined
              ? classes.join(",")
              : `${classes[0]}#${testMethod}`,
            ...args,
            `${testPackage}/${runner}`,
          );
        } catch (error) {
          fs.writeFileSync(
            path.join(
              directory,
              `${variant.name}${label ? `-${label}` : ""}.log`,
            ),
            `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
          );
          throw error;
        }
        fs.writeFileSync(
          path.join(
            directory,
            `${variant.name}${label ? `-${label}` : ""}.log`,
          ),
          output,
        );
        const instrumentation = requireInstrumentationSuccess(output, classes);
        assert.equal(
          instrumentation.totalTests,
          expectedTests,
          "Unexpected test count",
        );
        if (testMethod !== undefined)
          assert.deepEqual(
            instrumentation.cases,
            [`${classes[0]}#${testMethod}`],
            "Requested method missing",
          );
        return instrumentation;
      };
      const phaseNames = new Set();
      context.instrumentPhase = async (name, args = []) => {
        assert.match(name, /^[A-Za-z][A-Za-z0-9_-]*$/);
        assert.ok(!phaseNames.has(name), "Duplicate instrumentation phase");
        validateRunnerArgs(args);
        const copiedArgs = [...args];
        assert.ok(
          !campaignFinished &&
            record === report.variants.at(-1) &&
            !record.passed &&
            owned.has(packageName) &&
            owned.has(testPackage),
          "Instrumentation requires both owned packages in the active variant",
        );
        phaseNames.add(name);
        const phase = { name, passed: false };
        record.phases ??= [];
        record.phases.push(phase);
        try {
          phase.instrumentation = await instrument(copiedArgs, `phase-${name}`);
          phase.passed = true;
          return phase.instrumentation;
        } catch (error) {
          phase.error = error.message;
          throw error;
        }
      };
      await prepareVariant?.(context);
      signal?.throwIfAborted();
      record.instrumentation = await instrument(
        runnerArgs,
        variant.upgrade ? "baseline" : "",
      );
      if (variant.upgrade) {
        await beforeUpgrade?.(context);
        signal?.throwIfAborted();
        await install(
          variant.upgrade.apk,
          packageName,
          record.upgrade.appSha256,
          true,
        );
        await afterUpgrade?.(context);
        signal?.throwIfAborted();
        await install(
          variant.upgrade.testApk,
          testPackage,
          record.upgrade.testSha256,
          true,
        );
        record.upgrade.instrumentation = await instrument(
          upgradeRunnerArgs,
          "candidate",
        );
      }
      await collectVariant?.(context);
      signal?.throwIfAborted();
      await restoreScenario();
      assert.ok(
        record.phases?.every((phase) => phase.passed) ?? true,
        "Instrumentation phase failed",
      );
      record.finalInstalledHashes = {};
      for (const name of owned.keys()) {
        const hash = await installedHash(name);
        assert.ok(
          cleanupHashAllowed(name, hash),
          "Installed APK changed before cleanup",
        );
        record.finalInstalledHashes[name] = hash;
      }
      record.passed = true;
      for (const name of [...owned.keys()].reverse())
        await run("uninstall", name);
      assert.ok(!(await installed()), "Variant package cleanup failed");
      owned.clear();
      assert.equal(await home(), previousHome, "Default HOME changed");
    }
    report.verifiedAt = new Date().toISOString();
  } catch (error) {
    failure = error;
    report.failure = error.message;
  } finally {
    try {
      cleaning = true;
      if (admitted) {
        // Only identities absent from all users at admission are owned by this run.
        report.cleanupErrors = [];
        try {
          await restoreScenario();
        } catch {
          /* Recorded by restoreScenario, including normal-path failures. */
        }
        if (scenarioCleanupFailure)
          report.cleanupErrors.push(
            `Scenario cleanup failed: ${scenarioCleanupFailure.message}`,
          );
        const remainingOwned = [];
        for (const name of [...owned.keys()].reverse()) {
          try {
            if ((await packages()).includes(`package:${name}`)) {
              assert.ok(
                cleanupHashAllowed(name, await installedHash(name)),
                "Owned APK changed; retain installation for recovery",
              );
              remainingOwned.push(name);
              await run(
                "shell",
                "am",
                "force-stop",
                "--user",
                String(androidUser),
                name,
              );
            }
          } catch (error) {
            report.cleanupErrors.push(
              `Could not stop ${name}: ${error.code ?? error.status ?? "command failed"}`,
            );
          }
        }
        // Every owned process must stop before any installed package is removed.
        // A failed/uncertain stop preserves the set for explicit fixture recovery.
        report.cleanupDeferred = report.cleanupErrors.length > 0;
        if (!report.cleanupDeferred)
          for (const name of remainingOwned) {
            try {
              await run("uninstall", name);
            } catch (error) {
              report.cleanupErrors.push(
                `Could not clean ${name}: ${error.code ?? error.status ?? "command failed"}`,
              );
            }
          }
        try {
          report.cleaned = !(await installed());
          report.homeUnchanged = (await home()) === previousHome;
        } catch {
          report.cleaned = false;
          report.homeUnchanged = false;
        }
        fs.writeFileSync(
          path.join(directory, "verification.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
        if (
          !report.cleaned ||
          !report.homeUnchanged ||
          report.cleanupErrors.length
        )
          failure ??= new Error(
            "Isolated test cleanup or HOME verification failed",
          );
      }
    } finally {
      // Revoke saved phase callbacks even when cleanup retains the installed APKs.
      campaignFinished = true;
      if (!deviceLease) lease.release();
    }
  }
  if (failure) throw failure;
  return report;
}
