#!/usr/bin/env node

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const PROCESS_SPAWNED_AT_ENV = "ELIZA_PROCESS_SPAWNED_AT_MS";
const API_PROCESS_SPAWNED_AT_ENV = "ELIZA_API_PROCESS_SPAWNED_AT_MS";

if (args.length === 0) {
  console.error("Usage: node scripts/rt.mjs <bun-args...>");
  process.exit(1);
}

function isDevServerLaunch(argv) {
  return argv.some((arg) => /(?:^|[/\\])dev-server\.(?:ts|js)$/.test(arg));
}

const spawnedAtMs = String(Date.now());
const childEnv = {
  ...process.env,
  [PROCESS_SPAWNED_AT_ENV]: spawnedAtMs,
};
if (isDevServerLaunch(args)) {
  childEnv[API_PROCESS_SPAWNED_AT_ENV] = spawnedAtMs;
}

const child = spawn("bun", args, {
  stdio: "inherit",
  env: childEnv,
});

child.on("error", (error) => {
  console.error(`[rt] failed to launch bun: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
