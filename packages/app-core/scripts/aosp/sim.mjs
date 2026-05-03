#!/usr/bin/env node
// One-shot Cuttlefish simulator runner.
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
// Reads `productLunch` + `cuttlefishDeviceDir` from `app.config.ts >
// aosp:`. CLI overrides win for one-off runs against a different
// product.
//
// Usage:
//   node eliza/packages/app-core/scripts/aosp/sim.mjs
//   node eliza/packages/app-core/scripts/aosp/sim.mjs --aosp-root ~/aosp --out reports/aosp-sim
//   node eliza/packages/app-core/scripts/aosp/sim.mjs --no-launch       # validate against an already-running cvd
//   node eliza/packages/app-core/scripts/aosp/sim.mjs --stop-after      # tear down cvd after validation
//   node eliza/packages/app-core/scripts/aosp/sim.mjs --wait-for-build  # poll until system.img exists
//
// Flags:
//   --aosp-root <DIR>      AOSP checkout root. Default $HOME/aosp.
//   --lunch <STR>          Full lunch target (overrides aosp.productLunch).
//   --device-dir <STR>     Cuttlefish device dir under out/target/product/.
//                          Default = aosp.cuttlefishDeviceDir or vsoc_x86_64_only.
//   --out <DIR>            Screenshot + report output. Default reports/aosp-sim.
//   --no-launch            Don't start cvd; assume one is already running.
//   --stop-after           Stop cvd at the end (clean tear-down).
//   --wait-for-build       Poll until system.img appears (build still running).
//   --boot-timeout-ms <N>  Wait for sys.boot_completed (default 300000).
//   --app-config <PATH>    Override the host app.config.ts path.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

const DEFAULT_AOSP_ROOT = path.join(os.homedir(), "aosp");
const DEFAULT_DEVICE_DIR = "vsoc_x86_64_only";

function parseArgs(argv) {
  const args = {
    aospRoot: DEFAULT_AOSP_ROOT,
    lunch: null,
    deviceDir: null,
    outDir: path.join(repoRoot, "reports", "aosp-sim"),
    noLaunch: false,
    stopAfter: false,
    waitForBuild: false,
    bootTimeoutMs: 300_000,
    appConfigPath: null,
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
    } else if (arg === "--lunch") {
      args.lunch = readFlagValue(arg, i);
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
    } else if (arg === "--app-config") {
      args.appConfigPath = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/sim.mjs [--aosp-root DIR] [--lunch STR] [--device-dir STR] [--out DIR] [--no-launch] [--stop-after] [--wait-for-build] [--app-config PATH]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // Variant defaults: --lunch wins, then app.config.ts > aosp.productLunch.
  // device-dir same idea, then DEFAULT_DEVICE_DIR.
  if (!args.lunch || !args.deviceDir) {
    const cfgPath = resolveAppConfigPath({
      repoRoot,
      flagValue: args.appConfigPath,
    });
    const variant = fs.existsSync(cfgPath)
      ? loadAospVariantConfig({ appConfigPath: cfgPath })
      : null;
    if (!args.lunch) {
      if (!variant?.productLunch) {
        throw new Error(
          "[sim] No lunch target. Pass --lunch <STR> or set aosp.productLunch in app.config.ts.",
        );
      }
      args.lunch = variant.productLunch;
    }
    if (!args.deviceDir) {
      args.deviceDir = variant?.cuttlefishDeviceDir ?? DEFAULT_DEVICE_DIR;
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
  return args.lunch;
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

async function runE2eValidate(args) {
  // Spawn the existing e2e script — keeps the boot-validate + capture
  // logic in one place rather than duplicating it here.
  const child = spawn(
    "node",
    [
      path.join(here, "e2e-validate.mjs"),
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
  const args = parseArgs(argv);
  if (!args.noLaunch) {
    await waitForSystemImage(args);
    startCuttlefish(args);
  }
  try {
    await runE2eValidate(args);
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

export { parseArgs };
