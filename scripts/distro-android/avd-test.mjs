#!/usr/bin/env node
// Boot a stock Android emulator AVD and install the brand Capacitor APK
// for app-level smoke testing without needing the AOSP system image.
//
// Brand-aware: APK path defaults to the brand's vendor staging
// (`<brand.vendorDir>/apps/<brand.appName>/<brand.appName>.apk`).
// Override with --apk. Package id comes from `brand.packageName`.
//
// This is the *short* iteration loop: validates the WebView, gateway
// service, and deep-link routing without paying for an AOSP rebuild.
// The privileged-system-app behaviour (HOME role, default-permissions,
// privapp whitelist) is NOT exercised here — for that, use Cuttlefish
// + e2e-validate against the brand's `<brand>_cf_x86_64_phone` build.
//
// Usage:
//   node scripts/distro-android/avd-test.mjs --avd <name>
//   node scripts/distro-android/avd-test.mjs --avd <name> --apk path/to/app.apk
//   node scripts/distro-android/avd-test.mjs --avd <name> --capture reports/avd
//
// Flags:
//   --brand-config <PATH> Brand config JSON (default brand.eliza.json).
//   --avd <name>          AVD name (must already be created with avdmanager).
//   --apk <path>          APK to install. Defaults to staged release APK.
//   --no-reuse            Don't reuse a running emulator with the same AVD.
//   --capture <dir>       Capture screenshots after install via capture-screens.
//   --boot-timeout-ms <n> Wait for sys.boot_completed (default 180000).
//   --serial <serial>     Skip emulator launch, use an already-running one.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";
import { resolveAdb } from "./capture-screens.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function defaultApkPath(brand) {
  return path.join(
    repoRoot,
    brand.vendorDir,
    "apps",
    brand.appName,
    `${brand.appName}.apk`,
  );
}

export function parseSubArgs(argv, brand) {
  const args = {
    avd: null,
    apk: defaultApkPath(brand),
    reuse: true,
    capture: null,
    bootTimeoutMs: 180_000,
    serial: null,
  };
  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--avd") {
      args.avd = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--apk") {
      args.apk = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--no-reuse") {
      args.reuse = false;
    } else if (arg === "--capture") {
      args.capture = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--boot-timeout-ms") {
      args.bootTimeoutMs = Number.parseInt(readFlagValue(arg, i), 10);
      i += 1;
    } else if (arg === "--serial") {
      args.serial = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/avd-test.mjs [--brand-config PATH] --avd <NAME> [--apk PATH] [--no-reuse] [--capture DIR] [--boot-timeout-ms N] [--serial S]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.avd && !args.serial) {
    throw new Error("--avd or --serial is required");
  }
  if (!fs.existsSync(args.apk)) {
    throw new Error(
      `APK not found: ${args.apk}. Run \`${brand.buildAndroidSystemCmd.join(" ")}\` first or pass --apk.`,
    );
  }
  return args;
}

function sdkRoots() {
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ].filter(Boolean);
}

function resolveEmulator() {
  for (const sdkRoot of sdkRoots()) {
    const candidate = path.join(sdkRoot, "emulator", "emulator");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find emulator. Install via Android Studio or sdkmanager 'emulator'.",
  );
}

