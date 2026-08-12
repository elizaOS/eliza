#!/usr/bin/env node
/**
 * Runs Turbo with repository-wide safeguards shared by local and CI commands.
 * Generated-source prerequisites are materialized before Turbo hashes or
 * schedules build/typecheck graphs so cached tasks and package-specific
 * overrides cannot omit files consumed outside their owning package.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTurboConcurrency,
  resolveTurboConcurrency,
} from "./lib/run-turbo-concurrency.mjs";

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
// Turbo accepts tasks as `turbo run <task>` or bare `turbo <task>`, with flags
// anywhere in between (`run --filter=x typecheck`), and forwards everything
// after a bare `--` to the tasks themselves. Collect every non-flag argument
// before the `--` separator, dropping only a leading `run` command word, so
// keyword pre-generation cannot be skipped by flag placement or the bare form.
// A space-separated flag value (`--filter core`) may be miscounted as a task;
// that errs toward running the idempotent generator, never toward skipping it.
const passThroughIndex = rawTurboArgs.indexOf("--");
const turboOwnArgs =
  passThroughIndex === -1
    ? rawTurboArgs
    : rawTurboArgs.slice(0, passThroughIndex);
const positionalArgs = turboOwnArgs.filter((arg) => !arg.startsWith("-"));
const requestedTasks =
  positionalArgs[0] === "run" ? positionalArgs.slice(1) : positionalArgs;

const generatedSourceTasks = new Set(["build", "typecheck"]);
if (requestedTasks.some((task) => generatedSourceTasks.has(task))) {
  const generator = process.env.RUN_TURBO_KEYWORD_GENERATOR
    ? path.resolve(process.env.RUN_TURBO_KEYWORD_GENERATOR)
    : path.join(repoRoot, "packages/shared/scripts/generate-keywords.mjs");
  const result = spawnSync(process.execPath, [generator], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      `[run-turbo] Failed to generate generated-source prerequisites: ${result.error.message}`,
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

// RUN_TURBO_CONCURRENCY caps task fan-out from the environment. Hosted CI
// runners (4 vCPU / 16 GB) die at the package-script default of 8 concurrent
// tsc processes on a full-workspace cone — the VM itself is OOM-killed and the
// job exits 143 (#15140) — so CI lanes set this to 4 without forking the
// `verify`/`typecheck` script definitions. Fail closed on typos before Turbo
// starts so a malformed override cannot disable or corrupt that cap.
let resolvedConcurrency;
try {
  resolvedConcurrency = resolveTurboConcurrency(process.env);
} catch (error) {
  console.error(`[run-turbo] ${error.message}`);
  process.exit(1);
}
if (resolvedConcurrency != null) {
  const withConcurrency = applyTurboConcurrency(turboArgs, resolvedConcurrency);
  turboArgs.length = 0;
  turboArgs.push(...withConcurrency);
}

// Test seam: RUN_TURBO_BIN points at a Node script that stands in for the
// turbo binary so the retry contract below is provable with real
// subprocesses (see __tests__/run-turbo-windows-init-crash-retry.test.ts).
const turboBinOverride = process.env.RUN_TURBO_BIN
  ? path.resolve(process.env.RUN_TURBO_BIN)
  : null;
const turboCommand = turboBinOverride
  ? process.execPath
  : (turboShim ?? process.execPath);
const turboCommandArgs = turboBinOverride
  ? [turboBinOverride, ...turboArgs]
  : turboShim
    ? turboArgs
    : [turboPackageBin, ...turboArgs];

if (!turboBinOverride && !turboShim && !fs.existsSync(turboPackageBin)) {
  console.error(
    `Unable to find turbo. Expected one of ${turboShimCandidates.join(", ")} or ${turboPackageBin}.`,
  );
  process.exit(1);
}

// 0xC0000142 (STATUS_DLL_INIT_FAILED) as the signed 32-bit exit code Turbo
// prints when a Windows child process dies before its entry point runs —
// desktop-heap/session-resource exhaustion on busy CI runners, not a property
// of the task. The task emits no output at all, so the only observable
// signature is Turbo's own failure line. One bounded retry resumes from the
// Turbo cache (completed tasks skip), and the retry is announced loudly so a
// deterministic failure can never hide behind it.
const WINDOWS_PROCESS_INIT_CRASH = "exited (-1073741502)";
const TURBO_OUTPUT_DRAIN_GRACE_MS = 2_000;
// The retry is live on Windows only (the crash class is a Windows runner
// failure); RUN_TURBO_FORCE_INIT_CRASH_RETRY lets the contract tests exercise
// the loop on every platform, RUN_TURBO_NO_INIT_CRASH_RETRY turns it off.
const maxTurboAttempts =
  process.env.RUN_TURBO_NO_INIT_CRASH_RETRY === "1"
    ? 1
    : process.platform === "win32" ||
        process.env.RUN_TURBO_FORCE_INIT_CRASH_RETRY === "1"
      ? 2
      : 1;

function runTurboOnce() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(turboCommand, turboCommandArgs, {
        cwd: process.cwd(),
        env: process.env,
        // Piped (not inherited) stdio so the crash signature is observable;
        // --ui=stream/--log-order=stream are already forced above, so Turbo's
        // output does not depend on TTY detection.
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error) {
      console.error(`Failed to start turbo: ${error.message}`);
      process.exit(1);
    }

    let sawInitCrash = false;
    // The signature could straddle a chunk boundary; carry a tail shorter than
    // the marker across writes.
    const scan = (carry, chunk) => {
      const text = carry + chunk.toString("utf8");
      if (text.includes(WINDOWS_PROCESS_INIT_CRASH)) sawInitCrash = true;
      return text.slice(-WINDOWS_PROCESS_INIT_CRASH.length);
    };
    let outCarry = "";
    let errCarry = "";
    child.stdout.on("data", (chunk) => {
      outCarry = scan(outCarry, chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errCarry = scan(errCarry, chunk);
      process.stderr.write(chunk);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      // Turbo's final failure line can arrive after `exit`, but descendants may
      // inherit its pipes and prevent `close` forever. Drain until closure or a
      // bounded grace period so retry detection is reliable without hanging CI.
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, sawInitCrash });
      };
      const timer = setTimeout(finish, TURBO_OUTPUT_DRAIN_GRACE_MS);
      child.once("close", finish);
    });

    child.on("error", (error) => {
      console.error(`Failed to start turbo: ${error.message}`);
      process.exit(1);
    });
  });
}

for (let attempt = 1; attempt <= maxTurboAttempts; attempt += 1) {
  const { code, sawInitCrash } = await runTurboOnce();
  if (code === 0) process.exit(0);
  if (attempt < maxTurboAttempts && sawInitCrash) {
    console.error(
      `[run-turbo] A task child process died with 0xC0000142 (STATUS_DLL_INIT_FAILED) — a Windows runner resource crash, not task output. Retrying once from the Turbo cache (attempt ${attempt + 1}/${maxTurboAttempts}).`,
    );
    continue;
  }
  process.exit(code);
}
