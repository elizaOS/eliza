#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { argValue, fail } from "./script-utils.mjs";
import {
  parseRequiredSlices,
  validateAppNetworkPolicy,
  validateFramework,
  validateUnsafeRuntimeBinary,
  validateXcframework,
} from "./verify-ios-app-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const defaultXcframework = path.join(
  packageRoot,
  "artifacts",
  "ElizaBunEngine.xcframework",
);

const appPath = path.resolve(
  argValue("--app", process.env.ELIZA_IOS_APP_PATH || ""),
);
if (!appPath || appPath === process.cwd() || !fs.existsSync(appPath)) {
  fail("pass --app=/absolute/path/App.app or set ELIZA_IOS_APP_PATH");
}

const bundlePath = path.join(appPath, "public", "agent", "agent-bundle.js");
const frameworkBinary = path.join(
  appPath,
  "Frameworks",
  "ElizaBunEngine.framework",
  "ElizaBunEngine",
);
const frameworkDir = path.dirname(frameworkBinary);
const runtimePluginBinary = path.join(
  appPath,
  "Frameworks",
  "ElizaosCapacitorBunRuntime.framework",
  "ElizaosCapacitorBunRuntime",
);
const target = argValue(
  "--target",
  process.env.ELIZA_IOS_VERIFY_TARGET || "simulator",
);
const requiredSlices = parseRequiredSlices(
  argValue(
    "--require-slices",
    process.env.ELIZA_IOS_REQUIRE_XCFRAMEWORK_SLICES || "",
  ),
);
const xcframework = argValue(
  "--xcframework",
  process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK ||
    (fs.existsSync(defaultXcframework) ? defaultXcframework : ""),
);

if (xcframework) {
  validateXcframework(path.resolve(xcframework), { target, requiredSlices });
}
if (!fs.existsSync(bundlePath)) {
  fail(`missing staged agent bundle at ${bundlePath}`);
}
if (!fs.existsSync(frameworkBinary)) {
  fail(`missing full Bun engine framework at ${frameworkBinary}`);
}
if (!fs.existsSync(runtimePluginBinary)) {
  fail(`missing Capacitor runtime plugin framework at ${runtimePluginBinary}`);
}

validateFramework(frameworkDir);
validateUnsafeRuntimeBinary(runtimePluginBinary);
validateAppNetworkPolicy(appPath);

console.log(`[bun-ios-runtime] Smoke prerequisites OK for ${appPath}`);
console.log(
  "[bun-ios-runtime] Runtime call smoke requires the app to expose the full-engine ABI through Capacitor start({ engine: 'bun' }).",
);
