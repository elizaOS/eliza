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

const SIGNAL_EXIT_CODE = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

let forwardedSignal = null;
let forceKillTimer = null;

function forwardSignal(signal) {
  forwardedSignal = signal;
  if (child.exitCode == null && child.signalCode == null) {
    child.kill(signal);
    forceKillTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }, 10_000);
    forceKillTimer.unref?.();
  }
}

for (const signal of Object.keys(SIGNAL_EXIT_CODE)) {
  process.once(signal, () => forwardSignal(signal));
}

child.on("error", (error) => {
  console.error(
    `[run-node-tsx] Failed to spawn Node: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }
  if (signal) {
    process.exit(SIGNAL_EXIT_CODE[signal] ?? 1);
  }
  if (forwardedSignal) {
    process.exit(SIGNAL_EXIT_CODE[forwardedSignal] ?? 1);
  }
  process.exit(code ?? 1);
});
