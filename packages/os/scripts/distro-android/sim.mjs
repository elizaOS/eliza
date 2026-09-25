#!/usr/bin/env node
// Launch and qualify the selected Cuttlefish product using the shared AOSP launcher.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { loadBrandFromArgv } from "./brand-config.mjs";
import {
  aospBuildEnvironment,
  cuttlefishLaunchCommand,
} from "./build-aosp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export class SimulatorError extends Error {
  code = "ELIZAOS_SIMULATOR_ERROR";
  constructor(message, options) {
    super(message, options);
    this.name = "SimulatorError";
  }
}

const DEFAULT_AOSP_ROOT = path.join(os.homedir(), "aosp");
const DEFAULT_VARIANT = "trunk_staging-userdebug";
const DEFAULT_DEVICE_DIR = "vsoc_x86_64_only";

// The Cuttlefish product output lives at out/target/product/<deviceDir>, where
// deviceDir is the `vsoc_*` segment of the brand's AOSP device tree path (e.g.
// "device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk" -> "vsoc_riscv64").
// Deriving it from the brand keeps arm64/riscv64 from falling back to the
// x86_64 default and pointing at the wrong (or missing) system.img.
function deriveDeviceDir(brand) {
  for (const treePath of brand.aospDeviceTreePaths ?? []) {
    const segment = treePath.split("/").find((s) => s.startsWith("vsoc_"));
    if (segment) return segment;
  }
  return DEFAULT_DEVICE_DIR;
}

export function parseSubArgs(argv, brand) {
  const args = {
    aospRoot: DEFAULT_AOSP_ROOT,
    product: brand.productName,
    variant: DEFAULT_VARIANT,
    deviceDir: deriveDeviceDir(brand),
    outDir: testOutputPath("os-aosp-sim"),
    noLaunch: false,
    stopAfter: false,
    waitForBuild: false,
    bootTimeoutMs: 300_000,
  };
  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new SimulatorError(`${flag} requires a value`);
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
      args.bootTimeoutMs = Number(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/sim.mjs [--brand-config PATH] [--aosp-root DIR] [--out DIR] [--no-launch] [--stop-after] [--wait-for-build]",
      );
      process.exit(0);
    } else {
      throw new SimulatorError(`Unknown argument: ${arg}`);
    }
  }
  for (const [name, value] of Object.entries({
    product: args.product,
    variant: args.variant,
    deviceDir: args.deviceDir,
  })) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) ||
      value === "." ||
      value === ".."
    ) {
      throw new SimulatorError(`${name} must be a literal AOSP name`);
    }
  }
  if (!Number.isSafeInteger(args.bootTimeoutMs) || args.bootTimeoutMs <= 0) {
    throw new SimulatorError("--boot-timeout-ms must be a positive integer");
  }
  return args;
}

export function systemImgPath(args, env = process.env) {
  return path.join(
    aospBuildEnvironment(args.aospRoot, env).OUT_DIR,
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
    throw new SimulatorError(
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

function runShell(aospRoot, command, env) {
  const result = spawnSync("bash", ["-c", command], {
    cwd: aospRoot,
    env: { ...env, OUT_DIR: aospBuildEnvironment(aospRoot, env).OUT_DIR },
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new SimulatorError(
      `Cuttlefish command failed (${result.signal ?? result.status ?? result.error?.message})`,
      { cause: result.error },
    );
  }
}

export function startCuttlefish(args, brand, env = process.env) {
  console.log(`[sim] Starting ${lunchTarget(args)}`);
  runShell(
    args.aospRoot,
    cuttlefishLaunchCommand(
      {
        ...brand,
        productName: args.product,
        lunchTarget: lunchTarget(args),
      },
      env,
    ),
    env,
  );
}

export function stopCuttlefish(args, env = process.env) {
  runShell(
    args.aospRoot,
    [
      "source build/envsetup.sh",
      `lunch ${lunchTarget(args)}`,
      "if command -v cvd >/dev/null 2>&1; then cvd stop; else stop_cvd; fi",
    ].join(" && "),
    env,
  );
}

async function runE2eValidate(args, brand) {
  // Spawn the existing e2e script — keeps the boot-validate + capture
  // logic in one place rather than duplicating it here.
  const child = spawn(
    process.execPath,
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
    child.once("error", (cause) =>
      reject(new SimulatorError("Unable to start e2e validation", { cause })),
    );
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new SimulatorError(`e2e-validate failed (${signal ?? code})`));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining, brand);
  if (!args.noLaunch) {
    await waitForSystemImage(args);
    startCuttlefish(args, brand);
  }
  const errors = [];
  try {
    await runE2eValidate(args, brand);
  } catch (error) {
    errors.push(error);
  }
  if (args.stopAfter) {
    try {
      stopCuttlefish(args);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new SimulatorError("Simulator validation or cleanup failed", {
      cause: new AggregateError(errors),
    });
  console.log(`[sim] Done. Reports: ${args.outDir}`);
}

if (import.meta.main) {
  await main();
}
