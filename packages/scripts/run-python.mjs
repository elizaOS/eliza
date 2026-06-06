#!/usr/bin/env node
// Cross-platform Python launcher. POSIX systems usually expose `python3`,
// Windows usually exposes `python` (and sometimes the `py` launcher).
// Tries each in turn so package.json scripts don't have to.
//
// Usage:
//   node packages/scripts/run-python.mjs -m pytest path/to/tests -v
//   node packages/scripts/run-python.mjs script.py arg1 arg2

import { spawnSync } from "node:child_process";

const candidates =
  process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node packages/scripts/run-python.mjs <args...>");
  process.exit(2);
}

let lastError;
for (const cmd of candidates) {
  const probe = spawnSync(cmd, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  if (probe.error || probe.status !== 0) {
    lastError = probe.error;
    continue;
  }
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error(
  `[run-python] No Python interpreter found. Tried: ${candidates.join(", ")}.`,
);
if (lastError) console.error(lastError);
process.exit(1);
