#!/usr/bin/env bun

/**
 * Local cleanup for GitHub Actions self-hosted runner workspaces on robot hosts.
 *
 * Runner installations keep completed-job checkouts under each runner's `_work`
 * directory and do not reclaim them automatically. On small-root agent robots
 * this can consume tens of GB while Docker cleanup reports nothing to reclaim.
 * This script is intentionally host-local: run it from cron/systemd on the
 * runner host, not from the control plane. It refuses to delete while a
 * `Runner.Worker` process is active unless the operator explicitly overrides
 * that guard.
 */

import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface RunnerWorkspacePruneArgs {
  root: string;
  minAgeHours: number;
  dryRun: boolean;
  allowActive: boolean;
}

export interface WorkspaceEntry {
  path: string;
  ageMs: number;
  bytes: number;
}

export interface WorkspacePlan {
  workDirs: string[];
  entries: WorkspaceEntry[];
  skippedFresh: number;
  totalBytes: number;
}

const DEFAULT_ROOT = "/opt/actions-runners";
const DEFAULT_MIN_AGE_HOURS = 6;
const MIN_AGE_HOURS_FLOOR = 1;

export function parseRunnerWorkspacePruneArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): RunnerWorkspacePruneArgs {
  const flags = new Map<string, string>();
  let dryRun = false;
  let allowActive = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--allow-active") {
      allowActive = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag --${key} requires a value`);
      }
      flags.set(key, value);
      i++;
    }
  }

  const rawRoot =
    flags.get("root") ?? env.RUNNER_WORKSPACE_ROOT ?? DEFAULT_ROOT;
  // Runner hosts are Linux; keep POSIX-absolute roots verbatim so parsing
  // behaves identically when this suite runs on win32 CI, where path.resolve
  // would drive-qualify "/opt/..." into "D:\opt\...".
  const root = rawRoot.startsWith("/")
    ? path.posix.normalize(rawRoot)
    : path.resolve(rawRoot);
  const minAgeRaw =
    flags.get("min-age-hours") ??
    env.RUNNER_WORKSPACE_MIN_AGE_HOURS ??
    String(DEFAULT_MIN_AGE_HOURS);
  const minAgeHours = Number.parseInt(minAgeRaw, 10);
  if (!Number.isInteger(minAgeHours) || minAgeHours < MIN_AGE_HOURS_FLOOR) {
    throw new Error(`Invalid min-age-hours: ${minAgeRaw}`);
  }

  return { root, minAgeHours, dryRun, allowActive };
}

function realPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function findRunnerWorkDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (!stat.isDirectory()) return [];
  const dirs = new Set<string>();

  const maybeAdd = (candidate: string) => {
    const base = path.basename(candidate);
    if (base !== "_work") return;
    const realCandidate = path.resolve(candidate);
    if (realCandidate !== root && !realPathInsideRoot(realCandidate, root))
      return;
    try {
      if (lstatSync(realCandidate).isDirectory()) dirs.add(realCandidate);
    } catch {
      // error-policy:J6 best-effort host cleanup; racing deletes are harmless.
    }
  };

  maybeAdd(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    maybeAdd(child);
    try {
      for (const nested of readdirSync(child, { withFileTypes: true })) {
        if (nested.isDirectory()) maybeAdd(path.join(child, nested.name));
      }
    } catch {
      // error-policy:J6 best-effort host cleanup; an unreadable runner dir is skipped.
    }
  }

  return [...dirs].sort();
}

function pathSizeBytes(target: string): number {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch {
      // error-policy:J6 best-effort size reporting; cleanup still attempts the path.
      continue;
    }
    total += stat.size;
    if (!stat.isDirectory()) continue;
    try {
      for (const child of readdirSync(current))
        stack.push(path.join(current, child));
    } catch {
      // error-policy:J6 best-effort size reporting; unreadable children are ignored.
    }
  }
  return total;
}

export function buildRunnerWorkspacePrunePlan(input: {
  root: string;
  now: number;
  minAgeHours: number;
}): WorkspacePlan {
  const minAgeMs = input.minAgeHours * 60 * 60_000;
  const workDirs = findRunnerWorkDirs(input.root);
  const entries: WorkspaceEntry[] = [];
  let skippedFresh = 0;

  for (const workDir of workDirs) {
    let children: ReturnType<typeof readdirSync>;
    try {
      children = readdirSync(workDir, { withFileTypes: true });
    } catch {
      // error-policy:J6 best-effort host cleanup; a racing runner dir can be retried on the next pass.
      continue;
    }

    for (const child of children) {
      const childPath = path.join(workDir, child.name);
      if (!realPathInsideRoot(childPath, input.root)) continue;
      let stat: Stats;
      try {
        stat = lstatSync(childPath);
      } catch {
        // error-policy:J6 best-effort host cleanup; racing child deletes are harmless.
        continue;
      }
      const ageMs = input.now - stat.mtimeMs;
      if (ageMs < minAgeMs) {
        skippedFresh += 1;
        continue;
      }
      entries.push({
        path: childPath,
        ageMs,
        bytes: pathSizeBytes(childPath),
      });
    }
  }

  return {
    workDirs,
    entries,
    skippedFresh,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

export function isRunnerWorkerActive(): boolean {
  const result = spawnSync("pgrep", ["-f", "Runner\\.Worker"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 || unit === "B" ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

async function main(): Promise<void> {
  const args = parseRunnerWorkspacePruneArgs(
    process.argv.slice(2),
    process.env,
  );
  if (!args.allowActive && isRunnerWorkerActive()) {
    throw new Error(
      "Runner.Worker is active; refusing to prune. Re-run after jobs finish.",
    );
  }

  const plan = buildRunnerWorkspacePrunePlan({
    root: args.root,
    now: Date.now(),
    minAgeHours: args.minAgeHours,
  });

  console.log(`[prune-runner-workspaces] root: ${args.root}`);
  console.log(`[prune-runner-workspaces] work dirs: ${plan.workDirs.length}`);
  console.log(
    `[prune-runner-workspaces] stale entries: ${plan.entries.length}`,
  );
  console.log(
    `[prune-runner-workspaces] skipped fresh entries: ${plan.skippedFresh}`,
  );
  console.log(
    `[prune-runner-workspaces] reclaimable: ${formatBytes(plan.totalBytes)}`,
  );

  for (const entry of plan.entries) {
    console.log(
      `[prune-runner-workspaces] ${args.dryRun ? "would remove" : "removing"} ${entry.path} (${formatBytes(entry.bytes)})`,
    );
    if (!args.dryRun) rmSync(entry.path, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  main().catch((error) => {
    // error-policy:J1 CLI boundary translates failures into a non-zero exit.
    console.error(
      "[prune-runner-workspaces] failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
