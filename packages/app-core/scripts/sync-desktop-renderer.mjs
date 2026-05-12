#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  watch,
} from "node:fs";
import path from "node:path";

import { signalSpawnedProcessTree } from "./lib/kill-process-tree.mjs";

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);

const APP_DIR = path.join(ROOT, "apps", "app");
const DIST_DIR = path.join(APP_DIR, "dist");
const APP_PATH_ARG =
  getArgValue("app-path") || process.env.ELIZA_DESKTOP_APP_PATH || null;
const RENDERER_PATH_ARG =
  getArgValue("renderer-path") ||
  process.env.ELIZA_DESKTOP_RENDERER_PATH ||
  null;
const SKIP_BUILD = getBooleanArg("skip-build") || getBooleanArg("no-build");
const WATCH = getBooleanArg("watch");
const DEFAULT_APP_PATH = "/Applications/Eliza-canary.app";
const DEFAULT_RENDERER_DIR = path.join(
  resolveAppPath(APP_PATH_ARG || DEFAULT_APP_PATH),
  "Contents",
  "Resources",
  "app",
  "renderer",
);
const TARGET_RENDERER = RENDERER_PATH_ARG
  ? path.resolve(RENDERER_PATH_ARG)
  : DEFAULT_RENDERER_DIR;
const BUILD_ENV = { ...process.env };

let syncTimer = null;
let rendererWatcher = null;
let activeBuildProcess = null;

const WATCH_SYNC_DEBOUNCE_MS = 250;

function fail(message, code = 1) {
  console.error(`[eliza-ui-sync] ${message}`);
  process.exit(code);
}

function which(command) {
  const parts = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  for (const part of parts) {
    const candidate = path.join(part, command);
    if (existsSync(candidate)) return candidate;
    if (process.platform === "win32") {
      const exe = `${candidate}.exe`;
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

function resolveRunner() {
  return which("bunx") || which("npx");
}

function resolveAppPath(input) {
  const expanded = input.startsWith("~")
    ? path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? "",
        input.slice(1),
      )
    : input;
  return path.resolve(expanded);
}

function ensureAppDir() {
  if (!existsSync(APP_DIR)) {
    fail(`Expected app dir at ${APP_DIR}`);
  }
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    try {
      syncRendererBundle();
    } catch (error) {
      console.error(
        `[eliza-ui-sync] sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, WATCH_SYNC_DEBOUNCE_MS);
}

function startRendererWatcher() {
  if (rendererWatcher) return;
  if (!existsSync(DIST_DIR)) {
    return;
  }

  rendererWatcher = watch(DIST_DIR, { recursive: true }, () => {
    scheduleSync();
  });
}

function waitForDistAndWatch() {
  const poll = setInterval(() => {
    if (!existsSync(DIST_DIR)) {
      return;
    }
    clearInterval(poll);
    startRendererWatcher();
    scheduleSync();
  }, 300);
}

function stopWatchers() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  if (rendererWatcher) {
    rendererWatcher.close();
    rendererWatcher = null;
  }
  if (activeBuildProcess) {
    activeBuildProcess.removeAllListeners();
    signalSpawnedProcessTree(activeBuildProcess, "SIGTERM");
    activeBuildProcess = null;
  }
}

function cleanup(code = 0) {
  stopWatchers();
  process.exit(code);
}

function hasArg(name) {
  return ARGS.includes(`--${name}`);
}

function getArgValue(name) {
  const eqPrefix = `--${name}=`;
  const exactIndex = ARGS.indexOf(`--${name}`);
  if (exactIndex >= 0) {
    const value = ARGS[exactIndex + 1];
    if (!value || value.startsWith("--")) {
      return null;
    }
    return value;
  }

  const eqArg = ARGS.find((item) => item.startsWith(eqPrefix));
  if (eqArg) {
    return eqArg.slice(eqPrefix.length);
  }

  return null;
}

function getBooleanArg(name) {
  const value = getArgValue(name);
  if (value !== null) {
    const normalized = value.toLowerCase();
    return (
      normalized === "1" ||
      normalized === "true" ||
      normalized === "yes" ||
      normalized === "on"
    );
  }

  return hasArg(name);
}

function runCommand(args) {
  const runner = resolveRunner();
  if (!runner) fail("Could not find bunx or npx in PATH.");

  const result = spawnSync(runner, args, {
    cwd: APP_DIR,
    stdio: "inherit",
    env: BUILD_ENV,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    fail(
      `${runner} ${args.join(" ")} failed with exit code ${result.status}.`,
      result.status ?? 1,
    );
  }
}

function runBuild() {
  runCommand(["vite", "build"]);
}

function runBuildWatch() {
  const runner = resolveRunner();
  if (!runner) fail("Could not find bunx or npx in PATH.");

  const proc = spawn(runner, ["vite", "build", "--watch"], {
    cwd: APP_DIR,
    env: BUILD_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (text.includes("built in") || text.includes("Build completed")) {
      scheduleSync();
    }
  });

  proc.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  proc.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[eliza-ui-sync] vite watch exited with code ${code}`);
      cleanup(code ?? 1);
    }
  });

  return proc;
}

function syncRendererBundle() {
  if (!existsSync(DIST_DIR)) {
    fail(`Build output missing: ${DIST_DIR}`);
  }

  try {
    const stat = statSync(TARGET_RENDERER);
    if (!stat.isDirectory()) {
      fail(`Target renderer path is not a directory: ${TARGET_RENDERER}`);
    }
  } catch {
    // Renderer path will be created below.
  }

  rmSync(TARGET_RENDERER, { recursive: true, force: true });
  mkdirSync(TARGET_RENDERER, { recursive: true });
  cpSync(DIST_DIR, TARGET_RENDERER, { recursive: true, force: true });
  console.log(`[eliza-ui-sync] Synced ${DIST_DIR} -> ${TARGET_RENDERER}`);
}

function printUsage() {
  console.log(
    "Usage: node scripts/sync-desktop-renderer.mjs [--app-path <path>] [--renderer-path <path>] [--skip-build] [--watch]",
  );
  console.log("Environment:");
  console.log(
    "  ELIZA_DESKTOP_APP_PATH      Override /Applications/Eliza-canary.app",
  );
  console.log(
    "  ELIZA_DESKTOP_RENDERER_PATH  Override renderer folder directly",
  );
  console.log("\nExamples:");
  console.log("  node scripts/sync-desktop-renderer.mjs");
  console.log(
    "  node scripts/sync-desktop-renderer.mjs --app-path ~/Applications/Eliza.app --skip-build",
  );
  console.log("  node scripts/sync-desktop-renderer.mjs --watch");
}

function main() {
  if (process.platform !== "darwin") {
    console.log(
      "[eliza-ui-sync] Warning: this script targets macOS app bundles by default.",
    );
  }

  if (hasArg("help") || hasArg("h")) {
    printUsage();
    process.exit(0);
  }

  ensureAppDir();
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));

  if (WATCH) {
    if (SKIP_BUILD) {
      console.log(
        "[eliza-ui-sync] --skip-build set: watching built dist folder only",
      );
      waitForDistAndWatch();
      return;
    }
    activeBuildProcess = runBuildWatch();
    waitForDistAndWatch();
    return;
  }

  runBuild();
  syncRendererBundle();
}

main();
