/**
 * Captures content-free Git worktree fingerprints around local commands.
 * Snapshot work is bounded by explicit wall-clock, Git-output, and file-byte
 * budgets; exhaustion produces an indeterminate receipt, never a partial hash.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  WORKSPACE_DELTA_RECEIPT_DATA_KEY,
  type WorkspaceDeltaIndeterminateReasonCode,
  type WorkspaceDeltaReceipt,
} from "@elizaos/core";

const execFileAsync = promisify(execFile);
export const WORKSPACE_DELTA_OBSERVATION_TIMEOUT_MS = 30_000;
export const WORKSPACE_DELTA_FILE_BYTE_BUDGET = 64 * 1024 * 1024;
export const WORKSPACE_DELTA_GIT_OUTPUT_BUDGET = 8 * 1024 * 1024;

interface GitWorkspaceSnapshot {
  root: string;
  fingerprint: string;
}

type GitRunner = (
  cwd: string,
  args: string[],
  limits?: { timeoutMs: number; maxOutputBytes: number },
) => Promise<string>;

export interface LocalWorkspaceDeltaDependencies {
  /** Test seam for Git failures and resource-budget boundaries. */
  runGit?: GitRunner;
  maxObservationMs?: number;
  maxFileBytes?: number;
  maxGitOutputBytes?: number;
  now?: () => number;
}

interface ObservationLimits {
  maxObservationMs: number;
  maxFileBytes: number;
  maxGitOutputBytes: number;
  now: () => number;
}

interface SnapshotBudget {
  deadline: number;
  remainingFileBytes: number;
  remainingGitOutputBytes: number;
  now: () => number;
}

export interface LocalWorkspaceDeltaObservation {
  root: string;
  before?: GitWorkspaceSnapshot;
  baselineFailure?: WorkspaceDeltaIndeterminateReasonCode;
  probeFailure?: true;
  runGit: GitRunner;
  limits: ObservationLimits;
}

class ObservationBudgetError extends Error {
  constructor(
    readonly reasonCode: Extract<
      WorkspaceDeltaIndeterminateReasonCode,
      | "OBSERVATION_TIME_BUDGET_EXCEEDED"
      | "OBSERVATION_BYTE_BUDGET_EXCEEDED"
      | "OBSERVATION_OUTPUT_BUDGET_EXCEEDED"
    >,
  ) {
    super(reasonCode);
  }
}

async function git(
  cwd: string,
  args: string[],
  limits?: { timeoutMs: number; maxOutputBytes: number },
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: limits?.timeoutMs ?? WORKSPACE_DELTA_OBSERVATION_TIMEOUT_MS,
    maxBuffer: limits?.maxOutputBytes ?? WORKSPACE_DELTA_GIT_OUTPUT_BUDGET,
  });
  return result.stdout;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

function resolveLimits(
  dependencies: LocalWorkspaceDeltaDependencies,
): ObservationLimits {
  return {
    maxObservationMs: positiveLimit(
      dependencies.maxObservationMs,
      WORKSPACE_DELTA_OBSERVATION_TIMEOUT_MS,
    ),
    maxFileBytes: positiveLimit(
      dependencies.maxFileBytes,
      WORKSPACE_DELTA_FILE_BYTE_BUDGET,
    ),
    maxGitOutputBytes: positiveLimit(
      dependencies.maxGitOutputBytes,
      WORKSPACE_DELTA_GIT_OUTPUT_BUDGET,
    ),
    now: dependencies.now ?? Date.now,
  };
}

function newBudget(value: ObservationLimits): SnapshotBudget {
  return {
    deadline: value.now() + value.maxObservationMs,
    remainingFileBytes: value.maxFileBytes,
    remainingGitOutputBytes: value.maxGitOutputBytes,
    now: value.now,
  };
}

function remainingLimits(
  value: ObservationLimits,
  phaseStartedAt: number,
): ObservationLimits {
  return {
    ...value,
    maxObservationMs: Math.max(
      1,
      value.maxObservationMs - Math.max(0, value.now() - phaseStartedAt),
    ),
  };
}

