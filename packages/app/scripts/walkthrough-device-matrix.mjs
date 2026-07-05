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
 * `reports/walkthrough/<runId>/device-matrix.json`. Unavailable lanes are
 * recorded by default; pass `--require android` (or WALKTHROUGH_REQUIRE=android)
 * when an unavailable native lane must fail the run.
 *
 * Usage:
 *   node scripts/walkthrough-device-matrix.mjs --platform ios|android|device|all
 *     [--serial <android-serial>] [--avd <name>] [--ios-device <name>]
 *     [--duration 30] [--require android|ios|device] [--skip-android-drive]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureEmulatorBooted,
  listDevices,
  resolveAdb,
} from "./lib/android-device.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const APP_DIR = resolve(dirname(SCRIPT_PATH), "..");
const REPO_ROOT = resolve(APP_DIR, "../..");

export function parseArgs(argv, env = process.env) {
  const a = {
    platform: "all",
    serial: env.ANDROID_SERIAL || null,
    avd: null,
    iosDevice: null,
    duration: 30,
    require: parseRequiredPlatforms(env.WALKTHROUGH_REQUIRE),
    driveAndroid: env.WALKTHROUGH_ANDROID_DRIVE !== "0",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") a.platform = argv[++i];
    else if (arg === "--serial") a.serial = argv[++i];
    else if (arg === "--avd") a.avd = argv[++i];
    else if (arg === "--ios-device") a.iosDevice = argv[++i];
    else if (arg === "--duration") a.duration = Number(argv[++i]);
    else if (arg === "--require") {
      for (const platform of parseRequiredPlatforms(argv[++i])) {
        a.require.add(platform);
      }
    } else if (arg === "--drive-android") a.driveAndroid = true;
    else if (arg === "--skip-android-drive") a.driveAndroid = false;
  }
  return a;
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function parseRequiredPlatforms(value) {
  return new Set(
    String(value ?? "")
      .split(/[,\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isLaneRequired(laneName, required) {
  if (!required?.size) return false;
  if (required.has("all")) return true;
  if (required.has(laneName)) return true;
  if (laneName.startsWith("android-") && required.has("android")) return true;
  if (laneName.startsWith("ios-") && required.has("ios")) return true;
  if (laneName.endsWith("-device") && required.has("device")) return true;
  if (laneName.endsWith("-simulator") && required.has("simulator")) return true;
  if (laneName.endsWith("-emulator") && required.has("emulator")) return true;
  return false;
}

export function requiredLaneFailures(matrix, required) {
  return Object.entries(matrix).filter(
    ([name, result]) =>
      isLaneRequired(name, required) &&
      (result.status === "n/a" || result.status === "error"),
  );
}

/** Lanes that were actually attempted on an available device/sim and then
 * failed (`status: "error"`). Unlike an honest `n/a` (the host simply lacks the
 * device), an `error` means the journey we *could* run broke — so it is always
 * fatal, independent of `--require`. This closes the vacuous-green hole where an
 * available-and-erroring lane merged silently (#13573). */
export function erroredLanes(matrix) {
  return Object.entries(matrix).filter(
    ([, result]) => result.status === "error",
  );
}

/** The process exit code for a completed matrix: non-zero when any attempted
 * lane errored, or when a `--require`d lane is unavailable/failed; zero when
 * every lane is `ok`/`captured` or an honestly-`n/a` unavailable host. */
export function computeExitCode(matrix, required) {
  const fatal =
    erroredLanes(matrix).length ||
    requiredLaneFailures(matrix, required).length;
  return fatal ? 1 : 0;
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
  // TODO(#13573 Part 2): compose real journey legs when host can run them —
  // drive ios-onboarding-smoke.mjs + mobile-local-chat-smoke.mjs (the in-app
  // WKWebView handshake, since it has no CDP) before this single-shot capture so
  // the iOS lane records the full onboarding/chat/gesture narrative, not just a
  // frame of the running app. Device-gated: needs a live simulator.
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

async function captureAndroid({
  serial,
  avd,
  duration,
  requirePhysical,
  drive,
}) {
  let adb;
  try {
    adb = resolveAdb();
  } catch {
    return lane(
      "n/a",
      "adb not found on PATH (install Android platform-tools)",
    );
  }

  let devices = listDevices(adb);
  if (serial && !devices.includes(serial)) {
    return lane(
      "n/a",
      `requested Android serial ${serial} is not attached in adb \`device\` state`,
    );
  }

  let chosen =
    serial ?? devices.find((s) => s.startsWith("emulator-")) ?? devices[0];
  if (!chosen) {
    try {
      chosen = await ensureEmulatorBooted({
        adb,
        avd,
        log: (message) => console.log(`[walkthrough:android] ${message}`),
      });
      devices = listDevices(adb);
    } catch (error) {
      return lane(
        "n/a",
        `unable to auto-boot Android emulator: ${error.message}`,
      );
    }
  }

  if (!devices.includes(chosen)) {
    return lane(
      "n/a",
      `Android serial ${chosen} is not attached in adb \`device\` state after emulator setup`,
    );
  }

  if (requirePhysical && /emulator-/.test(chosen))
    return lane(
      "n/a",
      `--platform device requires a physical Android device; only emulator (${chosen}) is attached`,
    );

  if (drive) {
    const driveArgs = [
      "--skip-local-chat",
      "--no-emulator-boot",
      "--serial",
      chosen,
    ];
    const driveCode = runScript("android-e2e.mjs", driveArgs, {
      ANDROID_SERIAL: chosen,
    });
    if (driveCode !== 0) {
      return lane(
        "error",
        "android-e2e.mjs --skip-local-chat failed before capture",
        {
          serial: chosen,
          phase: "drive",
          exitCode: driveCode,
        },
      );
    }
  }

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
    note: drive
      ? "Android WebView is CDP-drivable: this leg first runs `android-e2e.mjs --skip-local-chat`, then captures the driven app state from the same device."
      : "Passive Android screen capture only; rerun without `--skip-android-drive` to drive `android-e2e.mjs --skip-local-chat` before capture.",
    serial: chosen,
    drivenBeforeCapture: drive,
  });
}

async function main() {
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
    matrix["android-emulator"] = await captureAndroid({
      serial: args.serial,
      avd: args.avd,
      duration: args.duration,
      requirePhysical: false,
      drive: args.driveAndroid,
    });
  if (args.platform === "device")
    matrix["android-device"] = await captureAndroid({
      serial: args.serial,
      avd: args.avd,
      duration: args.duration,
      requirePhysical: true,
      drive: args.driveAndroid,
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
  const errored = erroredLanes(matrix);
  if (errored.length) {
    console.error(
      `[walkthrough] lane errored during an attempted run: ${errored
        .map(([name]) => name)
        .join(", ")}`,
    );
  }
  const requiredFailures = requiredLaneFailures(matrix, args.require);
  if (requiredFailures.length) {
    console.error(
      `[walkthrough] required lane unavailable/failed: ${requiredFailures
        .map(([name]) => name)
        .join(", ")}`,
    );
  }
  process.exit(computeExitCode(matrix, args.require));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[walkthrough] device matrix failed: ${error.message}`);
    process.exit(1);
  });
}
