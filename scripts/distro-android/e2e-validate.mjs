#!/usr/bin/env node
// End-to-end validation against a running brand-AOSP device or AVD. Wraps
// boot-validate (role/permission/appop assertions) and capture-screens
// (visual proof of HOME / Dialer / SMS / Assistant ownership) into a
// single command that emits a JSON report + a PNG gallery.
//
// Brand-aware: derives all brand-coupled identifiers from --brand-config.
//
// Usage:
//   node scripts/distro-android/e2e-validate.mjs --out reports/e2e-cuttlefish
//   node scripts/distro-android/e2e-validate.mjs --out reports/e2e-avd \
//        --skip-boot-validate            # skip system-image checks
//
// Flags:
//   --brand-config <PATH>   Brand config JSON (default brand.eliza.json).
//   --out <dir>             Output directory for screenshots + report.json.
//   --serial <serial>       adb device serial.
//   --adb <path>            Explicit adb binary.
//   --timeout-ms <ms>       Boot wait timeout (default 180000).
//   --skip-boot-validate    Skip role/permission/appop assertions.
//                           Use for AVD app-only runs where the device
//                           was never imaged with vendor/<brand>.
//   --steps <csv>           Override the default screenshot step list.
//   --label <text>          Free-form label appended to PNG names.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateBootedDevice } from "./boot-validate.mjs";
import { loadBrandFromArgv } from "./brand-config.mjs";
import {
  buildStepMap,
  captureScreens,
  resolveAdb,
} from "./capture-screens.mjs";

export function parseSubArgs(argv) {
  const args = {
    outDir: null,
    serial: process.env.ANDROID_SERIAL || null,
    adb: process.env.ADB || null,
    timeoutMs: 180_000,
    skipBootValidate: false,
    steps: ["home", "dialer", "sms", "assist", "recents", "launcher"],
    label: null,
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
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(readFlagValue(arg, i), 10);
      i += 1;
    } else if (arg === "--skip-boot-validate") {
      args.skipBootValidate = true;
    } else if (arg === "--steps") {
      args.steps = readFlagValue(arg, i)
        .split(",")
        .map((step) => step.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--label") {
      args.label = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/e2e-validate.mjs --out <DIR> [--brand-config PATH] [--serial S] [--adb P] [--timeout-ms N] [--skip-boot-validate] [--steps a,b,c] [--label TEXT]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.outDir) throw new Error("--out is required");
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining);
  const adb = resolveAdb(args.adb);
  const stepMap = buildStepMap(brand);
  fs.mkdirSync(args.outDir, { recursive: true });

  const report = {
    brand: brand.brand,
    distroName: brand.distroName,
    startedAt: new Date().toISOString(),
    skipBootValidate: args.skipBootValidate,
    serial: args.serial,
    adb,
    bootValidate: null,
    screenshots: [],
    errors: [],
  };

  if (!args.skipBootValidate) {
    try {
      report.bootValidate = await validateBootedDevice(
        {
          adb,
          serial: args.serial,
          timeoutMs: args.timeoutMs,
          skipLogcat: false,
        },
        brand,
      );
      console.log(
        "[e2e] Boot validation passed (HOME/Dialer/SMS/Assistant roles + perms).",
      );
    } catch (error) {
      report.errors.push({ phase: "boot-validate", message: error.message });
      console.error(`[e2e] Boot validation FAILED: ${error.message}`);
    }
  } else {
    console.log("[e2e] Skipping boot validation (--skip-boot-validate).");
  }

  try {
    report.screenshots = await captureScreens({
      outDir: args.outDir,
      serial: args.serial,
      adb,
      steps: args.steps,
      label: args.label,
      noLaunch: false,
      stepMap,
    });
  } catch (error) {
    report.errors.push({ phase: "capture-screens", message: error.message });
    console.error(`[e2e] Screenshot capture FAILED: ${error.message}`);
  }

  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(args.outDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[e2e] Report: ${reportPath}`);

  if (report.errors.length > 0) {
    console.error(`[e2e] ${report.errors.length} error(s); see report.json`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
