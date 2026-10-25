import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rebootAndroidFixture } from "./android-fixture-reboot.mjs";
import { acquireDeviceLease } from "./device-lease.ts";

const oldBoot = "11111111-1111-4111-8111-111111111111";
const newBoot = "22222222-2222-4222-8222-222222222222";
async function fixture(t, mode = "") {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reboot-fixture-"));
  const lease = await acquireDeviceLease("android:emulator-5580", {
    stateDir,
    waitMs: 0,
    ttlMs: Number.MAX_SAFE_INTEGER,
  });
  t.after(() => {
    lease.release();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const calls = [];
  let rebooted = false,
    switched = false;
  const controller = new AbortController();
  const context = {
    serial: "emulator-5580",
    androidUser: 12,
    deviceLease: lease,
    env: { ELIZA_DEVICE_LEASE_DIR: stateDir },
    signal: controller.signal,
    run: async (...args) => {
      calls.push(args);
      const command = args.join(" ");
      if (command === "emu avd name")
        return mode === "wrong-avd" ? "other\nOK" : "owned\nOK";
      if (command === "shell am get-current-user")
        return mode === "wrong-user" || (rebooted && !switched) ? "0" : "12";
      if (command === "shell cat /proc/sys/kernel/random/boot_id")
        return mode === "invalid-boot"
          ? "unknown"
          : rebooted && mode !== "same-boot"
            ? newBoot
            : oldBoot;
      if (command === "reboot") {
        rebooted = true;
        if (mode === "abort") controller.abort();
        return "";
      }
      if (command === "wait-for-device") return "";
      if (command === "shell getprop sys.boot_completed")
        return mode === "incomplete" ? "0" : "1";
      if (command === "shell am start-user -w 12")
        return "Success: user started";
      if (command === "shell am switch-user 12") {
        switched = true;
        return "";
      }
      if (
        command === "shell input keyevent KEYCODE_WAKEUP" ||
        command === "shell wm dismiss-keyguard"
      )
        return "";
      if (command === "shell am get-started-user-state 12")
        return mode === "locked" ? "RUNNING_LOCKED" : "RUNNING_UNLOCKED";
      throw Error(`Unexpected command: ${command}`);
    },
  };
  return {
    context,
    calls,
    controller,
    options: { expectedAvdName: "owned", timeoutMs: 40, pollMs: 1 },
  };
}
test("reboot proves changed boot identity and resumes the same user without starting the app", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await rebootAndroidFixture(f.context, f.options), {
    before: oldBoot,
    after: newBoot,
    androidUser: 12,
  });
  assert.ok(
    f.calls.some((a) => a.join(" ") === "shell am get-started-user-state 12"),
  );
  assert.ok(
    !f.calls.some(
      (a) =>
        a.includes("instrument") ||
        a.includes("force-stop") ||
        a.includes("start") ||
        a.includes("remove-user"),
    ),
  );
  assert.ok(
    fs.existsSync(f.context.deviceLease.path),
    "Caller still owns the lease",
  );
});
for (const mode of ["wrong-avd", "wrong-user", "invalid-boot"])
  test(`${mode} refuses before reboot`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(rebootAndroidFixture(f.context, f.options));
    assert.ok(!f.calls.some((a) => a[0] === "reboot"));
  });
for (const mode of ["same-boot", "incomplete", "locked"])
  test(`${mode} cannot satisfy boot readiness`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(
      rebootAndroidFixture(f.context, f.options),
      mode === "locked" ? /unlocked/ : /boot/,
    );
  });
test("cancellation stops further device commands", async (t) => {
  const f = await fixture(t, "abort");
  await assert.rejects(rebootAndroidFixture(f.context, f.options), {
    name: "AbortError",
  });
  assert.deepEqual(f.calls.at(-1), ["reboot"]);
});
test("released lease and owner user are rejected before device access", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    rebootAndroidFixture({ ...f.context, androidUser: 0 }, f.options),
  );
  f.context.deviceLease.release();
  await assert.rejects(rebootAndroidFixture(f.context, f.options));
  assert.equal(f.calls.length, 0);
});
test("transport failure is preserved and never turned into boot success", async (t) => {
  const f = await fixture(t);
  const failure = Error("transport broke");
  f.context.run = async () => {
    throw failure;
  };
  await assert.rejects(
    rebootAndroidFixture(f.context, f.options),
    (e) => e === failure,
  );
});
