#!/usr/bin/env node
/**
 * Runs Turbo with repository-wide safeguards shared by local and CI commands.
 * Typecheck prerequisites are materialized before Turbo hashes or schedules the
 * graph so package-specific task overrides cannot race generated declarations.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const maxSupportedBunLockfileVersion = 1;

function bunLockfilePath() {
  return process.env.RUN_TURBO_BUN_LOCKFILE
    ? path.resolve(process.env.RUN_TURBO_BUN_LOCKFILE)
    : path.join(repoRoot, "bun.lock");
}

function readBunLockfileVersion(lockfile) {
  if (!fs.existsSync(lockfile)) return null;
  const source = fs.readFileSync(lockfile, "utf8");
  const match = source.match(/"lockfileVersion"\s*:\s*(\d+)/);
  if (!match) {
    throw new Error(
      `${lockfile} does not contain a parseable "lockfileVersion" field.`,
    );
  }
  return Number.parseInt(match[1], 10);
}

function assertSupportedBunLockfile() {
  const lockfile = bunLockfilePath();
  const version = readBunLockfileVersion(lockfile);
  if (version === null) return;
  if (version <= maxSupportedBunLockfileVersion) return;

  throw new Error(
    [
      `Unsupported bun.lock lockfileVersion ${version} in ${lockfile}.`,
      `This repo currently allows lockfileVersion <= ${maxSupportedBunLockfileVersion} because the pinned Turbo cannot parse newer Bun lockfiles for per-package dependency hashing.`,
      "Regenerate bun.lock with a supported Bun version or update Turbo plus this guard together.",
      "Context: https://github.com/vercel/turborepo/discussions/13126",
    ].join("\n"),
  );
}

try {
  assertSupportedBunLockfile();
} catch (error) {
  console.error(`[run-turbo] ${error.message}`);
  process.exit(1);
}

if (process.env.RUN_TURBO_LOCKFILE_CHECK_ONLY === "1") {
  process.exit(0);
}

const rawTurboArgs = process.argv.slice(2);
const rawRunIndex = rawTurboArgs.indexOf("run");
const taskAndOptionArgs =
  rawRunIndex === -1 ? [] : rawTurboArgs.slice(rawRunIndex + 1);
const firstOptionIndex = taskAndOptionArgs.findIndex((arg) =>
  arg.startsWith("-"),
);
const requestedTasks =
  firstOptionIndex === -1
    ? taskAndOptionArgs
    : taskAndOptionArgs.slice(0, firstOptionIndex);

if (requestedTasks.includes("typecheck")) {
  const generator = process.env.RUN_TURBO_KEYWORD_GENERATOR
    ? path.resolve(process.env.RUN_TURBO_KEYWORD_GENERATOR)
    : path.join(repoRoot, "packages/shared/scripts/generate-keywords.mjs");
  const result = spawnSync(process.execPath, [generator, "--target", "ts"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      `[run-turbo] Failed to generate typecheck prerequisites: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.env.RUN_TURBO_PREPARE_CHECK_ONLY === "1") {
  process.exit(0);
}

// Every `node_modules` from repoRoot up to the filesystem root. A git worktree
// (e.g. `.claude/worktrees/<name>`) has no `node_modules` of its own and shares
// the parent checkout's via node's ancestor resolution — so turbo lives several
// levels up. Walk the same chain node/bun would instead of only checking
// repoRoot, so `run-turbo` works from a worktree, not just the primary checkout.
function ancestorNodeModules(startDir) {
  const dirs = [];
  let dir = startDir;
  while (true) {
    dirs.push(path.join(dir, "node_modules"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

const nodeModulesDirs = ancestorNodeModules(repoRoot);
const shimNames =
  process.platform === "win32" ? ["turbo.exe", "turbo"] : ["turbo"];
const turboShimCandidates = nodeModulesDirs.flatMap((nm) =>
  shimNames.map((name) => path.join(nm, ".bin", name)),
);
const turboShim = turboShimCandidates.find((candidate) =>
  fs.existsSync(candidate),
);
const turboPackageBin =
  nodeModulesDirs
    .map((nm) => path.join(nm, "turbo/bin/turbo"))
    .find((candidate) => fs.existsSync(candidate)) ??
  path.join(repoRoot, "node_modules/turbo/bin/turbo");
const turboArgs = rawTurboArgs;

if (!turboArgs.some((arg) => arg === "--ui" || arg.startsWith("--ui="))) {
  turboArgs.unshift("--ui=stream");
}

const runIndex = turboArgs.indexOf("run");
if (
  runIndex !== -1 &&
  !turboArgs.some(
    (arg) => arg === "--log-order" || arg.startsWith("--log-order="),
  )
) {
  turboArgs.splice(runIndex + 1, 0, "--log-order=stream");
}

const turboCommand = turboShim ?? process.execPath;
const turboCommandArgs = turboShim
  ? turboArgs
  : [turboPackageBin, ...turboArgs];

if (!turboShim && !fs.existsSync(turboPackageBin)) {
  console.error(
    `Unable to find turbo. Expected one of ${turboShimCandidates.join(", ")} or ${turboPackageBin}.`,
  );
  process.exit(1);
}

let child;
try {
  child = spawn(turboCommand, turboCommandArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
} catch (error) {
  console.error(`Failed to start turbo: ${error.message}`);
  process.exit(1);
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start turbo: ${error.message}`);
  process.exit(1);
});
