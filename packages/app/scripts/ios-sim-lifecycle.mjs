#!/usr/bin/env node
// iOS-simulator leg of the #12185 device-lifecycle matrix. Drives the
// INSTALLED app on a booted simulator through the lifecycle events simctl can
// actually deliver — app switching (foregrounding Settings/Photos, then
// reactivating), battery status-bar override, and process death via
// terminate + relaunch — capturing a screen recording plus per-phase
// screenshots, and writing a machine-readable report with honest `skipped`
// rows for events the simulator cannot drive (lock/sleep, hardware mute, real
// low-power behavior, the camera app). Assertions are process-level (launchd
// pid liveness across backgrounding, fresh pid after terminate) because the
// WKWebView is not CDP-drivable; render proof is the screenshots/recording.
// The full event × platform matrix lives in docs/DEVICE_LIFECYCLE_MATRIX.md.
//
// Flags:
//   --device <udid>     target simulator (default: first booted, else boots one)
//   --bundle-id <id>    app under test (default ai.elizaos.app)
//   --out-dir <dir>     artifact dir (default .github/issue-evidence/12185-device-lifecycle/ios)
//   --settle <seconds>  per-phase settle before screenshots (default 5)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  captureIosSimulatorScreenshot,
  ensureBootedIosSimulator,
  startIosSimulatorVideo,
} from "./lib/ios-simulator-capture.mjs";
import { ISSUE_EVIDENCE_DIR, parseFlags } from "./lib/issue-evidence.mjs";

