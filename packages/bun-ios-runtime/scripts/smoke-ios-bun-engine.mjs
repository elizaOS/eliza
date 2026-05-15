#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { argValue, fail, run } from "./script-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const frameworkName = "ElizaBunEngine";
const verifyScript = path.join(__dirname, "verify-ios-app-store.mjs");
const defaultXcframework = path.join(
  packageRoot,
  "artifacts",
  `${frameworkName}.xcframework`,
);

const target = argValue(
  "--target",
  process.env.ELIZA_IOS_SMOKE_TARGET || "simulator",
);
if (!["simulator", "device", "all"].includes(target)) {
  fail(`invalid --target=${target}; expected simulator, device, or all`);
}
const preflightOnly = process.argv.includes("--preflight-only");
const xcframework = path.resolve(
  argValue(
    "--xcframework",
    process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK || defaultXcframework,
  ),
);
const rawAppPath = argValue("--app", process.env.ELIZA_IOS_APP_PATH || "");
const appPath = rawAppPath ? path.resolve(rawAppPath) : "";

function runVerifier(args) {
  const result = run(process.execPath, [verifyScript, ...args], {
    cwd: repoRoot,
    env: process.env,
    check: false,
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function validateAppPrerequisites(resolvedAppPath) {
  if (!resolvedAppPath.endsWith(".app")) {
    fail(`--app must point to an .app bundle: ${resolvedAppPath}`);
  }
  if (!fs.existsSync(resolvedAppPath)) {
    fail(`app bundle does not exist: ${resolvedAppPath}`);
  }

  runVerifier([`--app=${resolvedAppPath}`]);

  const bundlePath = path.join(
    resolvedAppPath,
    "public",
    "agent",
    "agent-bundle.js",
  );
  if (!fs.existsSync(bundlePath)) {
    fail(`missing staged agent bundle at ${bundlePath}`);
  }

  console.log(`[bun-ios-runtime] Smoke prerequisites OK for ${resolvedAppPath}`);
  console.log(
    [
      "[bun-ios-runtime] To execute the route smoke, install and launch this app in Simulator, then run:",
      "  bun run --cwd packages/app test:sim:local-chat:ios:full-bun",
      "The in-app smoke exercises ElizaBunRuntime.start({ engine: 'bun' }), status, /api/health, local-inference IPC, send_message, and SSE.",
    ].join("\n"),
  );
}

function validateXcframeworkPreflight() {
  if (!fs.existsSync(xcframework)) {
    fail(
      [
        `missing ${frameworkName}.xcframework at ${xcframework}`,
        "Build the Bun fork first, or set ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK.",
      ].join("\n"),
    );
  }
  runVerifier([`--xcframework=${xcframework}`, `--target=${target}`]);
  console.log(
    `[bun-ios-runtime] ${target} full-Bun engine preflight OK: ${xcframework}`,
  );
  console.log(
    [
      "[bun-ios-runtime] This preflight validates ABI symbols, no-JIT metadata, forbidden imports/strings, and nested executable payloads.",
      "Pass --app=/absolute/path/App.app, or set ELIZA_IOS_APP_PATH, after building the iOS app to validate app-level embedding and network policy.",
    ].join("\n"),
  );
}

if (appPath) {
  validateAppPrerequisites(appPath);
} else if (preflightOnly) {
  validateXcframeworkPreflight();
} else {
  fail(
    [
      "pass --app=/absolute/path/App.app or set ELIZA_IOS_APP_PATH for app smoke prerequisites.",
      "For engine-only preflight, pass --preflight-only.",
    ].join("\n"),
  );
}