function assertTime(budget: SnapshotBudget): void {
  if (budget.now() > budget.deadline) {
    throw new ObservationBudgetError("OBSERVATION_TIME_BUDGET_EXCEEDED");
  }
}

async function budgetedGit(
  runGit: GitRunner,
  cwd: string,
  args: string[],
  budget: SnapshotBudget,
): Promise<string> {
  assertTime(budget);
  const remainingMs = Math.max(1, budget.deadline - budget.now());
  let output: string;
  try {
    output = await runGit(cwd, args, {
      timeoutMs: remainingMs,
      maxOutputBytes: Math.max(1, budget.remainingGitOutputBytes),
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals;
    };
    if (
      failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      failure.message?.includes("maxBuffer")
    ) {
      throw new ObservationBudgetError("OBSERVATION_OUTPUT_BUDGET_EXCEEDED");
    }
    if (failure.killed || failure.signal === "SIGTERM") {
      throw new ObservationBudgetError("OBSERVATION_TIME_BUDGET_EXCEEDED");
    }
    throw error;
  }
  assertTime(budget);
  const bytes = Buffer.byteLength(output);
  if (bytes > budget.remainingGitOutputBytes) {
    throw new ObservationBudgetError("OBSERVATION_OUTPUT_BUDGET_EXCEEDED");
  }
  budget.remainingGitOutputBytes -= bytes;
  return output;
}

function nullSeparatedPaths(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

function trackedSpecialPaths(raw: string): {
  contentPaths: string[];
  submodulePaths: string[];
} {
  const contentPaths: string[] = [];
  const submodulePaths: string[] = [];
  for (const record of raw.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0 || record.length < 3) continue;
    const tag = record[0];
    const metadata = record.slice(2, tab).trim().split(/\s+/);
    const relative = record.slice(tab + 1);
    if (!relative) continue;
    if (tag === "S" || tag.toLowerCase() === tag) contentPaths.push(relative);
    if (metadata[0] === "160000") submodulePaths.push(relative);
  }
  return { contentPaths, submodulePaths };
}

function absoluteInsideRoot(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const relativeCheck = path.relative(root, absolute);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw new Error("Git reported a path outside its worktree root.");
  }
  return absolute;
}

async function hashFileBounded(
  absolute: string,
  hash: ReturnType<typeof createHash>,
  budget: SnapshotBudget,
): Promise<void> {
  const stream = createReadStream(absolute, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      assertTime(budget);
      const bytes = (chunk as Buffer).byteLength;
      if (bytes > budget.remainingFileBytes) {
        throw new ObservationBudgetError("OBSERVATION_BYTE_BUDGET_EXCEEDED");
      }
      budget.remainingFileBytes -= bytes;
      hash.update(chunk as Buffer);
    }
  } finally {
    stream.destroy();
  }
}

