/** Explicit consumer APK acceptance. Never replaces an existing installation. */
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
import { acquireDeviceLease, deviceLeaseStateDir } from "./device-lease.ts";
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
  testClass,
  expectedTests = 1,
  requiredAbi,
  expectedAvdName,
  androidUser,
  signal,
  commandTimeoutMs,
  cleanupTimeoutMs,
  variants,
  directory,
  evidence,
  runnerArgs = [],
  instrumentationTimeoutMs,
  prepareVariant,
  collectVariant,
}) {
  assert.match(serial ?? "", /^emulator-\d+$/);
  for (const name of [packageName, testPackage, runner, testClass])
    assert.match(name ?? "", packagePattern);
  assert.notEqual(packageName, testPackage);
  assert.ok(
    ["arm64-v8a", "x86_64"].includes(requiredAbi),
    "Explicit emulator ABI required",
  );
  assert.ok(Number.isSafeInteger(expectedTests) && expectedTests > 0);
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
  assert.ok(
    path.isAbsolute(directory),
    "Explicit absolute report directory required",
  );
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
  const names = new Set();
  // Validate every artifact before the first install, including instrumentation's target.
  const records = [];
  for (const variant of variants) {
    signal?.throwIfAborted();
    assert.match(variant.name ?? "", /^[a-z0-9-]+$/);
    assert.ok(!names.has(variant.name));
    names.add(variant.name);
    for (const [apk, expected] of [
      [variant.apk, packageName],
      [variant.testApk, testPackage],
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
        await dumpAndroidArtifactManifestAsync(aapt, variant.testApk, {
          signal,
          timeout: commandTimeoutMs,
        }),
      ),
      [{ name: runner, targetPackage: packageName }],
      "Instrumentation target or runner mismatch",
    );
    records.push({
      variant: variant.name,
      appSha256: sha256(variant.apk),
      testSha256: sha256(variant.testApk),
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
      [packageName, testPackage].some((name) => line === `package:${name}`),
    );
  // The canonical lease still reclaims dead PIDs. It must not expire under a live caller's work.
  const lease = await acquireDeviceLease(`android:${serial}`, {
    waitMs: 0,
    ttlMs: Number.MAX_SAFE_INTEGER,
    stateDir: deviceLeaseStateDir(env),
  });
  const report = {
    serial,
    packageName,
    testPackage,
    expectedAvdName,
    requiredAbi,
    androidUser,
    evidence,
    variants: [],
  };
  let admitted = false,
    previousHome,
    failure;
  const owned = new Set();
  try {
    assert.equal(
      (await run("shell", "getprop", "ro.kernel.qemu")).trim(),
      "1",
      "Disposable emulator required",
    );
    assert.equal(
      (await run("shell", "getprop", "ro.product.cpu.abi")).trim(),
      requiredAbi,
      expectedAvdName,
      signal,
      commandTimeoutMs,
      cleanupTimeoutMs,
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
      owned.add(packageName);
      await run("install", "--user", String(androidUser), variant.apk);
      owned.add(testPackage);
      await run(
        "install",
        "--user",
        String(androidUser),
        "-t",
        variant.testApk,
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
      };
      signal?.throwIfAborted();
      await prepareVariant?.(context);
      signal?.throwIfAborted();
      const output = await run(
        "shell",
        "am",
        "instrument",
        "--user",
        String(androidUser),
        "-w",
        "-r",
        "-e",
        "class",
        testClass,
        ...runnerArgs,
        `${testPackage}/${runner}`,
      );
      fs.writeFileSync(path.join(directory, `${variant.name}.log`), output);
      record.instrumentation = requireInstrumentationSuccess(output, [
        testClass,
      ]);
      assert.equal(
        record.instrumentation.totalTests,
        expectedTests,
        "Unexpected test count",
      );
      await collectVariant?.(context);
      signal?.throwIfAborted();
      record.passed = true;
      await run("uninstall", testPackage);
      await run("uninstall", packageName);
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
        for (const name of [testPackage, packageName].filter((name) =>
          owned.has(name),
        )) {
          try {
            const remaining = (await packages()).includes(`package:${name}`);
            if (remaining) {
              try {
                await run(
                  "shell",
                  "am",
                  "force-stop",
                  "--user",
                  String(androidUser),
                  name,
                );
              } catch (error) {
                report.cleanupErrors.push(
                  `Could not stop ${name}: ${error.code ?? error.status ?? "command failed"}`,
                );
              }
              await run("uninstall", name);
            }
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
      lease.release();
    }
  }
  if (failure) throw failure;
  return report;
}
