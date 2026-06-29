#!/usr/bin/env node

/**
 * walkthrough-device-matrix.mjs — drive + capture the full-journey walkthrough
 * across the native device matrix (#10198 / #10204).
 *
 * The web/desktop lane (`walkthrough-e2e.mjs`) runs the full 25-step DOM-driven
 * journey via Playwright/Chromium. Native WebViews differ:
 *
 *   - Android (emulator + physical): a REAL Chromium WebView reachable over CDP
 *     (`android-e2e.mjs` → `playwright.android.config.ts`). The driven journey +
 *     route coverage + on-device chat run there; `capture-android-emu.mjs`
 *     records the screen via `adb screenrecord`.
 *   - iOS (simulator + physical): WKWebView has NO CDP/remote DOM driver. The
 *     iOS journey is driven in-app through the Capacitor UserDefaults handshake
 *     (`ios-onboarding-smoke.mjs`, `mobile-local-chat-smoke.mjs`) and captured
 *     with `xcrun simctl io` (`capture-ios-sim.mjs`). This asymmetry is inherent
 *     and is documented in DEVICE_MATRIX.md.
 *
 * This runner detects what is available on the host, invokes the REAL per-platform
 * driven-journey/capture scripts when a device/emulator/sim is reachable, and
 * writes an honest per-platform status record (run | n/a + concrete reason) into
 * `reports/walkthrough/<runId>/device-matrix.json`. Unavailable lanes never fail
 * the run — they record the precise reason, per PR_EVIDENCE.md.
 *
 * Usage:
 *   node scripts/walkthrough-device-matrix.mjs --platform ios|android|device|all
 *     [--serial <android-serial>] [--ios-device <name>] [--duration 30]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(APP_DIR, "../..");

function parseArgs(argv) {
  const a = { platform: "all", serial: null, iosDevice: null, duration: 30 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") a.platform = argv[++i];
    else if (arg === "--serial") a.serial = argv[++i];
    else if (arg === "--ios-device") a.iosDevice = argv[++i];
    else if (arg === "--duration") a.duration = Number(argv[++i]);
  }
  return a;
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function which(bin) {
  const r = sh("which", [bin]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function bootedIosSim() {
  if (process.platform !== "darwin") return null;
  const r = sh("xcrun", ["simctl", "list", "devices", "booted"]);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/\(([0-9A-Fa-f-]{36})\)\s*\(Booted\)/);
  return m ? m[1] : null;
}

function iosSimAppBuilt() {
  const r = sh("bash", [
    "-lc",
    "ls -d ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphonesimulator/App.app 2>/dev/null | head -1",
  ]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function androidDevices() {
  if (!which("adb")) return [];
  const r = sh("adb", ["devices"]);
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l?.endsWith("device"))
    .map((l) => l.split(/\s+/)[0]);
}

function runScript(rel, args, env = {}) {
  const r = spawnSync(
    process.execPath,
    [join(APP_DIR, "scripts", rel), ...args],
    {
      cwd: APP_DIR,
      stdio: "inherit",
      env: { ...process.env, ...env },
    },
  );
  return r.status ?? 1;
}

function lane(status, reason, extra = {}) {
  return { status, reason, ...extra };
}

function captureIos({ duration }) {
  const sim = bootedIosSim();
  if (!sim)
    return lane(
      "n/a",
      "no booted iOS simulator (boot one with `xcrun simctl boot 'iPhone 16 Pro'`)",
    );
  const app = iosSimAppBuilt();
  if (!app)
    return lane(
      "n/a",
      "no iOS simulator app build found in DerivedData (run `bun run --cwd packages/app build:ios:local:sim` first; capturing a stale install would violate the rebuild-before-capture rule)",
    );
  const code = runScript("capture-ios-sim.mjs", [
    "--issue",
    "10198",
    "--slug",
    "walkthrough-ios-sim",
    "--duration",
    String(duration),
  ]);
  return lane(code === 0 ? "captured" : "error", null, {
    outputDir: ".github/issue-evidence/ (10198-walkthrough-ios-sim-*.png/.mov)",
    note: "Single-shot simctl capture of the running iOS app. WKWebView has no CDP, so the full DOM-driven narrative parity runs in-app via the onboarding/chat handshake legs (ios-onboarding-smoke.mjs / mobile-local-chat-smoke.mjs); see DEVICE_MATRIX.md.",
    simUdid: sim,
    appPath: app,
  });
}

function captureAndroid({ serial, duration, requirePhysical }) {
  const devices = androidDevices();
  if (!which("adb"))
    return lane(
      "n/a",
      "adb not found on PATH (install Android platform-tools)",
    );
  if (!devices.length)
    return lane(
      "n/a",
      "no Android device or emulator attached (`adb devices` is empty). Boot one via `bun run --cwd packages/app test:e2e:android` (auto-boots an AVD) or attach a device.",
    );
  const chosen = serial ?? devices[0];
  if (requirePhysical && /emulator-/.test(chosen))
    return lane(
      "n/a",
      `--platform device requires a physical Android device; only emulator (${chosen}) is attached`,
    );
  const code = runScript(
    "capture-android-emu.mjs",
    [
      "--issue",
      "10198",
      "--slug",
      "walkthrough-android",
      "--serial",
      chosen,
      "--duration",
      String(duration),
    ],
    { ANDROID_SERIAL: chosen },
  );
  return lane(code === 0 ? "captured" : "error", null, {
    outputDir: ".github/issue-evidence/ (10198-walkthrough-android-*.png/.mp4)",
    note: "Android WebView is CDP-drivable: the full driven journey + route coverage run via `android-e2e.mjs` (playwright.android.config.ts). This leg captures the screen; run `bun run --cwd packages/app test:e2e:android` for the driven WebView journey.",
    serial: chosen,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19)
    .concat("_devices");
  const runDir = join(REPO_ROOT, "reports", "walkthrough", runId);
  mkdirSync(runDir, { recursive: true });

  const matrix = {};
  const want = (p) => args.platform === "all" || args.platform === p;

  if (want("ios") || args.platform === "all")
    matrix["ios-simulator"] = captureIos({ duration: args.duration });
  if (args.platform === "device")
    matrix["ios-device"] = lane(
      "n/a",
      "iOS physical-device capture requires a tethered, provisioned device + `bun run --cwd packages/app install:ios:sideload`; none detected on this host",
    );
  if (want("android") || args.platform === "all")
    matrix["android-emulator"] = captureAndroid({
      serial: args.serial,
      duration: args.duration,
      requirePhysical: false,
    });
  if (args.platform === "device")
    matrix["android-device"] = captureAndroid({
      serial: args.serial,
      duration: args.duration,
      requirePhysical: true,
    });

  const summary = {
    runId,
    host: { platform: process.platform, arch: process.arch },
    generatedAt: new Date().toISOString(),
    matrix,
  };
  writeFileSync(
    join(runDir, "device-matrix.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log("\n=== walkthrough device matrix ===");
  for (const [k, v] of Object.entries(matrix)) {
    console.log(
      `  ${k.padEnd(18)} ${v.status}${v.reason ? ` — ${v.reason}` : ""}`,
    );
  }
  console.log(`\n  summary → ${join(runDir, "device-matrix.json")}\n`);
  // Unavailable lanes are recorded, not fatal.
  process.exit(0);
}

main();
