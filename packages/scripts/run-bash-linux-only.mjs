#!/usr/bin/env node
// Run a bash script, gating on Linux. Used for inherently Linux-only build
// paths (riscv64 cross-compile via Zig/cmake/qemu, etc.) so that on
// Windows/macOS the command exits cleanly with a clear message rather than
// producing confusing missing-tool errors.
//
// Usage: node packages/scripts/run-bash-linux-only.mjs <script.sh> [args...]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const [scriptArg, ...rest] = process.argv.slice(2);

if (!scriptArg) {
  console.error(
    "Usage: node packages/scripts/run-bash-linux-only.mjs <script.sh> [args...]",
  );
  process.exit(2);
}

const scriptPath = path.isAbsolute(scriptArg)
  ? scriptArg
  : path.join(repoRoot, scriptArg);

if (process.platform !== "linux") {
  console.error(
    `[run-bash-linux-only] Skipping ${path.relative(repoRoot, scriptPath)} — ` +
      `this build path is Linux-only (cross-compile toolchain expects ` +
      `bash/cmake/zig/file/qemu-riscv64-static). Current platform: ` +
      `${process.platform}. Use Linux or WSL to run this step.`,
  );
  process.exit(0);
}

if (!existsSync(scriptPath)) {
  console.error(`[run-bash-linux-only] Script not found: ${scriptPath}`);
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