function compareBuildToolVersions(a, b) {
  const aa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const bb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const delta = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function resolveApksigner() {
  for (const sdkRoot of sdkRoots()) {
    const buildTools = path.join(sdkRoot, "build-tools");
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs
      .readdirSync(buildTools)
      .sort(compareBuildToolVersions)
      .reverse();
    for (const version of versions) {
      const candidate = path.join(buildTools, version, "apksigner");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function isApkSigned(apksigner, apkPath) {
  if (!apksigner) return false;
  const result = spawnSync(apksigner, ["verify", apkPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function ensureDebugSignedApk(originalApk, brand) {
  const apksigner = resolveApksigner();
  if (!apksigner) {
    throw new Error(
      "apksigner not found in build-tools. Cannot debug-sign unsigned APK.",
    );
  }
  if (isApkSigned(apksigner, originalApk)) {
    return originalApk;
  }
  const debugKeystore = path.join(os.homedir(), ".android", "debug.keystore");
  if (!fs.existsSync(debugKeystore)) {
    throw new Error(
      `Debug keystore missing at ${debugKeystore}. Open Android Studio once, or run \`keytool -genkey -v -keystore ~/.android/debug.keystore -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'\`.`,
    );
  }
  const signedDir = path.join(repoRoot, `.${brand.brand}`, "avd-signed");
  fs.mkdirSync(signedDir, { recursive: true });
  const signedApk = path.join(
    signedDir,
    `${path.basename(originalApk, ".apk")}-debug-signed.apk`,
  );
  fs.copyFileSync(originalApk, signedApk);
  const result = spawnSync(
    apksigner,
    [
      "sign",
      "--ks",
      debugKeystore,
      "--ks-key-alias",
      "androiddebugkey",
      "--ks-pass",
      "pass:android",
      "--key-pass",
      "pass:android",
      signedApk,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`apksigner sign exited with code ${result.status}`);
  }
  console.log(`[avd-test] Debug-signed unsigned APK -> ${signedApk}`);
  return signedApk;
}

function adbArgs(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

function adbRun(adb, serial, args) {
  const result = spawnSync(adb, adbArgs(serial, args), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `adb ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function listRunningEmulators(adb) {
  const stdout = adbRun(adb, null, ["devices"]);
  return stdout
    .split(/\r?\n/)
    .filter((line) => /^emulator-\d+\s+device/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

function emulatorAvdName(adb, serial) {
  try {
    return adbRun(adb, serial, ["emu", "avd", "name"]).split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBoot(adb, serial, timeoutMs) {
  adbRun(adb, serial, ["wait-for-device"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const completed = adbRun(adb, serial, [
        "shell",
        "getprop sys.boot_completed",
      ]).trim();
      if (completed === "1") {
        adbRun(adb, serial, ["shell", "wm dismiss-keyguard"]);
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(2_000);
  }
  throw new Error(
    `Emulator did not report sys.boot_completed=1 within ${timeoutMs}ms.`,
  );
}

function startEmulator(emulatorBin, avdName) {
  // -no-snapshot-save keeps each run reproducible
  const child = spawn(
    emulatorBin,
    ["-avd", avdName, "-no-snapshot-save", "-no-boot-anim"],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  child.unref();
  console.log(
    `[avd-test] Launched emulator AVD=${avdName} (pid=${child.pid}).`,
  );
}

async function findEmulatorSerial(adb, avdName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const serial of listRunningEmulators(adb)) {
      const name = emulatorAvdName(adb, serial);
      if (name === avdName) return serial;
    }
    await sleep(2_000);
  }
  throw new Error(`Could not find a running emulator for AVD ${avdName}.`);
}

export async function avdTest(options, brand) {
  const adb = resolveAdb(null);
  let serial = options.serial;

  if (!serial) {
    if (options.reuse) {
      const running = listRunningEmulators(adb);
      for (const candidate of running) {
        if (emulatorAvdName(adb, candidate) === options.avd) {
          serial = candidate;
          console.log(
            `[avd-test] Reusing running emulator ${serial} for AVD ${options.avd}.`,
          );
          break;
        }
      }
    }
    if (!serial) {
      const emulatorBin = resolveEmulator();
      startEmulator(emulatorBin, options.avd);
      serial = await findEmulatorSerial(adb, options.avd, 60_000);
      console.log(`[avd-test] Detected serial ${serial}.`);
    }
  }

  await waitForBoot(adb, serial, options.bootTimeoutMs);

  // Soong resigns prebuilts with the platform key for AOSP, so the staged
  // APK is unsigned. AVD/emulator refuses unsigned APKs, so debug-sign on
  // the fly using ~/.android/debug.keystore.
  const installApk = ensureDebugSignedApk(options.apk, brand);

  // Re-install fresh so each run starts from a clean app state.
  console.log(`[avd-test] Installing ${installApk} on ${serial}…`);
  try {
    adbRun(adb, serial, ["uninstall", brand.packageName]);
  } catch {
    // Not previously installed — fine.
  }
  adbRun(adb, serial, ["install", "-r", "-g", "-t", installApk]);
  console.log(`[avd-test] Installed ${brand.packageName}.`);

  // Cold-launch via monkey to exercise the LAUNCHER intent filter.
  adbRun(adb, serial, [
    "shell",
    `monkey -p ${brand.packageName} -c android.intent.category.LAUNCHER 1`,
  ]);

  console.log(
    `[avd-test] App launched. Use 'adb -s ${serial} shell ...' or pass --capture to grab screenshots.`,
  );
  return { adb, serial };
}

async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining, brand);
  const result = await avdTest(args, brand);
  if (args.capture) {
    const { captureScreens, buildStepMap } = await import(
      "./capture-screens.mjs"
    );
    const stepMap = buildStepMap(brand);
    await captureScreens({
      outDir: args.capture,
      serial: result.serial,
      adb: result.adb,
      steps: ["launcher", "dialer", "sms", "assist"],
      label: "avd",
      noLaunch: false,
      stepMap,
    });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
