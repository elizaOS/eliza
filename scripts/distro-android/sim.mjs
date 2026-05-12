#!/usr/bin/env node
// One-shot Cuttlefish simulator runner.
//
// Brand-aware: product name + lunch target come from the brand config
// (--brand-config / $DISTRO_ANDROID_BRAND_CONFIG). Override with
// --product / --variant if needed.
//
// Sequences the post-build steps so that once `m` finishes, a single
// command brings up the simulator and validates it end-to-end:
//
//   1. Confirm system.img exists at the expected target-product path.
//   2. Stop any prior cvd instance (so we always boot from a clean state).
//   3. Source build/envsetup.sh + lunch (so $ANDROID_HOST_OUT is set).
//   4. cvd start --daemon to launch Cuttlefish.
//   5. Wait for adb to see the device (sys.boot_completed=1).
//   6. Run boot-validate against the booted device.
//   7. Capture screenshots of HOME / Dialer / SMS / Assistant / launcher.
//   8. Optionally stop cvd at the end (--stop-after).
//
// Usage:
//   node scripts/distro-android/sim.mjs
//   node scripts/distro-android/sim.mjs --aosp-root ~/aosp --out reports/aosp-sim
//   node scripts/distro-android/sim.mjs --no-launch       # validate against an already-running cvd
//   node scripts/distro-android/sim.mjs --stop-after      # tear down cvd after validation
//   node scripts/distro-android/sim.mjs --wait-for-build  # poll until system.img exists
//
// Flags:
//   --brand-config <PATH>  Brand config JSON (default brand.eliza.json).
//   --aosp-root <DIR>      AOSP checkout root. Default $HOME/aosp.
//   --product <NAME>       Target product. Default brand.productName.
//   --variant <STR>        Target variant. Default trunk_staging-userdebug.
//   --out <DIR>            Screenshot + report output. Default reports/aosp-sim.
//   --no-launch            Don't start cvd; assume one is already running.
//   --stop-after           Stop cvd at the end (clean tear-down).
//   --wait-for-build       Poll until system.img appears (build still running).
//   --boot-timeout-ms <N>  Wait for sys.boot_completed (default 300000).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const DEFAULT_AOSP_ROOT = path.join(os.homedir(), "aosp");
const DEFAULT_VARIANT = "trunk_staging-userdebug";
const DEFAULT_DEVICE_DIR = "vsoc_x86_64_only";

export function parseSubArgs(argv, brand) {
  const args = {
    aospRoot: DEFAULT_AOSP_ROOT,
    product: brand.productName,
    variant: DEFAULT_VARIANT,
    deviceDir: DEFAULT_DEVICE_DIR,
    outDir: path.join(repoRoot, "reports", "aosp-sim"),
    noLaunch: false,
    stopAfter: false,
    waitForBuild: false,
    bootTimeoutMs: 300_000,
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
    if (arg === "--aosp-root") {
      args.aospRoot = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--product") {
      args.product = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--variant") {
      args.variant = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--device-dir") {
      args.deviceDir = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--out") {
      args.outDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--no-launch") {
      args.noLaunch = true;
    } else if (arg === "--stop-after") {
      args.stopAfter = true;
    } else if (arg === "--wait-for-build") {
      args.waitForBuild = true;
    } else if (arg === "--boot-timeout-ms") {
      args.bootTimeoutMs = Number.parseInt(readFlagValue(arg, i), 10);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/sim.mjs [--brand-config PATH] [--aosp-root DIR] [--out DIR] [--no-launch] [--stop-after] [--wait-for-build]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function systemImgPath(args) {
  return path.join(
    args.aospRoot,
    "out",
    "target",
    "product",
    args.deviceDir,
    "system.img",
  );
}

function lunchTarget(args) {
  return `${args.product}-${args.variant}`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSystemImage(args) {
  const target = systemImgPath(args);
  if (fs.existsSync(target)) {
    console.log(`[sim] Found ${target}.`);
    return target;
  }
  if (!args.waitForBuild) {
    throw new Error(
      `system.img not found at ${target}. Run \`m -j4\` first or pass --wait-for-build.`,
    );
  }
  console.log(
    `[sim] Waiting for ${target} (poll every 30s; AOSP build typically takes 1–4h)...`,
  );
  for (;;) {
    if (fs.existsSync(target)) {
      console.log(`[sim] ${target} appeared. Continuing.`);
      return target;
    }
    await sleep(30_000);
  }
}

function bashLogin(aospRoot, command) {
  const result = spawnSync(
    "bash",
    ["-lc", `source build/envsetup.sh >/dev/null && ${command}`],
    { cwd: aospRoot, stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(`bash failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`bash command exited with code ${result.status}`);
  }
}

function bashLoginCapture(aospRoot, command) {
  const result = spawnSync(
    "bash",
    ["-lc", `source build/envsetup.sh >/dev/null && ${command}`],
    { cwd: aospRoot, encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(`bash failed: ${result.error.message}`);
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function startCuttlefish(args) {
  console.log(`[sim] lunch ${lunchTarget(args)}`);
  // Stop first to avoid "already running" guard rails. Best-effort —
  // ignore failures since "no instance running" is also exit-non-zero.
  bashLoginCapture(
    args.aospRoot,
    `lunch ${lunchTarget(args)} >/dev/null && (cvd stop --clean 2>/dev/null || stop_cvd 2>/dev/null || true)`,
  );
  console.log(`[sim] cvd start --daemon`);
  bashLogin(
    args.aospRoot,
    `lunch ${lunchTarget(args)} >/dev/null && (cvd start --daemon || launch_cvd --daemon)`,
  );
}

function stopCuttlefish(args) {
  console.log(`[sim] cvd stop --clean`);
  bashLoginCapture(
    args.aospRoot,
    `lunch ${lunchTarget(args)} >/dev/null 2>&1 && (cvd stop --clean 2>/dev/null || stop_cvd 2>/dev/null || true)`,
  );
}

async function runE2eValidate(args, brand) {
  // Spawn the existing e2e script — keeps the boot-validate + capture
  // logic in one place rather than duplicating it here.
  const child = spawn(
    "node",
    [
      path.join(here, "e2e-validate.mjs"),
      "--brand-config",
      brand.brandConfigPath,
      "--out",
      args.outDir,
      "--timeout-ms",
      String(args.bootTimeoutMs),
    ],
    { stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`e2e-validate exited with code ${code}`));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining, brand);
  if (!args.noLaunch) {
    await waitForSystemImage(args);
    startCuttlefish(args);
  }
  try {
    await runE2eValidate(args, brand);
  } finally {
    if (args.stopAfter) {
      stopCuttlefish(args);
    }
  }
  console.log(`[sim] Done. Reports: ${args.outDir}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
