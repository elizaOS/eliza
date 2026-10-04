import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDeviceLease } from "../../../../packages/app/scripts/lib/device-lease.ts";
import { runIsolatedAndroidTest } from "../../../../packages/app/scripts/lib/isolated-android-test.mjs";
import { testOutputPath } from "../../../../packages/scripts/lib/test-output.ts";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  assert.ok(
    [
      "--adb",
      "--aapt",
      "--serial",
      "--avd",
      "--abi",
      "--command-timeout-ms",
      "--instrumentation-timeout-ms",
    ].includes(key) &&
      value &&
      !options.has(key),
    "Supply unique --adb, --aapt, --serial --avd and --abi options",
  );
  options.set(key, value);
}
const adb = options.get("--adb"),
  aapt = options.get("--aapt"),
  serial = options.get("--serial"),
  avd = options.get("--avd"),
  abi = options.get("--abi");
assert.ok(adb && aapt);
assert.ok(
  ["arm64-v8a", "x86_64"].includes(abi),
  "Explicit fixture ABI required",
);
assert.match(serial ?? "", /^emulator-\d+$/);
assert.match(avd ?? "", /^[A-Za-z0-9_.-]+$/);
const commandTimeoutMs = Number(options.get("--command-timeout-ms") ?? 120000);
const instrumentationTimeoutMs = Number(
  options.get("--instrumentation-timeout-ms") ?? 300000,
);
for (const deadline of [commandTimeoutMs, instrumentationTimeoutMs])
  assert.ok(Number.isSafeInteger(deadline) && deadline > 0);
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const hostCancellation = new AbortController();
process.once("SIGINT", () => hostCancellation.abort());
process.once("SIGTERM", () => hostCancellation.abort());
const run = (...args) =>
  execFileSync(adb, ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: commandTimeoutMs,
  }).trim();
const deviceLease = await acquireDeviceLease(`android:${serial}`, {
  waitMs: 0,
  ttlMs: Number.MAX_SAFE_INTEGER,
});
try {
  assert.equal(run("emu", "avd", "name").split(/\r?\n/)[0], avd);
  assert.equal(run("shell", "am", "get-current-user"), "0");
  const parent = testOutputPath(
    "isolated-calendar-consumer",
    `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
  );
  fs.mkdirSync(parent, { recursive: true });
  const receipts = [];
  for (const mode of ["cancelled", "complete"]) {
    hostCancellation.signal.throwIfAborted();
    let user, timer, failure;
    const receipt = { mode, originalForegroundUser: 0, fixtureAvd: avd };
    receipts.push(receipt);
    try {
      const result = run(
        "shell",
        "pm",
        "create-user",
        "--ephemeral",
        `calendar-harness-${mode}`,
      );
      user = Number(/Success: created user id (\d+)/.exec(result)?.[1]);
      assert.ok(Number.isSafeInteger(user) && user > 0);
      receipt.ownedSecondaryUser = user;
      run("shell", "am", "start-user", "-w", String(user));
      run("shell", "am", "switch-user", String(user));
      for (let attempt = 0; attempt < 120; attempt++) {
        if (
          run("shell", "am", "get-started-user-state", String(user)) ===
          "RUNNING_UNLOCKED"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(
        run("shell", "am", "get-started-user-state", String(user)),
        "RUNNING_UNLOCKED",
      );
      const controller = new AbortController();
      const directory = path.join(parent, mode);
      const execute = () =>
        runIsolatedAndroidTest({
          serial,
          adb,
          aapt,
          packageName: "example.calendar.consumer",
          testClass: "example.calendar.ConsumerReadAccessTest",
          requiredAbi: abi,
          deviceLease,
          expectedAvdName: avd,
          androidUser: user,
          signal: AbortSignal.any([hostCancellation.signal, controller.signal]),
          commandTimeoutMs,
          instrumentationTimeoutMs,
          cleanupTimeoutMs: commandTimeoutMs,
          directory,
          evidence:
            "Fresh host-owned secondary-user CalendarProvider fixture. No live account or primary-user calendar access.",
          runnerArgs: ["-e", "calendarReadAccess", "1"],
          variants: [
            {
              name: mode,
              apk: path.join(
                repo,
                "plugins/plugin-native-calendar/test/android-consumer/build/outputs/apk/debug/android-consumer-debug.apk",
              ),
              testApk: path.join(
                repo,
                "plugins/plugin-native-calendar/test/android-consumer/build/outputs/apk/androidTest/debug/android-consumer-debug-androidTest.apk",
              ),
            },
          ],
          prepareVariant: () => {
            for (const permission of ["READ_CALENDAR", "WRITE_CALENDAR"])
              run(
                "shell",
                "pm",
                "grant",
                "--user",
                String(user),
                "example.calendar.consumer",
                `android.permission.${permission}`,
              );
            if (mode === "cancelled")
              timer = setTimeout(() => controller.abort(), 100);
          },
        });
      if (mode === "cancelled") {
        await assert.rejects(execute, (error) => error.name === "AbortError");
        hostCancellation.signal.throwIfAborted();
        receipt.cancelled = true;
      } else receipt.result = await execute();
      const proof = JSON.parse(
        fs.readFileSync(path.join(directory, "verification.json")),
      );
      assert.equal(proof.cleaned, true);
      assert.equal(proof.homeUnchanged, true);
      receipt.closedArtifactReceipt = proof;
    } catch (error) {
      failure = error;
      receipt.failure = error.message;
    } finally {
      clearTimeout(timer);
      const cleanupErrors = [];
      try {
        if (run("shell", "am", "get-current-user") !== "0")
          run("shell", "am", "switch-user", "0");
        receipt.foregroundRestored =
          run("shell", "am", "get-current-user") === "0";
        assert.equal(receipt.foregroundRestored, true);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (user)
        try {
          receipt.userRemoval = run("shell", "pm", "remove-user", String(user));
          assert.match(receipt.userRemoval, /Success/);
        } catch (error) {
          cleanupErrors.push(error);
        }
      receipt.cleanupErrors = cleanupErrors.map((error) => error.message);
      fs.writeFileSync(
        path.join(parent, "receipts.json"),
        `${JSON.stringify(receipts, null, 2)}\n`,
      );
      if (cleanupErrors.length)
        failure = new AggregateError(
          [...(failure ? [failure] : []), ...cleanupErrors],
          "Fixture cleanup failed; see receipts.json",
        );
    }
    if (failure) throw failure;
  }
  console.log(JSON.stringify({ directory: parent, receipts }, null, 2));
} finally {
  deviceLease.release();
}