async function pathFingerprint(
  root: string,
  relative: string,
  budget: SnapshotBudget,
): Promise<string> {
  const absolute = absoluteInsideRoot(root, relative);
  assertTime(budget);
  try {
    const stat = await fs.lstat(absolute);
    const hash = createHash("sha256");
    hash.update(
      `${stat.mode}:${stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other"}\0`,
    );
    if (stat.isFile()) await hashFileBounded(absolute, hash, budget);
    else if (stat.isSymbolicLink()) hash.update(await fs.readlink(absolute));
    else hash.update(`${stat.size}:${stat.mtimeMs}`);
    assertTime(budget);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function headIdentity(
  root: string,
  runGit: GitRunner,
  budget: SnapshotBudget,
): Promise<string> {
  try {
    const head = await budgetedGit(
      runGit,
      root,
      ["rev-parse", "--verify", "HEAD"],
      budget,
    );
    let headRef = "detached";
    try {
      headRef = (
        await budgetedGit(
          runGit,
          root,
          ["symbolic-ref", "--quiet", "HEAD"],
          budget,
        )
      ).trim();
    } catch (error) {
      if (error instanceof ObservationBudgetError) throw error;
    }
    return `commit:${head.trim()}:ref:${headRef}`;
  } catch (error) {
    if (error instanceof ObservationBudgetError) throw error;
    const headRef = (
      await budgetedGit(
        runGit,
        root,
        ["symbolic-ref", "--quiet", "HEAD"],
        budget,
      )
    ).trim();
    if (!headRef) throw error;
    return `unborn:${headRef}`;
  }
}

async function captureAtRoot(
  root: string,
  runGit: GitRunner,
  budget: SnapshotBudget,
  seenRoots = new Set<string>(),
): Promise<GitWorkspaceSnapshot> {
  const canonicalRoot = await fs.realpath(root);
  if (seenRoots.has(canonicalRoot)) {
    throw new Error("Recursive Git worktree topology detected.");
  }
  seenRoots.add(canonicalRoot);
  try {
    const [head, index, trackedChanges, untracked] = await Promise.all([
      headIdentity(canonicalRoot, runGit, budget),
      budgetedGit(
        runGit,
        canonicalRoot,
        ["ls-files", "--stage", "-v", "-z"],
        budget,
      ),
      budgetedGit(
        runGit,
        canonicalRoot,
        ["diff-files", "--name-only", "-z", "--ignore-submodules=none", "--"],
        budget,
      ),
      budgetedGit(
        runGit,
        canonicalRoot,
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
        budget,
      ),
    ]);
    const hash = createHash("sha256");
    hash.update("head\0");
    hash.update(head);
    hash.update("\0index\0");
    hash.update(index);
    hash.update("\0tracked-worktree-changes\0");
    hash.update(trackedChanges);
    hash.update("\0untracked\0");
    hash.update(untracked);
    const special = trackedSpecialPaths(index);
    const contentPaths = new Set([
      ...nullSeparatedPaths(trackedChanges),
      ...nullSeparatedPaths(untracked),
      ...special.contentPaths,
    ]);
    for (const relative of [...contentPaths].sort((a, b) =>
      a.localeCompare(b),
    )) {
      hash.update("\0path\0");
      hash.update(relative);
      hash.update("\0");
      hash.update(await pathFingerprint(canonicalRoot, relative, budget));
    }
    for (const relative of special.submodulePaths.sort((a, b) =>
      a.localeCompare(b),
    )) {
      hash.update("\0submodule\0");
      hash.update(relative);
      hash.update("\0");
      const absolute = absoluteInsideRoot(canonicalRoot, relative);
      try {
        const stat = await fs.lstat(absolute);
        if (!stat.isDirectory()) {
          hash.update(await pathFingerprint(canonicalRoot, relative, budget));
          continue;
        }
        const nested = await captureAtRoot(absolute, runGit, budget, seenRoots);
        hash.update(nested.fingerprint);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          hash.update("missing");
          continue;
        }
        throw error;
      }
    }
    assertTime(budget);
    return { root: canonicalRoot, fingerprint: hash.digest("hex") };
  } finally {
    seenRoots.delete(canonicalRoot);
  }
}

async function findGitMarkerRoot(
  cwd: string,
  budget: SnapshotBudget,
): Promise<string | undefined> {
  let current = await fs.realpath(cwd);
  while (true) {
    assertTime(budget);
    try {
      const marker = await fs.lstat(path.join(current, ".git"));
      if (marker.isDirectory() || marker.isFile()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function failureReason(
  error: unknown,
  fallback: WorkspaceDeltaIndeterminateReasonCode,
): WorkspaceDeltaIndeterminateReasonCode {
  return error instanceof ObservationBudgetError ? error.reasonCode : fallback;
}

/** Returns undefined when cwd is not inside a Git worktree. */
export async function beginLocalWorkspaceDeltaObservation(
  cwd: string,
  dependencies: LocalWorkspaceDeltaDependencies = {},
): Promise<LocalWorkspaceDeltaObservation | undefined> {
  const runGit = dependencies.runGit ?? git;
  const observationLimits = resolveLimits(dependencies);
  const phaseStartedAt = observationLimits.now();
  const budget = newBudget(observationLimits);
  let root: string;
  try {
    root = (
      await budgetedGit(runGit, cwd, ["rev-parse", "--show-toplevel"], budget)
    ).trim();
  } catch (error) {
    let markerRoot: string | undefined;
    try {
      markerRoot = await findGitMarkerRoot(cwd, budget);
    } catch (fallbackError) {
      if (fallbackError instanceof ObservationBudgetError) {
        const realRoot = await fs.realpath(cwd).catch(() => cwd);
        return {
          root: realRoot,
          baselineFailure: fallbackError.reasonCode,
          runGit,
          limits: remainingLimits(observationLimits, phaseStartedAt),
        };
      }
      return undefined;
    }
    if (error instanceof ObservationBudgetError) {
      return {
        root: markerRoot ?? (await fs.realpath(cwd).catch(() => cwd)),
        baselineFailure: error.reasonCode,
        runGit,
        limits: remainingLimits(observationLimits, phaseStartedAt),
      };
    }
    if (markerRoot) {
      return {
        root: markerRoot,
        probeFailure: true,
        runGit,
        limits: remainingLimits(observationLimits, phaseStartedAt),
      };
    }
    return undefined;
  }
  if (!root) return undefined;
  try {
    return {
      root: await fs.realpath(root),
      before: await captureAtRoot(root, runGit, budget),
      runGit,
      limits: remainingLimits(observationLimits, phaseStartedAt),
    };
  } catch (error) {
    return {
      root: await fs.realpath(root).catch(() => root),
      baselineFailure: failureReason(error, "BASELINE_SNAPSHOT_FAILED"),
      runGit,
      limits: remainingLimits(observationLimits, phaseStartedAt),
    };
  }
}

export async function finishLocalWorkspaceDeltaObservation(
  observation: LocalWorkspaceDeltaObservation | undefined,
): Promise<WorkspaceDeltaReceipt | undefined> {
  if (!observation) return undefined;
  const base = {
    version: 1 as const,
    kind: "workspace_delta" as const,
    scope: {
      kind: "git_worktree" as const,
      root: observation.root,
      coverage: "tracked_and_untracked_nonignored" as const,
    },
    observedAt: new Date().toISOString(),
  };
  if (observation.probeFailure) {
    return {
      ...base,
      outcome: "indeterminate",
      reasonCode: "WORKTREE_PROBE_FAILED",
    };
  }
  if (!observation.before || observation.baselineFailure) {
    return {
      ...base,
      outcome: "indeterminate",
      reasonCode: observation.baselineFailure ?? "BASELINE_SNAPSHOT_FAILED",
    };
  }
  try {
    const after = await captureAtRoot(
      observation.root,
      observation.runGit,
      newBudget(observation.limits),
    );
    return {
      ...base,
      outcome:
        after.fingerprint === observation.before.fingerprint
          ? "unchanged"
          : "changed",
      beforeFingerprint: observation.before.fingerprint,
      afterFingerprint: after.fingerprint,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "indeterminate",
      beforeFingerprint: observation.before.fingerprint,
      reasonCode: failureReason(error, "POST_SNAPSHOT_FAILED"),
    };
  }
}

export function indeterminateWorkspaceDeltaReceipt(
  root: string,
  reasonCode: WorkspaceDeltaIndeterminateReasonCode,
): WorkspaceDeltaReceipt {
  return {
    version: 1,
    kind: "workspace_delta",
    scope: {
      kind: "git_worktree",
      root,
      coverage: "tracked_and_untracked_nonignored",
    },
    outcome: "indeterminate",
    observedAt: new Date().toISOString(),
    reasonCode,
  };
}

export function workspaceDeltaResultData(
  receipt: WorkspaceDeltaReceipt | undefined,
): Record<string, unknown> {
  return receipt ? { [WORKSPACE_DELTA_RECEIPT_DATA_KEY]: receipt } : {};
}
