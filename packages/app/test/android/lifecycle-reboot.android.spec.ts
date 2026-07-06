// Reboot leg of the #12185 device-lifecycle matrix: "running out of battery
// and turning the device back on". Reboots the device via adb and proves
// ElizaBootReceiver auto-starts the agent foreground service from
// BOOT_COMPLETED — WITHOUT launching the app — then that a normal app launch
// reaches a healthy agent loopback. Uses plain adb (no WebView fixture): the
// CDP connection cannot survive a reboot, so this spec must not share the
// android-harness page fixture; run it as its own Playwright invocation
// (test:e2e:android:lifecycle:reboot), after lifecycle.android.spec.ts.
//
// Emulator caveat (same as scripts/android-e2e.mjs): setenforce is runtime
// state, so a reboot restores SELinux enforcing and the untrusted_app domain
// blocks the bun runtime. The spec re-applies root+permissive right after
// boot, mirroring ensureEmulatorPermissive — branded AOSP devices run the
// agent privileged and skip this.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
} from "../../scripts/lib/android-capture.mjs";
import {
  AGENT_API_PORT,
  APP_ID,
  ensureEmulatorPermissive,
  MAIN_ACTIVITY,
  resolveAdb,
  resolveSerial,
} from "../../scripts/lib/android-device.mjs";

const ARTIFACT_DIR = path.resolve(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ??
    path.join(
      process.cwd(),
      "..",
      "..",
      "test-results",
      "android-artifacts",
      "12185-device-lifecycle",
      "android",
    ),
  "lifecycle-reboot",
);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adbCmd(adb: string, serial: string, ...args: string[]): string {
  return execFileSync(adb, ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function tryAdbCmd(adb: string, serial: string, ...args: string[]): string {
  try {
    return adbCmd(adb, serial, ...args);
  } catch {
    return "";
  }
}

function agentServicePresent(adb: string, serial: string): boolean {
  return tryAdbCmd(
    adb,
    serial,
    "shell",
    "dumpsys",
    "activity",
    "services",
    APP_ID,
  ).includes(`${APP_ID}/.ElizaAgentService`);
}

function agentBundlePid(adb: string, serial: string): string {
  const line = tryAdbCmd(
    adb,
    serial,
    "shell",
    "sh",
    "-c",
    "ps -A -o PID,CMDLINE 2>/dev/null | grep agent-bundle.js | grep -v grep",
  ).trim();
  return line.split(/\s+/)[0] ?? "";
}

async function pollAgentHealth(
  adb: string,
  serial: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const port = tryAdbCmd(
    adb,
    serial,
    "forward",
    "tcp:0",
    `tcp:${AGENT_API_PORT}`,
  ).trim();
  if (!port) throw new Error("adb forward for agent health failed");
  try {
    const deadline = Date.now() + timeoutMs;
    let last = { status: 0, body: "" };
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { "X-ElizaOS-Client-Id": "android-lifecycle-reboot" },
          signal: AbortSignal.timeout(5_000),
        });
        last = { status: res.status, body: await res.text() };
        if (res.status === 200) return last;
      } catch (error) {
        last = { status: 0, body: String(error) };
      }
      await delay(3_000);
    }
    return last;
  } finally {
    tryAdbCmd(adb, serial, "forward", "--remove", `tcp:${port}`);
  }
}

test("reboot: ElizaBootReceiver auto-starts the agent service, app relaunch reaches a healthy agent", async () => {
  // Rebooting mid-sweep would sever every other spec's adb/CDP session; the
  // dedicated npm script opts in and runs this file alone, last.
  test.skip(
    process.env.ELIZA_ANDROID_LIFECYCLE_REBOOT !== "1",
    "reboot leg — run via test:e2e:android:lifecycle:reboot (sets ELIZA_ANDROID_LIFECYCLE_REBOOT=1)",
  );
  test.setTimeout(900_000);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const adb = resolveAdb();
  const serial = resolveSerial(adb, process.env.ANDROID_SERIAL);

  // Pre-reboot ground truth: the persisted runtime mode gates shouldAutoStart.
  const prefsBefore = tryAdbCmd(
    adb,
    serial,
    "shell",
    "run-as",
    APP_ID,
    "cat",
    "shared_prefs/CapacitorStorage.xml",
  );
  const rebootRequestedAt = Date.now();

  adbCmd(adb, serial, "reboot");
  execFileSync(adb, ["-s", serial, "wait-for-device"], { timeout: 300_000 });
  await expect
    .poll(
      () =>
        tryAdbCmd(adb, serial, "shell", "getprop", "sys.boot_completed").trim(),
      { timeout: 300_000, message: "device never finished booting" },
    )
    .toBe("1");

  // Emulator-only: restore the permissive SELinux the agent needs (runtime
  // setenforce does not survive a reboot). No-op on physical devices.
  await ensureEmulatorPermissive(adb, serial, {
    log: (message: string) => console.log(`[lifecycle-reboot] ${message}`),
  });
  tryAdbCmd(adb, serial, "shell", "wm", "dismiss-keyguard");

  // BOOT_COMPLETED delivery + receiver work can trail sys.boot_completed by
  // tens of seconds on a cold emulator. The app is NOT launched here — a
  // service record proves ElizaBootReceiver ran and started the FGS itself.
  await expect
    .poll(() => agentServicePresent(adb, serial), {
      timeout: 240_000,
      message:
        "ElizaBootReceiver never auto-started ElizaAgentService after reboot",
    })
    .toBe(true);
  const bootDiagnostics = tryAdbCmd(
    adb,
    serial,
    "shell",
    "run-as",
    APP_ID,
    "sh",
    "-c",
    "tail -c 4000 files/agent/agent-restart-diagnostics.jsonl",
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, "09-reboot-agent-diagnostics.jsonl"),
    bootDiagnostics,
  );

  // Now the user "turns the device on and opens the app": launch and require
  // a healthy agent loopback end-to-end. Cold boot + model load is minutes on
  // an emulated CPU.
  adbCmd(adb, serial, "shell", "am", "start", "-W", "-n", MAIN_ACTIVITY);
  const health = await pollAgentHealth(adb, serial, 480_000);
  captureAndroidScreenshot({
    adb,
    serial,
    artifactDir: ARTIFACT_DIR,
    filename: "09-after-reboot.png",
  });
  captureAndroidLogcat({
    adb,
    serial,
    artifactDir: ARTIFACT_DIR,
    filename: "09-reboot-logcat.txt",
    lines: 2_000,
  });

  const prefsAfter = tryAdbCmd(
    adb,
    serial,
    "shell",
    "run-as",
    APP_ID,
    "cat",
    "shared_prefs/CapacitorStorage.xml",
  );
  const report = {
    event: "reboot-boot-receiver-autostart",
    serial,
    rebootRequestedAt,
    agentServiceAfterBoot: true,
    agentPidAfterBoot: agentBundlePid(adb, serial),
    health,
    firstRunStatePersisted: prefsAfter.includes("eliza:first-run-complete"),
    prefsBeforeHadFirstRun: prefsBefore.includes("eliza:first-run-complete"),
  };
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, "reboot-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  expect(health.status, `agent health after reboot: ${health.body}`).toBe(200);
  expect(
    report.firstRunStatePersisted,
    "Capacitor Preferences survived the reboot",
  ).toBe(true);
});
