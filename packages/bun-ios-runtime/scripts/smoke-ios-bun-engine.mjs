#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { argValue, fail, run } from "./script-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

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
if (!fs.existsSync(bundlePath)) {
  fail(`missing staged agent bundle at ${bundlePath}`);
}
if (!fs.existsSync(frameworkBinary)) {
  fail(`missing full Bun engine framework at ${frameworkBinary}`);
}

const nm = run("nm", ["-gU", frameworkBinary], {
  check: false,
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const symbols = nm.stdout + nm.stderr;
for (const symbol of [
  "_eliza_bun_engine_abi_version",
  "_eliza_bun_engine_set_host_callback",
  "_eliza_bun_engine_start",
  "_eliza_bun_engine_stop",
  "_eliza_bun_engine_call",
  "_eliza_bun_engine_free",
]) {
  if (!symbols.includes(symbol)) {
    fail(`framework is missing required symbol ${symbol}`);
  }
}

console.log(`[bun-ios-runtime] Smoke prerequisites OK for ${appPath}`);
console.log(
  "[bun-ios-runtime] Runtime call smoke requires the app to expose the full-engine ABI through Capacitor start({ engine: 'bun' }).",
);
