import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { acquireDeviceLease, deviceLeaseStateDir } from "./device-lease.ts";
import { runIsolatedAndroidTest } from "./isolated-android-test.mjs";
import { withIsolatedAndroidUser } from "./isolated-android-user.mjs";

const executeFile = promisify(execFile);

/** Compose APK verification with a fresh user under one live-process lease.
 * Product hooks retain fixture/permission policy. Callers own cancellation and
 * must settle all callback work; cleanup uses its independent command deadline.
 */
export async function runIsolatedAndroidUserTest({
  homePackage,
  userName,
  ...options
}) {
  assert.equal(options.androidUser, undefined, "The lifecycle owns the user");
  assert.equal(options.deviceLease, undefined, "The lifecycle owns the lease");
  const {
    serial,
    adb,
    directory,
    packageName,
    testPackage = `${packageName}.test`,
    env = process.env,
    signal = new AbortController().signal,
    commandTimeoutMs,
    cleanupTimeoutMs,
  } = options;
  assert.match(serial ?? "", /^emulator-\d+$/);
  assert.ok(path.isAbsolute(directory), "Absolute evidence directory required");
  for (const timeout of [commandTimeoutMs, cleanupTimeoutMs])
    assert.ok(
      Number.isSafeInteger(timeout) && timeout > 0,
      "Bounded command and cleanup deadlines required",
    );
  signal?.throwIfAborted();
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  // Exclusive creation prevents stale verification.json from proving cleanup.
  fs.mkdirSync(directory);
  const report = { serial, packageName, testPackage, passed: false };
  const persist = () =>
    fs.writeFileSync(
      path.join(directory, "user-verification.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  const execute = async (args, { signal: operationSignal } = {}) =>
    (
      await executeFile(adb, ["-s", serial, ...args], {
        env,
        encoding: "utf8",
        signal: operationSignal,
        timeout:
          operationSignal === signal ? commandTimeoutMs : cleanupTimeoutMs,
        maxBuffer: 4 * 1024 ** 2,
      })
    ).stdout;
  let lease, failure;
  try {
    lease = await acquireDeviceLease(`android:${serial}`, {
      waitMs: 0,
      ttlMs: Number.MAX_SAFE_INTEGER,
      stateDir: deviceLeaseStateDir(env),
    });
    const packages = (
      await execute(
        ["shell", "pm", "list", "packages", "-u", "--user", "all"],
        { signal },
      )
    ).split(/\r?\n/);
    assert.ok(
      ![
        packageName,
        testPackage,
        ...(options.companionApks ?? []).map((item) => item.packageName),
      ].some((name) => packages.includes(`package:${name}`)),
      "Existing package registration; refusing replacement",
    );
    await withIsolatedAndroidUser({
      execute,
      serial,
      env,
      deviceLease: lease,
      expectedAvdName: options.expectedAvdName,
      homePackage,
      name: userName,
      signal,
      record: (state) => {
        report.userLifecycle = state;
        persist();
      },
      run: async ({ user }) => {
        report.androidUser = user;
        try {
          report.result = await runIsolatedAndroidTest({
            ...options,
            androidUser: user,
            deviceLease: lease,
          });
        } catch (error) {
          failure = error;
          report.error = error.message;
        }
        // The harness persists cleanup even when instrumentation fails. If it
        // never admitted the run or couldn't write proof, retain the user.
        let proof;
        try {
          proof = JSON.parse(
            fs.readFileSync(path.join(directory, "verification.json"), "utf8"),
          );
        } catch {
          /* Missing proof cannot authorize user removal. */
        }
        return {
          cleaned:
            proof?.serial === serial &&
            proof?.packageName === packageName &&
            proof?.testPackage === testPackage &&
            proof?.androidUser === user &&
            proof?.cleaned === true,
          cleanupDeferred: proof?.cleanupDeferred !== false,
        };
      },
    });
  } catch (error) {
    if (failure && failure !== error) {
      report.lifecycleError = error.message;
      failure = new AggregateError(
        [failure, error],
        "Android test and user lifecycle failed",
      );
    } else failure = error;
    report.error ??= error.message;
  } finally {
    report.passed = !failure;
    try {
      persist();
    } finally {
      lease?.release();
    }
  }
  if (failure) throw failure;
  return report;
}
