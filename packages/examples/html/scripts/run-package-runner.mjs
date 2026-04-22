#!/usr/bin/env node
/**
 * Pick `npx` (preferred) or `bunx` on PATH, then exec the same arguments you
 * would pass after `npx` — including `-y pkg@version` for one-off installs.
 *
 * Usage (from package.json next to ./scripts/ — works standalone, not only in monorepo):
 *   node scripts/run-package-runner.mjs -y vitest@4.0.18 run --passWithNoTests
 *   node scripts/run-package-runner.mjs playwright test
 *
 * For `npx`, argv is passed through unchanged. For `bunx`, a leading `-y`
 * is stripped (bunx accepts `pkg@version` without `-y`).
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

const TIMEOUT_MS = 5000;

function probeOk(cmd) {
  const r = spawnSync(cmd, ["--version"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return r.status === 0;
}

function pickRunner() {
  if (probeOk("npx")) return "npx";
  if (probeOk("bunx")) return "bunx";
  console.error(
    `[run-package-runner] Neither npx nor bunx is available on PATH.\n` +
      `  Install Node.js (includes npx): https://nodejs.org/\n` +
      `  Or install Bun (includes bunx): https://bun.sh/\n`,
  );
  process.exit(127);
}

/** @param {string[]} args */
function argsForBunx(args) {
  if (args[0] === "-y" && args.length > 1) {
    return args.slice(1);
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(
      "[run-package-runner] Missing arguments. Example:\n" +
        "  node scripts/run-package-runner.mjs -y vitest@4.0.18 run --passWithNoTests",
    );
    process.exit(1);
  }

  const runner = pickRunner();
  const toRun =
    runner === "bunx" ? ["bunx", ...argsForBunx(argv)] : ["npx", ...argv];

  const r = spawnSync(toRun[0], toRun.slice(1), {
    stdio: "inherit",
    windowsHide: true,
  });

  const code = r.status ?? 1;
  process.exit(code);
}

main();