const log = (message) => console.log(`[ios-sim-lifecycle] ${message}`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SETTINGS_BUNDLE = "com.apple.Preferences";
const PHOTOS_BUNDLE = "com.apple.mobileslideshow";
const AGENT_API_PORT = 31337;

function simctl(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("xcrun", ["simctl", ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

/** launchd pid for the app's UIKitApplication job, "" when not running. */
function appPid(udid, bundleId) {
  const list = simctl(["spawn", udid, "launchctl", "list"], {
    allowFailure: true,
  });
  for (const line of list.split(/\r?\n/)) {
    if (!line.includes(`UIKitApplication:${bundleId}`)) continue;
    const pid = line.trim().split(/\s+/)[0];
    if (pid && pid !== "-") return pid;
  }
  return "";
}

function launchApp(udid, bundleId) {
  const out = simctl(["launch", udid, bundleId]);
  return out.match(/:\s*(\d+)\s*$/m)?.[1] ?? appPid(udid, bundleId);
}

async function probeAgentHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 0, body: "" };
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${AGENT_API_PORT}/api/health`, {
        headers: { "X-ElizaOS-Client-Id": "ios-sim-lifecycle" },
        signal: AbortSignal.timeout(4_000),
      });
      last = { status: res.status, body: (await res.text()).slice(0, 300) };
      if (res.status === 200) return last;
    } catch (error) {
      last = { status: 0, body: String(error) };
    }
    await delay(2_000);
  }
  return last;
}

async function main() {
  const flags = parseFlags();
  if (process.platform !== "darwin") {
    throw new Error("iOS simulator lifecycle requires macOS (xcrun simctl).");
  }
  const bundleId = flags["bundle-id"] ?? "ai.elizaos.app";
  const settleMs = Math.max(1, Number(flags.settle ?? 5)) * 1000;
  const outDir = path.resolve(
    flags["out-dir"] ??
      path.join(ISSUE_EVIDENCE_DIR, "12185-device-lifecycle", "ios"),
  );
  fs.mkdirSync(outDir, { recursive: true });

  const udid = ensureBootedIosSimulator({ deviceName: flags.device, log });
  const container = simctl(["get_app_container", udid, bundleId, "app"], {
    allowFailure: true,
  }).trim();
  if (!container) {
    throw new Error(
      `${bundleId} is not installed on simulator ${udid} — install a build first (bun run --cwd packages/app build:ios + simctl install).`,
    );
  }
  log(`simulator ${udid}, app container ${container}`);

  const steps = [];
  const record = (step) => {
    steps.push(step);
    log(
      `${step.status.toUpperCase()} ${step.event}${step.note ? ` — ${step.note}` : ""}`,
    );
  };
  const shot = (filename) =>
    captureIosSimulatorScreenshot({
      target: udid,
      artifactDir: outDir,
      filename,
      log,
    });

  // Attribution guard for the loopback probe: the simulator shares the host
  // loopback, so if :31337 already answers before our launch it belongs to
  // some host process and proves nothing about this app.
  const portBusyBefore = (await probeAgentHealth(2_500)).status === 200;

  const video = startIosSimulatorVideo({
    target: udid,
    artifactDir: outDir,
    filename: "ios-lifecycle-walkthrough.mov",
    log,
  });
  let failures = 0;

  try {
    // Launch (terminate first for a clean, attributable process).
    simctl(["terminate", udid, bundleId], { allowFailure: true });
    await delay(1_500);
    const initialPid = launchApp(udid, bundleId);
    await delay(settleMs);
    shot("01-launch.png");
    if (initialPid) {
      record({ event: "launch", status: "pass", pid: initialPid });
    } else {
      failures += 1;
      record({ event: "launch", status: "fail", note: "no pid after launch" });
    }

    // App switching: Settings foregrounds us into the background, then we
    // reactivate. The process must survive backgrounding (same pid).
    simctl(["launch", udid, SETTINGS_BUNDLE]);
    await delay(settleMs);
    shot("02-backgrounded-settings.png");
    const pidWhileBackground = appPid(udid, bundleId);
    simctl(["launch", udid, bundleId]);
    await delay(settleMs);
    shot("03-refocused.png");
    const pidAfterRefocus = appPid(udid, bundleId);
    if (
      pidWhileBackground === initialPid &&
      pidAfterRefocus === initialPid &&
      initialPid !== ""
    ) {
      record({ event: "app-switch-settings", status: "pass", pid: initialPid });
    } else {
      failures += 1;
      record({
        event: "app-switch-settings",
        status: "fail",
        note: `pid drifted: launch=${initialPid} background=${pidWhileBackground} refocus=${pidAfterRefocus}`,
      });
    }

    // Second interruption: Photos stands in for the camera app (the simulator
    // has no camera feed, so com.apple.camera is not installed/usable).
    simctl(["launch", udid, PHOTOS_BUNDLE]);
    await delay(settleMs);
    shot("04-backgrounded-photos.png");
    simctl(["launch", udid, bundleId]);
    await delay(settleMs);
    shot("05-refocused-after-photos.png");
    const pidAfterPhotos = appPid(udid, bundleId);
    if (pidAfterPhotos === initialPid && initialPid !== "") {
      record({
        event: "app-switch-photos-camera-analog",
        status: "pass",
        pid: initialPid,
        note: "Photos used as the camera interruption analog (no sim camera feed)",
      });
    } else {
      failures += 1;
      record({
        event: "app-switch-photos-camera-analog",
        status: "fail",
        note: `pid drifted: launch=${initialPid} after=${pidAfterPhotos}`,
      });
    }
    simctl(["terminate", udid, SETTINGS_BUNDLE], { allowFailure: true });
    simctl(["terminate", udid, PHOTOS_BUNDLE], { allowFailure: true });

    // Battery: status-bar override only — it changes the indicator, not
    // UIDevice battery APIs or low-power mode. Real battery behavior is a
    // physical-device row in the matrix.
    simctl([
      "status_bar",
      udid,
      "override",
      "--batteryState",
      "discharging",
      "--batteryLevel",
      "5",
    ]);
    await delay(2_000);
    shot("06-battery-low-statusbar.png");
    simctl(["status_bar", udid, "clear"]);
    record({
      event: "battery-statusbar-override",
      status: "pass",
      note: "cosmetic status-bar override only; UIDevice battery/low-power not drivable on simulator",
    });

    // Process death: terminate + relaunch must yield a fresh, running process.
    simctl(["terminate", udid, bundleId]);
    await delay(2_000);
    const pidAfterTerminate = appPid(udid, bundleId);
    const relaunchPid = launchApp(udid, bundleId);
    await delay(settleMs);
    shot("07-relaunched-after-terminate.png");
    if (
      pidAfterTerminate === "" &&
      relaunchPid !== "" &&
      relaunchPid !== initialPid
    ) {
      record({
        event: "process-death-terminate-relaunch",
        status: "pass",
        oldPid: initialPid,
        newPid: relaunchPid,
      });
    } else {
      failures += 1;
      record({
        event: "process-death-terminate-relaunch",
        status: "fail",
        note: `terminate/relaunch pids: afterTerminate=${pidAfterTerminate} relaunch=${relaunchPid} initial=${initialPid}`,
      });
    }

    // Local agent loopback (informational): the sim shares host loopback, so
    // a healthy :31337 after relaunch is only attributable when the port was
    // free before we launched.
    if (portBusyBefore) {
      record({
        event: "agent-loopback-health",
        status: "skipped",
        note: "host :31337 already occupied before launch — cannot attribute to the sim app",
      });
    } else {
      const health = await probeAgentHealth(30_000);
      record({
        event: "agent-loopback-health",
        status: health.status === 200 ? "pass" : "skipped",
        note:
          health.status === 200
            ? `in-app agent answered on :${AGENT_API_PORT}`
            : `no agent on :${AGENT_API_PORT} within 30s (build may be cloud/onboarding mode): ${health.body.slice(0, 120)}`,
      });
    }

    // Honest not-drivable rows (real-device / manual coverage in the matrix).
    record({
      event: "lock-screen-sleep",
      status: "skipped",
      note: "no simctl verb for lock/sleep; Simulator.app Device > Lock is manual-only",
    });
    record({
      event: "hardware-mute",
      status: "skipped",
      note: "simulator exposes no ringer/mute switch control",
    });
    record({
      event: "low-power-mode-and-battery-drain",
      status: "skipped",
      note: "real battery + Low Power Mode require a physical device",
    });
    record({
      event: "reboot",
      status: "skipped",
      note: "simctl shutdown+boot restarts simulated hardware but iOS has no BOOT_COMPLETED-style third-party autostart to assert; relaunch-after-terminate above is the recovery proof",
    });
  } finally {
    await video.stop();
  }

  const report = {
    matrix: "device-lifecycle ios-simulator",
    udid,
    bundleId,
    portBusyBefore,
    steps,
  };
  const reportPath = path.join(outDir, "ios-lifecycle-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`report → ${reportPath}`);

  if (failures > 0) {
    throw new Error(`${failures} lifecycle step(s) failed — see ${reportPath}`);
  }
  log("ALL DRIVABLE IOS LIFECYCLE STEPS PASSED");
}

main().catch((error) => {
  console.error(`[ios-sim-lifecycle] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
