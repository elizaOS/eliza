#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const args = new Set(process.argv.slice(2));

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: options.cwd ?? appRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.stdio ?? "pipe",
  });
}

function fail(message, detail = "") {
  console.error(`ios-sideload-helper: ${message}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

const preflight = run(
  "node",
  ["scripts/mobile-release-preflight.mjs", "--platform=ios", "--sideload"],
  { stdio: "inherit" },
);
if (preflight.status !== 0) {
  fail("preflight failed");
}

if (args.has("--build-device")) {
  const build = run("bun", ["run", "build:ios:local:device"], {
    stdio: "inherit",
  });
  if (build.status !== 0) fail("device build failed");
}

if (args.has("--build-sim")) {
  const build = run("bun", ["run", "build:ios:local:sim"], {
    stdio: "inherit",
  });
  if (build.status !== 0) fail("simulator build failed");
}

if (!args.has("--no-open")) {
  const opened = run("open", ["ios/App/App.xcworkspace"], {
    stdio: "inherit",
  });
  if (opened.status !== 0) {
    fail("could not open Xcode workspace");
  }
}

console.log(`
iOS developer install next steps:
- Select your Apple development team in Xcode if signing is not automatic.
- Select a paired, unlocked device with Developer Mode enabled.
- Press Run in Xcode to install.
- On first install, trust the developer certificate on the device if iOS asks.
- Free development profiles can expire after roughly 7 days; paid development
  profiles can expire after roughly 1 year.
- Public iOS distribution still must use TestFlight or the App Store.
`);
