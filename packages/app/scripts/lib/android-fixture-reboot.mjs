import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  activeLeaseStatus,
  deviceLeasePath,
  deviceLeaseStateDir,
  readDeviceLease,
} from "./device-lease.ts";

/** Reboot a leased emulator and unlock its existing fixture user without launching
 * the target app or instrumentation. run must enforce a per-command deadline.
 * Callers retain alarm observation, package cleanup and lease ownership.
 */
export async function rebootAndroidFixture(
  { run, serial, androidUser, deviceLease, env = process.env, signal },
  { expectedAvdName, timeoutMs = 120000, pollMs = 500 } = {},
) {
  assert.equal(typeof run, "function");
  assert.match(serial ?? "", /^emulator-\d+$/);
  assert.match(expectedAvdName ?? "", /^[A-Za-z0-9_.-]+$/);
  assert.ok(Number.isSafeInteger(androidUser) && androidUser > 0);
  for (const value of [timeoutMs, pollMs])
    assert.ok(Number.isSafeInteger(value) && value > 0);
  const key = `android:${serial}`,
    stateDir = deviceLeaseStateDir(env);
  assert.equal(deviceLease?.path, deviceLeasePath(key, stateDir));
  assert.equal(deviceLease.lease.pid, process.pid, "Caller must own the lease");
  assert.equal(deviceLease.lease.ttlMs, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(readDeviceLease(key, { stateDir }), deviceLease.lease);
  assert.ok(
    activeLeaseStatus(deviceLease.lease).active,
    "Caller lease is stale",
  );
  const call = async (...args) => {
    signal?.throwIfAborted();
    return String(await run(...args)).trim();
  };
  const user = String(androidUser);
  assert.equal(
    (await call("emu", "avd", "name")).split(/\r?\n/)[0],
    expectedAvdName,
  );
  assert.equal(
    await call("shell", "am", "get-current-user"),
    user,
    "Fixture user must be foreground",
  );
  const bootId = async () => {
    const value = await call("shell", "cat", "/proc/sys/kernel/random/boot_id");
    assert.match(value, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    return value;
  };
  const before = await bootId();
  await call("reboot");
  await call("wait-for-device");
  const deadline = performance.now() + timeoutMs;
  const wait = async (predicate, message) => {
    while (performance.now() < deadline) {
      if (await predicate()) return;
      await delay(
        Math.min(pollMs, Math.max(1, deadline - performance.now())),
        undefined,
        { signal },
      );
    }
    throw Error(message);
  };
  let after;
  await wait(async () => {
    after = await bootId();
    return (
      after !== before &&
      (await call("shell", "getprop", "sys.boot_completed")) === "1"
    );
  }, "Changed boot ID and completed boot required");
  assert.equal(
    (await call("emu", "avd", "name")).split(/\r?\n/)[0],
    expectedAvdName,
  );
  // A reboot can return to owner 0. Resume the same disposable user, never the app:
  // starting instrumentation here would cancel the alarm being observed.
  await call("shell", "am", "start-user", "-w", user);
  await call("shell", "am", "switch-user", user);
  await call("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  await call("shell", "wm", "dismiss-keyguard");
  await wait(
    async () =>
      (await call("shell", "am", "get-current-user")) === user &&
      (await call("shell", "am", "get-started-user-state", user)) ===
        "RUNNING_UNLOCKED",
    "Fixture user did not return unlocked",
  );
  return { before, after, androidUser };
}
