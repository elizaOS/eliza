#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, watch } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const bunBin = process.env.BUN_BIN || "bun";
const agentDir = path.join(repoRoot, "packages", "agent");
const watchDirs = [
  "packages/agent/src",
  "packages/app-core/src",
  "packages/core/src",
  "packages/shared/src",
]
  .map((dir) => path.join(repoRoot, dir))
  .filter((dir) => existsSync(dir));

let child = null;
let stopping = false;
let restarting = false;
let restartTimer = null;
const watcherStartedAt = Date.now();
const seenMtimes = new Map();

function childPids(pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
    })
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

function signalProcessTree(pid, signal) {
  for (const childPid of childPids(pid)) {
    signalProcessTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

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
    if (restarting) {
      restarting = false;
      startAgent();
      return;
    }
    if (stopping) {
      process.exit(0);
      return;
    }
    console.error(
      `[dev-agent-watch] agent exited unexpectedly (${signal ?? code})`,
    );
    process.exit(typeof code === "number" ? code : 1);
  });
}

function requestRestart(filePath) {
  if (stopping) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!child) {
      startAgent();
      return;
    }
    restarting = true;
    console.log(`[dev-agent-watch] restarting agent after change: ${filePath}`);
    signalProcessTree(child.pid, "SIGTERM");
  }, 750);
}

function wasActuallyModifiedAfterWatcherStart(fullPath) {
  try {
    const mtimeMs = statSync(fullPath).mtimeMs;
    if (mtimeMs < watcherStartedAt - 1000) return false;
    if (seenMtimes.get(fullPath) === mtimeMs) return false;
    seenMtimes.set(fullPath, mtimeMs);
    return true;
  } catch {
    return false;
  }
}

const watchers = watchDirs.map((dir) =>
  watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const filePath = String(filename).replaceAll(path.sep, "/");
    const fullPath = path.join(dir, filePath);
    if (
      filePath.includes("node_modules") ||
      filePath === "dist" ||
      filePath.includes("/dist/") ||
      filePath.includes("generated/") ||
      filePath.includes("i18n/generated/") ||
      filePath.includes("/__tests__/") ||
      filePath.endsWith(".test.ts") ||
      filePath.endsWith(".test.tsx") ||
      filePath.endsWith(".spec.ts") ||
      filePath.endsWith(".spec.tsx") ||
      filePath.endsWith(".d.ts") ||
      filePath.endsWith(".d.ts.map") ||
      filePath.endsWith(".map") ||
      filePath.endsWith(".log") ||
      filePath.endsWith(".md") ||
      filePath.endsWith(".tsbuildinfo")
    ) {
      return;
    }
    if (!wasActuallyModifiedAfterWatcherStart(fullPath)) return;
    requestRestart(path.relative(repoRoot, fullPath));
  }),
);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  if (child) {
    signalProcessTree(child.pid, signal);
    setTimeout(() => {
      if (child) signalProcessTree(child.pid, "SIGKILL");
    }, 5000).unref();
    return;
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(
  `[dev-agent-watch] watching ${watchDirs.length} source root(s); starting agent`,
);
startAgent();
