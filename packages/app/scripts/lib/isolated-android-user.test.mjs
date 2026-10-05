import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireDeviceLease } from "./device-lease.ts";
import { withIsolatedAndroidUser } from "./isolated-android-user.mjs";

async function fixture(t, mode = "") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "android-user-"));
  const env = { ...process.env, ELIZA_DEVICE_LEASE_DIR: directory };
  const serial = `emulator-${process.pid}`;
  const lease = await acquireDeviceLease(`android:${serial}`, {
    waitMs: 0,
    ttlMs: Number.MAX_SAFE_INTEGER,
    stateDir: directory,
  });
  t.after(() => {
    lease.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const calls = [],
    reports = [],
    controller = new AbortController();
  let current = "0",
    exists = false;
  const execute = async (args, options) => {
    calls.push({ args, signal: options.signal });
    const command = args.join(" ");
    if (command === "emu avd name")
      return mode === "wrong-avd" ? "other" : "owned\nOK";
    if (command === "shell am get-current-user") return current;
    if (args.includes("create-user")) {
      exists = true;
      return "Success: created user id 10";
    }
    if (args.includes("start-user")) return "Success";
    if (args.includes("resolve-activity"))
      return mode === "bad-home" ? "other.pkg/.Home" : "org.stock.home/.Home";
    if (args.includes("set-home-activity")) return "Success";
    if (args.includes("switch-user")) {
      if (mode === "restore-fails" && args.at(-1) === "0")
        throw Error("restore failed");
      current = args.at(-1);
      return "";
    }
    if (args.includes("keyevent") || args.includes("dismiss-keyguard"))
      return "";
    if (command === "shell dumpsys activity activities")
      return `topResumedActivity=ActivityRecord u${current} org.stock.home/.Home`;
    if (args.includes("stop-user")) return "";
    if (args.includes("is-user-stopped")) return "true";
    if (args.includes("remove-user")) {
      exists = mode === "remove-lies";
      return "Success";
    }
    if (command === "shell pm list users")
      return `UserInfo{0:Owner:13}${exists ? "\nUserInfo{10:Fixture:10}" : ""}`;
    throw Error(`Unexpected command ${command}`);
  };
  const options = {
    execute,
    serial,
    deviceLease: lease,
    env,
    expectedAvdName: "owned",
    homePackage: "org.stock.home",
    name: "fixture",
    signal: controller.signal,
    waitMs: 100,
    homeWaitMs: 100,
    pollMs: 1,
    record: (value) => reports.push(value),
    run: async ({ user }) => {
      assert.equal(user, 10);
      return { cleaned: true };
    },
  };
  return { options, calls, reports, controller };
}

test("fresh user is persisted before setup and removed only after explicit cleanup", async (t) => {
  const f = await fixture(t);
  const result = await withIsolatedAndroidUser(f.options);
  assert.equal(f.reports[0].user, 10);
  assert.equal(result.removed, true);
  assert.equal(result.ownerRestored, true);
  assert.equal(f.calls.filter((c) => c.args.includes("remove-user")).length, 1);
});
for (const mode of ["wrong-avd", "bad-home", "restore-fails", "remove-lies"])
  test(`rejects ${mode}`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(withIsolatedAndroidUser(f.options));
    if (mode === "wrong-avd") assert.equal(f.calls.length, 1);
    if (mode === "bad-home") assert.equal(f.reports.at(-1).removed, true);
    if (mode === "restore-fails")
      assert.equal(
        f.calls.some((c) => c.args.includes("remove-user")),
        false,
      );
    if (mode === "remove-lies")
      assert.equal(f.reports.at(-1).cleanupDeferred, true);
  });
test("missing callback cleanup proof retains the user", async (t) => {
  const f = await fixture(t);
  f.options.run = async () => ({});
  await assert.rejects(withIsolatedAndroidUser(f.options), /cleanup deferred/);
  assert.equal(f.reports.at(-1).ownerRestored, true);
  assert.equal(
    f.calls.some((c) => c.args.includes("remove-user")),
    false,
  );
});
test("cancelled callback preserves its failure and restores owner without aborted signal", async (t) => {
  const f = await fixture(t);
  f.options.run = async () => {
    f.controller.abort();
    throw Error("instrumentation uncertain");
  };
  await assert.rejects(
    withIsolatedAndroidUser(f.options),
    /instrumentation uncertain/,
  );
  const restoration = f.calls.find(
    (c) => c.args.includes("switch-user") && c.args.at(-1) === "0",
  );
  assert.equal(restoration.signal, undefined);
  assert.equal(
    f.calls.some((c) => c.args.includes("remove-user")),
    false,
  );
});
test("unowned lease refuses before any command", async (t) => {
  const f = await fixture(t);
  f.options.deviceLease = {
    ...f.options.deviceLease,
    lease: { ...f.options.deviceLease.lease, pid: 1 },
  };
  await assert.rejects(withIsolatedAndroidUser(f.options), /own the lease/);
  assert.equal(f.calls.length, 0);
});

test("contradictory cleanup evidence retains the user", async (t) => {
  const f = await fixture(t);
  f.options.run = async () => ({ cleaned: true, cleanupDeferred: true });
  await assert.rejects(withIsolatedAndroidUser(f.options), /cleanup deferred/);
  assert.equal(
    f.calls.some((c) => c.args.includes("remove-user")),
    false,
  );
});
