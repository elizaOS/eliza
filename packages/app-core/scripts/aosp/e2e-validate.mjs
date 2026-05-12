#!/usr/bin/env node
// End-to-end validation against a running AOSP system-app device or
// AVD. Wraps boot-validate (role/permission/appop assertions) and
// capture-screens (visual proof of HOME / Dialer / SMS / Assistant
// ownership) into a single command that emits a JSON report + a PNG
// gallery.
//
// Usage:
//   node eliza/packages/app-core/scripts/aosp/e2e-validate.mjs --out reports/e2e-cuttlefish
//   node eliza/packages/app-core/scripts/aosp/e2e-validate.mjs --out reports/e2e-avd \
//        --skip-boot-validate            # skip system-image checks
//
// Flags:
//   --out <dir>             Output directory for screenshots + report.json.
//   --serial <serial>       adb device serial.
//   --adb <path>            Explicit adb binary.
//   --timeout-ms <ms>       Boot wait timeout (default 180000).
//   --skip-boot-validate    Skip role/permission/appop assertions.
//                           Use for AVD app-only runs where the device
//                           was never imaged with the variant vendor.
//   --steps <csv>           Override the default screenshot step list.
//   --label <text>          Free-form label appended to PNG names.
//   --app-config <PATH>     Override the host app.config.ts path.
//   --smoke-cuttlefish-only Run only the cuttlefish-style health + chat
//                           smoke (smoke-cuttlefish.mjs). Skips boot
//                           validation and screenshot capture. Useful
//                           in CI where the only ABI to exercise is
//                           x86_64 against a running cvd.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import { validateBootedDevice } from "./boot-validate.mjs";
import { captureScreens, resolveAdb } from "./capture-screens.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

function parseArgs(argv) {
  const args = {
    outDir: null,
    serial: process.env.ANDROID_SERIAL || null,
    adb: process.env.ADB || null,
    timeoutMs: 180_000,
    skipBootValidate: false,
    steps: ["home", "dialer", "sms", "assist", "recents", "launcher"],
    label: null,
    appConfigPath: null,
    smokeCuttlefishOnly: false,
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
    } else if (arg === "--app-config") {
      args.appConfigPath = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--smoke-cuttlefish-only") {
      args.smokeCuttlefishOnly = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/e2e-validate.mjs --out <DIR> [--serial S] [--adb P] [--timeout-ms N] [--skip-boot-validate] [--steps a,b,c] [--label TEXT] [--app-config PATH] [--smoke-cuttlefish-only]",
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
  const args = parseArgs(argv);
  const adb = resolveAdb(args.adb);
  fs.mkdirSync(args.outDir, { recursive: true });

  // Resolve variant once and reuse for both boot-validate and the
  // launcher screenshot step. AVD-only runs (where vendor/<dir> isn't
  // imaged) still need the variant for the launcher package name.
  const cfgPath = resolveAppConfigPath({
    repoRoot,
    flagValue: args.appConfigPath,
  });
  const variant = fs.existsSync(cfgPath)
    ? loadAospVariantConfig({ appConfigPath: cfgPath })
    : null;

  // CI-only fast path: run the cuttlefish health + chat smoke and bail.
  // Useful when the only goal is to confirm /api/health + a chat
  // round-trip on x86_64 cvd; the boot-validate / screenshot path
  // requires a built AOSP variant image which CI typically doesn't have.
  if (args.smokeCuttlefishOnly) {
    if (!variant) {
      throw new Error(
        "[e2e] --smoke-cuttlefish-only requires app.config.ts > aosp.packageName to resolve the package id.",
      );
    }
    const { runSmoke, formatResult, summarize } = await import(
      "./smoke-cuttlefish.mjs"
    );
    const results = await runSmoke({
      packageName: variant.packageName,
      appName: variant.appName,
    });
    const smokeReport = {
      startedAt: new Date().toISOString(),
      mode: "smoke-cuttlefish-only",
      packageName: variant.packageName,
      results,
    };
    fs.writeFileSync(
      path.join(args.outDir, "report.json"),
      JSON.stringify(smokeReport, null, 2),
    );
    for (const r of results) {
      console.log(formatResult(r.step, r.label, r.ok, r.detail));
    }
    const { line, allPassed } = summarize(results);
    console.log(line);
    process.exit(allPassed ? 0 : 1);
  }

  const report = {
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
      report.bootValidate = await validateBootedDevice({
        adb,
        serial: args.serial,
        timeoutMs: args.timeoutMs,
        skipLogcat: false,
        variant,
        appConfigPath: args.appConfigPath,
      });
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
      packageName: variant?.packageName,
      appConfigPath: args.appConfigPath,
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

export { parseArgs };
