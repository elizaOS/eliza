#!/usr/bin/env node

import { spawn } from "node:child_process";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/rt.mjs <bun-args...>");
  process.exit(1);
}

const child = spawn("bun", args, {
  stdio: "inherit",
  env: process.env,
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
