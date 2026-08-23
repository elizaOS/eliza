/**
 * Captures content-free Git worktree fingerprints around local commands.
 * Snapshot work is bounded by explicit wall-clock, Git-output, and file-byte
 * budgets; exhaustion produces an indeterminate receipt, never a partial hash.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { arch, hostname, platform } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  WORKSPACE_DELTA_RECEIPT_DATA_KEY,
  type WorkspaceDeltaIndeterminateReasonCode,
  type WorkspaceDeltaReceipt,
} from "@elizaos/core";

const execFileAsync = promisify(execFile);
// Observation is diagnostic and fail-closed; it must not consume the command's
// own timeout or turn a prompt shell timeout into multi-second tail latency.
export const WORKSPACE_DELTA_OBSERVATION_TIMEOUT_MS = 900;
export const WORKSPACE_DELTA_FILE_BYTE_BUDGET = 64 * 1024 * 1024;
export const WORKSPACE_DELTA_GIT_OUTPUT_BUDGET = 8 * 1024 * 1024;
const LOCAL_EXECUTION_DOMAIN_ID = createHash("sha256")
  .update("eliza-workspace-execution-domain-v1\0")
  .update(hostname())
  .update("\0")
  .update(platform())
  .update("\0")
  .update(arch())
  .digest("hex");

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
  executionDomainId?: string;
  fs?: Partial<WorkspaceDeltaFs>;
}

interface WorkspaceDeltaFs {
  realpath(value: string): Promise<string>;
  lstat(value: string): Promise<Awaited<ReturnType<typeof fs.lstat>>>;
  readlink(value: string): Promise<string>;
  readdir(value: string): Promise<string[]>;
  createReadStream(value: string): ReturnType<typeof createReadStream>;
}

interface ObservationLimits {
  maxObservationMs: number;
  maxFileBytes: number;
  maxGitOutputBytes: number;
  now: () => number;
  executionDomainId: string;
  fs: WorkspaceDeltaFs;
}

interface SnapshotBudget {
  deadline: number;
  remainingFileBytes: number;
  remainingGitOutputBytes: number;
  now: () => number;
  fs: WorkspaceDeltaFs;
}

export interface LocalWorkspaceDeltaObservation {
  root: string;
  rootId: string;
  executionDomainId: string;
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
  const fsDependencies = dependencies.fs ?? {};
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
    executionDomainId:
      dependencies.executionDomainId ?? LOCAL_EXECUTION_DOMAIN_ID,
    fs: {
      realpath: fsDependencies.realpath ?? fs.realpath,
      lstat: fsDependencies.lstat ?? fs.lstat,
      readlink: fsDependencies.readlink ?? fs.readlink,
      readdir: fsDependencies.readdir ?? fs.readdir,
      createReadStream: fsDependencies.createReadStream ?? createReadStream,
    },
  };
}

function newBudget(value: ObservationLimits): SnapshotBudget {
  return {
    deadline: value.now() + value.maxObservationMs,
    remainingFileBytes: value.maxFileBytes,
    remainingGitOutputBytes: value.maxGitOutputBytes,
    now: value.now,
    fs: value.fs,
  };
}

function remainingLimits(
  value: ObservationLimits,
  phaseStartedAt: number,
  budget: SnapshotBudget,
): ObservationLimits {
  return {
    ...value,
    maxObservationMs: Math.max(
      1,
      value.maxObservationMs - Math.max(0, value.now() - phaseStartedAt),
    ),
    maxFileBytes: budget.remainingFileBytes,
    maxGitOutputBytes: budget.remainingGitOutputBytes,
  };
}

function assertTime(budget: SnapshotBudget): void {
  if (budget.now() > budget.deadline) {
    throw new ObservationBudgetError("OBSERVATION_TIME_BUDGET_EXCEEDED");
  }
}

async function withinDeadline<T>(
  operation: Promise<T>,
  budget: SnapshotBudget,
  abort?: () => void,
): Promise<T> {
  // error-policy:J5 The promise may already be running when a synthetic/test
  // clock exhausts the budget here; the race observes its authoritative
  // rejection, while this handler suppresses only a later duplicate rejection.
  void operation.catch(() => undefined);
  assertTime(budget);
  const remainingMs = budget.deadline - budget.now();
  if (remainingMs <= 0) {
    abort?.();
    throw new ObservationBudgetError("OBSERVATION_TIME_BUDGET_EXCEEDED");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort?.();
          reject(
            new ObservationBudgetError("OBSERVATION_TIME_BUDGET_EXCEEDED"),
          );
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workspaceRootId(executionDomainId: string, root: string): string {
  return createHash("sha256")
    .update("eliza-workspace-root-v1\0")
    .update(executionDomainId)
    .update("\0")
    .update(root)
    .digest("hex");
}

export function unattestedRemoteWorkspaceScope(root: string): {
  root: string;
  rootId: string;
  executionDomainId: string;
} {
  const executionDomainId = createHash("sha256")
    .update("eliza-unattested-remote-execution-domain-v1")
    .digest("hex");
  return {
    root,
    rootId: workspaceRootId(executionDomainId, root),
    executionDomainId,
  };
}

async function budgetedGit(
  runGit: GitRunner,
  cwd: string,
  args: string[],
  budget: SnapshotBudget,
): Promise<string> {
  assertTime(budget);
  if (budget.remainingGitOutputBytes <= 0) {
    throw new ObservationBudgetError("OBSERVATION_OUTPUT_BUDGET_EXCEEDED");
  }
  const remainingMs = Math.max(1, budget.deadline - budget.now());
  let output: string;
  try {
    output = await withinDeadline(
      runGit(cwd, args, {
        timeoutMs: remainingMs,
        maxOutputBytes: Math.max(1, budget.remainingGitOutputBytes),
      }),
      budget,
    );
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
  const stream = budget.fs.createReadStream(absolute);
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await withinDeadline(iterator.next(), budget, () =>
        stream.destroy(),
      );
      if (next.done) break;
      const chunk = next.value as Buffer;
      assertTime(budget);
      const bytes = chunk.byteLength;
      if (bytes > budget.remainingFileBytes) {
        throw new ObservationBudgetError("OBSERVATION_BYTE_BUDGET_EXCEEDED");
      }
      budget.remainingFileBytes -= bytes;
      hash.update(chunk);
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
    const stat = await withinDeadline(budget.fs.lstat(absolute), budget);
    const hash = createHash("sha256");
    hash.update(
      `${stat.mode}:${stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other"}\0`,
    );
    if (stat.isFile()) await hashFileBounded(absolute, hash, budget);
    else if (stat.isSymbolicLink()) {
      hash.update(await withinDeadline(budget.fs.readlink(absolute), budget));
    } else if (stat.isDirectory()) {
      const entries = (
        await withinDeadline(budget.fs.readdir(absolute), budget)
      ).sort((a, b) => a.localeCompare(b));
      for (const entry of entries) {
        const child = path.posix.join(
          relative.split(path.sep).join("/"),
          entry,
        );
        hash.update("\0entry\0");
        hash.update(entry);
        hash.update("\0");
        hash.update(await pathFingerprint(root, child, budget));
      }
    } else hash.update(`${stat.size}:${stat.mtimeMs}`);
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
  const gitExit = (error: unknown) => {
    const value = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };
    return {
      code:
        typeof value.code === "number"
          ? value.code
          : typeof value.code === "string" && /^\d+$/.test(value.code)
            ? Number(value.code)
            : undefined,
      stderr: typeof value.stderr === "string" ? value.stderr.trim() : "",
      stdout: typeof value.stdout === "string" ? value.stdout.trim() : "",
    };
  };
  const expectedMissingHead = (error: unknown) => {
    const failure = gitExit(error);
    return (
      failure.code === 128 &&
      /^(?:fatal: )?Needed a single revision$/.test(failure.stderr) &&
      failure.stdout.length === 0
    );
  };
  const expectedDetachedHead = (error: unknown) => {
    const failure = gitExit(error);
    return (
      failure.code === 1 &&
      failure.stderr.length === 0 &&
      failure.stdout.length === 0
    );
  };
  const headCap = Math.ceil(budget.remainingGitOutputBytes / 2);
  const refCap = budget.remainingGitOutputBytes - headCap;
  const headBudget = { ...budget, remainingGitOutputBytes: headCap };
  const refBudget = { ...budget, remainingGitOutputBytes: refCap };
  const [headResult, refResult] = await Promise.allSettled([
    budgetedGit(runGit, root, ["rev-parse", "--verify", "HEAD"], headBudget),
    budgetedGit(runGit, root, ["symbolic-ref", "--quiet", "HEAD"], refBudget),
  ]);
  budget.remainingGitOutputBytes -=
    headCap -
    headBudget.remainingGitOutputBytes +
    (refCap - refBudget.remainingGitOutputBytes);
  if (headResult.status === "fulfilled") {
    if (refResult.status === "fulfilled") {
      return `commit:${headResult.value.trim()}:ref:${refResult.value.trim()}`;
    }
    if (refResult.reason instanceof ObservationBudgetError)
      throw refResult.reason;
    if (!expectedDetachedHead(refResult.reason)) throw refResult.reason;
    return `commit:${headResult.value.trim()}:ref:detached`;
  }
  if (headResult.reason instanceof ObservationBudgetError)
    throw headResult.reason;
  if (!expectedMissingHead(headResult.reason)) throw headResult.reason;
  if (refResult.status === "rejected") throw refResult.reason;
  const headRef = refResult.value.trim();
  if (!headRef) throw headResult.reason;
  return `unborn:${headRef}`;
}

async function captureAtRoot(
  root: string,
  runGit: GitRunner,
  budget: SnapshotBudget,
  seenRoots = new Set<string>(),
): Promise<GitWorkspaceSnapshot> {
  const canonicalRoot = await withinDeadline(budget.fs.realpath(root), budget);
  if (seenRoots.has(canonicalRoot)) {
    throw new Error("Recursive Git worktree topology detected.");
  }
  seenRoots.add(canonicalRoot);
  try {
    // Reserve disjoint output allowances before parallel dispatch. Their sum
    // never exceeds the aggregate budget, while independent Git reads avoid
    // adding four process latencies to every foreground shell command.
    const totalGitBudget = budget.remainingGitOutputBytes;
    const headCap = Math.min(8 * 1024, totalGitBudget);
    const afterHead = totalGitBudget - headCap;
    const indexCap = Math.floor(afterHead / 2);
    const trackedCap = Math.floor((afterHead - indexCap) / 2);
    const untrackedCap = afterHead - indexCap - trackedCap;
    const childBudget = (remainingGitOutputBytes: number): SnapshotBudget => ({
      ...budget,
      remainingGitOutputBytes,
    });
    const headBudget = childBudget(headCap);
    const indexBudget = childBudget(indexCap);
    const trackedBudget = childBudget(trackedCap);
    const untrackedBudget = childBudget(untrackedCap);
    const probeResults = await Promise.allSettled([
      headIdentity(canonicalRoot, runGit, headBudget),
      budgetedGit(
        runGit,
        canonicalRoot,
        ["ls-files", "--stage", "-v", "-z"],
        indexBudget,
      ),
      budgetedGit(
        runGit,
        canonicalRoot,
        ["diff-files", "--name-only", "-z", "--ignore-submodules=none", "--"],
        trackedBudget,
      ),
      budgetedGit(
        runGit,
        canonicalRoot,
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
        untrackedBudget,
      ),
    ]);
    const rejectedProbe = probeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedProbe) throw rejectedProbe.reason;
    const [head, index, trackedChanges, untracked] = probeResults.map(
      (result) => (result as PromiseFulfilledResult<string>).value,
    );
    budget.remainingGitOutputBytes -=
      headCap -
      headBudget.remainingGitOutputBytes +
      (indexCap - indexBudget.remainingGitOutputBytes) +
      (trackedCap - trackedBudget.remainingGitOutputBytes) +
      (untrackedCap - untrackedBudget.remainingGitOutputBytes);
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
        const stat = await withinDeadline(budget.fs.lstat(absolute), budget);
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
  let current = await withinDeadline(budget.fs.realpath(cwd), budget);
  while (true) {
    assertTime(budget);
    try {
      const marker = await withinDeadline(
        budget.fs.lstat(path.join(current, ".git")),
        budget,
      );
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
        const realRoot = cwd;
        return {
          root: realRoot,
          rootId: workspaceRootId(
            observationLimits.executionDomainId,
            realRoot,
          ),
          executionDomainId: observationLimits.executionDomainId,
          baselineFailure: fallbackError.reasonCode,
          runGit,
          limits: remainingLimits(observationLimits, phaseStartedAt, budget),
        };
      }
      return undefined;
    }
    if (error instanceof ObservationBudgetError) {
      const failedRoot = markerRoot ?? cwd;
      return {
        root: failedRoot,
        rootId: workspaceRootId(
          observationLimits.executionDomainId,
          failedRoot,
        ),
        executionDomainId: observationLimits.executionDomainId,
        baselineFailure: error.reasonCode,
        runGit,
        limits: remainingLimits(observationLimits, phaseStartedAt, budget),
      };
    }
    if (markerRoot) {
      return {
        root: markerRoot,
        rootId: workspaceRootId(
          observationLimits.executionDomainId,
          markerRoot,
        ),
        executionDomainId: observationLimits.executionDomainId,
        probeFailure: true,
        runGit,
        limits: remainingLimits(observationLimits, phaseStartedAt, budget),
      };
    }
    return undefined;
  }
  if (!root) return undefined;
  try {
    const canonicalRoot = await withinDeadline(
      observationLimits.fs.realpath(root),
      budget,
    );
    return {
      root: canonicalRoot,
      rootId: workspaceRootId(
        observationLimits.executionDomainId,
        canonicalRoot,
      ),
      executionDomainId: observationLimits.executionDomainId,
      before: await captureAtRoot(canonicalRoot, runGit, budget),
      runGit,
      limits: remainingLimits(observationLimits, phaseStartedAt, budget),
    };
  } catch (error) {
    const failedRoot = root;
    return {
      root: failedRoot,
      rootId: workspaceRootId(observationLimits.executionDomainId, failedRoot),
      executionDomainId: observationLimits.executionDomainId,
      baselineFailure: failureReason(error, "BASELINE_SNAPSHOT_FAILED"),
      runGit,
      limits: remainingLimits(observationLimits, phaseStartedAt, budget),
    };
  }
}

export async function finishLocalWorkspaceDeltaObservation(
  observation: LocalWorkspaceDeltaObservation | undefined,
  backgroundHandle?: string,
): Promise<WorkspaceDeltaReceipt | undefined> {
  if (!observation) return undefined;
  const base = {
    version: 1 as const,
    kind: "workspace_delta" as const,
    scope: {
      kind: "git_worktree" as const,
      root: observation.root,
      rootId: observation.rootId,
      executionDomainId: observation.executionDomainId,
      coverage: "tracked_and_untracked_nonignored" as const,
    },
    ...(backgroundHandle
      ? {
          operation: {
            kind: "background_shell" as const,
            handle: backgroundHandle,
          },
        }
      : {}),
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
  scope: {
    root: string;
    rootId: string;
    executionDomainId: string;
  },
  reasonCode: WorkspaceDeltaIndeterminateReasonCode,
  backgroundHandle?: string,
): WorkspaceDeltaReceipt {
  return {
    version: 1,
    kind: "workspace_delta",
    scope: {
      kind: "git_worktree",
      ...scope,
      coverage: "tracked_and_untracked_nonignored",
    },
    ...(backgroundHandle
      ? {
          operation: {
            kind: "background_shell" as const,
            handle: backgroundHandle,
          },
        }
      : {}),
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
