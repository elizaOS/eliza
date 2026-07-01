#!/usr/bin/env node
// Run a bash script, gating on macOS. Used for iOS-only native dependency
// builds so Linux/Windows workspace-wide Turbo runs exit cleanly without
// depending on bash being installed.
//
// Usage: node packages/scripts/run-bash-darwin-only.mjs <script.sh> [args...]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const [scriptArg, ...rest] = process.argv.slice(2);

if (!scriptArg) {
  console.error(
    "Usage: node packages/scripts/run-bash-darwin-only.mjs <script.sh> [args...]",
  );
  process.exit(2);
}

const scriptPath = path.isAbsolute(scriptArg)
  ? scriptArg
  : path.join(repoRoot, scriptArg);

if (process.platform !== "darwin") {
  console.error(
    `[run-bash-darwin-only] Skipping ${path.relative(repoRoot, scriptPath)} — ` +
      `this build path is macOS-only (iOS SDK/Xcode toolchain required). ` +
      `Current platform: ${process.platform}. Use macOS to run this step.`,
  );
  process.exit(0);
}

if (!existsSync(scriptPath)) {
  console.error(`[run-bash-darwin-only] Script not found: ${scriptPath}`);
  process.exit(1);
}

const result = spawnSync("bash", [scriptPath, ...rest], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
