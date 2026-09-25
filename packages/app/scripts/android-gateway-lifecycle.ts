#!/usr/bin/env node
/** Exercise the production gateway service against Android's actual FGS timeout. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { acquireDeviceLease } from "./lib/device-lease.ts";

const serial = process.argv[process.argv.indexOf("--serial") + 1];
if (!process.argv.includes("--serial") || !serial || serial.startsWith("--"))
  throw new Error("Pass --serial <disposable Android 15+ emulator>");
const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath(
  "android-gateway-lifecycle",
  new Date().toISOString().replaceAll(":", "-"),
);
fs.mkdirSync(output, { recursive: true });
const run = (binary: string, args: string[], timeout = 120000) =>
  execFileSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
const adb = (...args: string[]) => run("adb", ["-s", serial, ...args]);
const pkg = "ai.eliza.testing.gatewayhost";
const component = `${pkg}/ai.elizaos.app.GatewayConnectionService`;
const setting = "data_sync_fgs_timeout_duration";
const report = {
  revision: run("git", ["rev-parse", "HEAD"]).trim(),
  worktreeChanges: run("git", ["status", "--porcelain"]),
  serial,
  pass: false,
  startedAt: new Date().toISOString(),
  scope:
    "Production GatewayConnectionService in a disposable minimal Activity host; real OS timeout, exhausted-budget start and foreground recovery. Not full MainActivity or WebSocket qualification.",
  observations: [] as { name: string; value: string }[],
  problems: [] as string[],
};
const save = () =>
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
const observe = (name: string, value: string) => {
  report.observations.push({ name, value });
  save();
  return value;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lease = await acquireDeviceLease(`android:${serial}`, { waitMs: 0 });
let installed = false;
let oldSetting: string | undefined;
let since: string | undefined;
const service = () => adb("shell", "dumpsys", "activity", "services", pkg);
const running = (value: string) =>
  /ServiceRecord\{[^\n]*GatewayConnectionService/.test(value);
async function until(label: string, predicate: () => boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(250);
  }
}
try {
  save();
  if (
    adb("shell", "getprop", "ro.kernel.qemu").trim() !== "1" ||
    Number(adb("shell", "getprop", "ro.build.version.sdk").trim()) < 35
  )
    throw new Error("Requires a disposable Android 15+ emulator");
  if (adb("shell", "pm", "list", "packages", pkg).trim())
    throw new Error("Refusing to replace an existing lifecycle fixture");
  const project = "packages/app/scripts/android-native-plugins-gradle";
  try {
    fs.writeFileSync(
      path.join(output, "build.log"),
      run(
        "packages/app/platforms/android/gradlew",
        [
          "-p",
          project,
          "--no-daemon",
          "--max-workers=4",
          ":native-gateway-host:assembleDebug",
        ],
        1200000,
      ),
    );
  } catch (error) {
    fs.writeFileSync(path.join(output, "build.log"), String(error));
    throw error;
  }
  const apk = path.join(
    root,
    project,
    "native-gateway-host/build/outputs/apk/debug/native-gateway-host-debug.apk",
  );
  observe(
    "apkSha256",
    createHash("sha256").update(fs.readFileSync(apk)).digest("hex"),
  );
  observe(
    "productionSourceSha256",
    createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(
            root,
            "packages/app/platforms/android/app/src/main/java/ai/elizaos/app/GatewayConnectionService.java",
          ),
        ),
      )
      .digest("hex"),
  );
  oldSetting = adb(
    "shell",
    "device_config",
    "get",
    "activity_manager",
    setting,
  ).trim();
  observe("originalTimeout", oldSetting);
  adb("shell", "device_config", "put", "activity_manager", setting, "10000");
  installed = true;
  adb("install", "-t", "-g", apk);
  since = `${adb("shell", "date", "+%s").trim()}.000`;
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "wm", "dismiss-keyguard");
  for (const mode of ["local", "cloud", "cloud-hybrid"]) {
    const record = (name: string, value: string) =>
      observe(`${mode}:${name}`, value);
    const cycleSince = `${adb("shell", "date", "+%s").trim()}.000`;
    const launch = () =>
      adb(
        "shell",
        "am",
        "start",
        "-W",
        "-f",
        "0x10008000",
        "-n",
        `${pkg}/ai.elizaos.app.MainActivity`,
        "--es",
        "runtimeMode",
        mode,
      );
    launch();
    await until("initial foreground service", () =>
      /isForeground=true/.test(service()),
    );
    record("initialService", service());
    fs.writeFileSync(
      path.join(output, `${mode}-host.png`),
      execFileSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
        timeout: 10000,
      }),
    );
    const originalPid = record("initialPid", adb("shell", "pidof", pkg).trim());
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await until("OS timeout stops service", () => !running(service()));
    await sleep(6000);
    record("afterTimeoutService", service());
    // pidof exits nonzero on process death; preserve that as a failure.
    if (
      record("afterTimeoutPid", adb("shell", "pidof", pkg).trim()) !==
      originalPid
    )
      throw new Error("Gateway process restarted after timeout");
    const timeoutLogs = adb(
      "logcat",
      "-d",
      "-T",
      cycleSince,
      "GatewayConnection:V",
      "*:S",
    );
    record("timeoutLogs", timeoutLogs);
    if (!timeoutLogs.includes("event=gateway_service_timeout"))
      throw new Error("Missing receipt from actual Android timeout callback");
    record(
      "exhaustedBudgetStart",
      adb("shell", "am", "start-foreground-service", "-n", component),
    );
    await sleep(6000);
    if (
      record("afterRejectedStartPid", adb("shell", "pidof", pkg).trim()) !==
        originalPid ||
      running(record("afterRejectedStartService", service()))
    )
      throw new Error("Exhausted budget start must stop without crashing");
    const rejectionLogs = record(
      "rejectionLogs",
      adb("logcat", "-d", "-T", cycleSince, "GatewayConnection:V", "*:S"),
    );
    if (
      !rejectionLogs.includes("event=gateway_service_start_denied") ||
      !rejectionLogs.includes(
        "Time limit already exhausted for foreground service type dataSync",
      )
    )
      throw new Error("Missing receipt for startForeground rejection");
    launch();
    await until("visible Activity restores service eligibility", () =>
      /isForeground=true/.test(service()),
    );
    record("recoveredService", service());
    if (
      record("recoveredPid", adb("shell", "pidof", pkg).trim()) !== originalPid
    )
      throw new Error("Foreground recovery required a process restart");
    adb(
      "shell",
      "am",
      "startservice",
      "-n",
      component,
      "-a",
      "app.eliza.action.STOP_GATEWAY",
    );
    await until("stop recovered service", () => !running(service()));
  }
  report.pass = true;
} catch (error) {
  report.problems.push(String(error));
} finally {
  const cleanup = (name: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      report.pass = false;
      report.problems.push(`${name}: ${error}`);
    }
  };
  const logSince = since;
  if (logSince)
    cleanup("Capture diagnostics", () => {
      fs.writeFileSync(
        path.join(output, "gateway.log"),
        adb(
          "logcat",
          "-d",
          "-T",
          logSince,
          "GatewayConnection:V",
          "AndroidRuntime:E",
          "*:S",
        ),
      );
      fs.writeFileSync(
        path.join(output, "exit-info.txt"),
        adb("shell", "dumpsys", "activity", "exit-info", pkg),
      );
    });
  if (installed)
    cleanup("Remove fixture", () => {
      adb("uninstall", pkg);
    });
  const restoreSetting = oldSetting;
  if (restoreSetting !== undefined)
    cleanup("Restore timeout", () => {
      if (oldSetting === "null")
        adb("shell", "device_config", "delete", "activity_manager", setting);
      else
        adb(
          "shell",
          "device_config",
          "put",
          "activity_manager",
          setting,
          restoreSetting,
        );
      if (
        observe(
          "restoredTimeout",
          adb(
            "shell",
            "device_config",
            "get",
            "activity_manager",
            setting,
          ).trim(),
        ) !== oldSetting
      )
        throw new Error("Timeout setting restoration failed");
    });
  save();
  await lease.release();
}
console.log(
  `${report.pass ? "PASS" : "FAIL"}: ${path.join(output, "report.json")}`,
);
if (!report.pass) process.exitCode = 1;
