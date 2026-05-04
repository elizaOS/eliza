#!/usr/bin/env node
// Capture a sequenced set of PNG screenshots from a connected device or
// Cuttlefish instance. Drives `adb shell screencap -p` and pulls each PNG
// to a numbered file under <out-dir>/.
//
// Brand-aware: the LAUNCHER monkey step uses `brand.packageName` from the
// brand config (resolved via --brand-config / $DISTRO_ANDROID_BRAND_CONFIG).
//
// Usage:
//   node scripts/distro-android/capture-screens.mjs --out reports/aosp-boot
//   node scripts/distro-android/capture-screens.mjs --out reports/avd \
//        --steps home,dialer,assist,sms
//
// Flags:
//   --out <dir>          Output directory (created if missing).
//   --serial <serial>    adb device serial (defaults to ANDROID_SERIAL).
//   --adb <path>         Explicit adb binary (defaults to PATH / SDK lookup).
//   --steps <csv>        Comma-separated steps from the predefined map.
//                        Default: home,dialer,sms,assist,recents,launcher.
//   --label <text>       Free-form label appended to filenames.
//   --no-launch          Capture only the current screen, skip step driving.
//
// Each step launches the named brand surface via the role intent and waits
// briefly for the WebView to settle before grabbing the framebuffer.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";

/**
 * Step map factory — bound to a brand so the LAUNCHER step uses the
 * brand's package id. Kept as a function so tests / callers that want
 * to build the step map independently can pass a synthetic brand
 * object.
 */
export function buildStepMap(brand) {
  return {
    home: {
      label: "home",
      drive: (adb, serial) => shell(adb, serial, "input keyevent KEYCODE_HOME"),
      settleMs: 1500,
    },
    dialer: {
      label: "dialer",
      drive: (adb, serial) =>
        shell(adb, serial, "am start -a android.intent.action.DIAL"),
      settleMs: 2500,
    },
    sms: {
      label: "sms",
      drive: (adb, serial) =>
        shell(
          adb,
          serial,
          'am start -a android.intent.action.SENDTO -d "smsto:5551234567"',
        ),
      settleMs: 2500,
    },
    assist: {
      label: "assist",
      drive: (adb, serial) =>
        shell(adb, serial, "am start -a android.intent.action.ASSIST"),
      settleMs: 2500,
    },
    recents: {
      label: "recents",
      drive: (adb, serial) =>
        shell(adb, serial, "input keyevent KEYCODE_APP_SWITCH"),
      settleMs: 1500,
    },
    launcher: {
      label: "launcher",
      drive: (adb, serial) =>
        shell(
          adb,
          serial,
          `monkey -p ${brand.packageName} -c android.intent.category.LAUNCHER 1`,
        ),
      settleMs: 2500,
    },
  };
}

export function parseSubArgs(argv, stepMap) {
  const args = {
    outDir: null,
    serial: process.env.ANDROID_SERIAL || null,
    adb: process.env.ADB || null,
    steps: ["home", "dialer", "sms", "assist", "recents", "launcher"],
    label: null,
    noLaunch: false,
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
    if (arg === "--out") {
      args.outDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--serial" || arg === "-s") {
      args.serial = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--adb") {
      args.adb = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--steps") {
      args.steps = readFlagValue(arg, i)
        .split(",")
        .map((step) => step.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--label") {
      args.label = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--no-launch") {
      args.noLaunch = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/capture-screens.mjs --out <DIR> [--brand-config PATH] [--serial S] [--adb PATH] [--steps a,b,c] [--label TEXT] [--no-launch]",
      );
      console.log("Steps:", Object.keys(stepMap).join(", "));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.outDir) throw new Error("--out is required");
  for (const step of args.steps) {
    if (!stepMap[step]) {
      throw new Error(
        `Unknown step "${step}". Known: ${Object.keys(stepMap).join(", ")}`,
      );
    }
  }
  return args;
}

export function resolveAdb(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`adb not found: ${explicit}`);
    }
    return explicit;
  }
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ].filter(Boolean);
  for (const sdkRoot of sdkRoots) {
    const candidate = path.join(sdkRoot, "platform-tools", "adb");
    if (fs.existsSync(candidate)) return candidate;
  }
  const result = spawnSync("adb", ["version"], { stdio: "ignore" });
  if (!result.error) return "adb";
  throw new Error(
    "Could not find adb. Set --adb, ADB, ANDROID_HOME, or ANDROID_SDK_ROOT.",
  );
}

function adbArgs(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function shell(adb, serial, command) {
  return run(adb, adbArgs(serial, ["shell", command]));
}

function captureFramebuffer(adb, serial, targetPath) {
  // adb exec-out streams the PNG bytes back without an intermediate file
  // on the device. Falls back to push/pull if exec-out fails.
  const result = spawnSync(
    adb,
    adbArgs(serial, ["exec-out", "screencap", "-p"]),
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    const tmpDevicePath = `/sdcard/screencap-${Date.now()}.png`;
    shell(adb, serial, `screencap -p ${tmpDevicePath}`);
    run(adb, adbArgs(serial, ["pull", tmpDevicePath, targetPath]));
    shell(adb, serial, `rm -f ${tmpDevicePath}`);
    return;
  }
  fs.writeFileSync(targetPath, result.stdout);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampSlug() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "-",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
}

export async function captureScreens({
  outDir,
  serial,
  adb,
  steps,
  label,
  noLaunch,
  stepMap,
}) {
  fs.mkdirSync(outDir, { recursive: true });
  const slug = timestampSlug();

  if (noLaunch) {
    const target = path.join(
      outDir,
      `${slug}__current${label ? `__${label}` : ""}.png`,
    );
    captureFramebuffer(adb, serial, target);
    console.log(`[capture] ${target}`);
    return [target];
  }

  const captured = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = stepMap[steps[i]];
    try {
      step.drive(adb, serial);
    } catch (error) {
      console.warn(
        `[capture] step ${step.label} drive failed (continuing): ${error.message}`,
      );
    }
    await sleep(step.settleMs);
    const target = path.join(
      outDir,
      `${slug}__${String(i).padStart(2, "0")}_${step.label}${label ? `__${label}` : ""}.png`,
    );
    captureFramebuffer(adb, serial, target);
    console.log(`[capture] ${target}`);
    captured.push(target);
  }
  return captured;
}

async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const stepMap = buildStepMap(brand);
  const args = parseSubArgs(remaining, stepMap);
  const adb = resolveAdb(args.adb);
  await captureScreens({ ...args, adb, stepMap });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
