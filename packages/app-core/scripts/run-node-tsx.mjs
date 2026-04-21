#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

function isRealNodeExecutable(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) {
    return false;
  }
  const normalized = candidate.replace(/\\/g, "/");
  return !/\/bun-node-[^/]+\/node$/.test(normalized);
}

function resolveNodeCmd() {
  if (isRealNodeExecutable(process.env.npm_node_execpath)) {
    return process.env.npm_node_execpath;
  }
  for (const candidate of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]) {
    if (isRealNodeExecutable(candidate)) {
      return candidate;
    }
  }
  if (isRealNodeExecutable(process.execPath)) {
    return process.execPath;
  }
  return "node";
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("[run-node-tsx] Missing script path");
  process.exit(1);
}

const child = spawn(resolveNodeCmd(), ["--import", "tsx", ...args], {
  cwd: process.cwd(),
  env: { ...process.env, PWD: process.cwd() },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(
    `[run-node-tsx] Failed to spawn Node: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
