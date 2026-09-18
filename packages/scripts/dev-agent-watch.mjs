#!/usr/bin/env node
/**
 * Runs the agent for the combined development stack, restarting on backend
 * source edits. Shared watch and process-tree helpers own discovery and teardown;
 * unexpected child exits still stop this launcher so the parent sees failure.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { startAgentSourceWatcher } from "../app-core/scripts/lib/agent-source-watcher.mjs";
import { signalSpawnedProcessTree } from "../app-core/scripts/lib/kill-process-tree.mjs";

const repoRoot = process.cwd();
const bunBin = process.env.BUN_BIN || "bun";
const agentDir = path.join(repoRoot, "packages", "agent");
let child = null;
let stopping = false;
let restarting = false;

function startAgent() {
  if (stopping) return;
  child = spawn(bunBin, ["run", "src/bin.ts"], {
    cwd: agentDir,
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`[dev-agent-watch] failed to start agent: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(0);
      return;
    }
    if (restarting) {
      restarting = false;
      startAgent();
      return;
    }
    console.error(
      `[dev-agent-watch] agent exited unexpectedly (${signal ?? code})`,
    );
    process.exit(typeof code === "number" ? code : 1);
  });
}

const watcher = startAgentSourceWatcher({
  root: repoRoot,
  debounceMs: 750,
  onChange(filePath) {
    if (stopping || restarting) return;
    restarting = true;
    console.log(`[dev-agent-watch] restarting agent after change: ${filePath}`);
    signalSpawnedProcessTree(child, "SIGTERM");
  },
  onError(dir, error) {
    throw new Error(`Cannot watch agent source in ${dir}`, { cause: error });
  },
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  watcher.close();
  if (child) {
    signalSpawnedProcessTree(child, "SIGTERM");
    setTimeout(() => signalSpawnedProcessTree(child, "SIGKILL"), 5000).unref();
    return;
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `[dev-agent-watch] watching ${watcher.count} source root(s); starting agent`,
);
startAgent();
