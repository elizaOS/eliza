import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  activeLeaseStatus,
  deviceLeasePath,
  deviceLeaseStateDir,
  readDeviceLease,
} from "./device-lease.ts";

/** Lifecycle for a fresh secondary user on a caller-owned, leased emulator.
 * execute(args, {signal}) must enforce the caller's command deadline.
 * run must settle all device work and return explicit package cleanup evidence.
 */
export async function withIsolatedAndroidUser({
  execute,
  serial,
  deviceLease,
  env = process.env,
  expectedAvdName,
  homePackage,
  name,
  run,
  record,
  signal,
  waitMs = 15000,
  homeWaitMs = 60000,
  pollMs = 150,
}) {
  assert.match(serial ?? "", /^emulator-\d+$/);
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
  assert.equal(typeof execute, "function");
  assert.equal(typeof run, "function");
  assert.equal(typeof record, "function");
  assert.match(expectedAvdName ?? "", /^[A-Za-z0-9_.-]+$/);
  assert.match(
    homePackage ?? "",
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/,
  );
  assert.match(name ?? "", /^[A-Za-z0-9_.-]+$/);
  for (const value of [waitMs, homeWaitMs, pollMs])
    assert.ok(Number.isSafeInteger(value) && value > 0);
  const call = async (args, cleanup = false) => {
    if (!cleanup) signal?.throwIfAborted();
    return String(
      await execute(args, { signal: cleanup ? undefined : signal }),
    ).trim();
  };
  const wait = async (predicate, message, timeout, cleanup = false) => {
    const deadline = Date.now() + timeout;
    do {
      if (!cleanup) signal?.throwIfAborted();
      if (await predicate()) return;
      if (Date.now() >= deadline) throw Error(message);
      await delay(Math.min(pollMs, deadline - Date.now()), undefined, {
        signal: cleanup ? undefined : signal,
      });
    } while (Date.now() < deadline);
    throw Error(message);
  };
  assert.equal(
    (await call(["emu", "avd", "name"])).split(/\r?\n/)[0],
    expectedAvdName,
    "Owned AVD identity mismatch",
  );
  assert.equal(
    await call(["shell", "am", "get-current-user"]),
    "0",
    "Original user must be owner 0",
  );
  const report = {
    user: null,
    ownerRestored: false,
    cleanupDeferred: true,
    removed: false,
  };
  let primary,
    result,
    entered = false;
  try {
    const created = await call(["shell", "pm", "create-user", name]);
    const user = Number(
      created.match(/^Success: created user id (\d+)$/m)?.[1],
    );
    assert.ok(
      Number.isSafeInteger(user) && user > 0,
      "No owned secondary user",
    );
    report.user = user;
    await record({ ...report });
    const id = String(user);
    await call(["shell", "am", "start-user", "-w", id]);
    const home = (
      await call([
        "shell",
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        "--user",
        "0",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.HOME",
        "-p",
        homePackage,
      ])
    )
      .split(/\r?\n/)
      .at(-1);
    assert.ok(
      home.startsWith(`${homePackage}/`) && /^[A-Za-z0-9_.$/]+$/.test(home),
      "Stock HOME unavailable",
    );
    assert.match(
      await call([
        "shell",
        "cmd",
        "package",
        "set-home-activity",
        "--user",
        id,
        home,
      ]),
      /Success/,
    );
    await call(["shell", "am", "switch-user", id]);
    await wait(
      async () => (await call(["shell", "am", "get-current-user"])) === id,
      "Owned user not foreground",
      waitMs,
    );
    await call(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    await call(["shell", "wm", "dismiss-keyguard"]);
    const foreground = new RegExp(
      `topResumedActivity=.*\\bu${user}\\b.*${homePackage.replaceAll(".", "\\.")}/`,
    );
    await wait(
      async () =>
        foreground.test(
          await call(["shell", "dumpsys", "activity", "activities"]),
        ),
      "Owned user launcher not resumed",
      homeWaitMs,
    );
    entered = true;
    result = await run({ user, signal });
  } catch (error) {
    primary = error;
    report.error = error.message;
  } finally {
    try {
      await call(["shell", "am", "switch-user", "0"], true);
      await wait(
        async () =>
          (await call(["shell", "am", "get-current-user"], true)) === "0",
        "Owner not restored",
        waitMs,
        true,
      );
      await wait(
        async () =>
          /topResumedActivity=.*\bu0\b/.test(
            await call(["shell", "dumpsys", "activity", "activities"], true),
          ),
        "Owner Activity not resumed",
        waitMs,
        true,
      );
      report.ownerRestored = true;
      // A thrown callback or missing proof may leave installed packages or live instrumentation.
      report.cleanupDeferred =
        entered &&
        (result?.cleaned !== true || result?.cleanupDeferred === true);
      if (report.user && !report.cleanupDeferred) {
        const id = String(report.user);
        await call(["shell", "am", "stop-user", "-w", id], true);
        await wait(
          async () =>
            (await call(["shell", "am", "is-user-stopped", id], true)) ===
            "true",
          "Owned user did not stop",
          waitMs,
          true,
        );
        assert.match(
          await call(["shell", "pm", "remove-user", "--wait", id], true),
          /^Success\b/,
        );
        const users = await call(["shell", "pm", "list", "users"], true);
        assert.match(users, /UserInfo\{0:/, "User inventory unavailable");
        assert.ok(
          !new RegExp(`UserInfo\\{${id}:`).test(users),
          "Owned user remains",
        );
        report.removed = true;
      }
    } catch (error) {
      primary ??= error;
      report.cleanupDeferred = true;
      report.cleanupError = error.message;
    }
    try {
      await record({ ...report });
    } catch (error) {
      primary ??= error;
    }
  }
  if (primary) throw primary;
  assert.equal(
    report.cleanupDeferred,
    false,
    "Owned user cleanup deferred; recover explicitly",
  );
  return { result, ...report };
}
