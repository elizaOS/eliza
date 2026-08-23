/**
 * Captures content-free Git worktree fingerprints around local foreground
 * commands. Only tracked and non-ignored untracked paths participate; the
 * receipt explicitly names that coverage and never claims whole-host capture.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  WORKSPACE_DELTA_RECEIPT_DATA_KEY,
  type WorkspaceDeltaReceipt,
} from "@elizaos/core";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

interface GitWorkspaceSnapshot {
  root: string;
  fingerprint: string;
}

type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface LocalWorkspaceDeltaDependencies {
  /** Test seam for forcing Git probe and snapshot failures. */
  runGit?: GitRunner;
}

export interface LocalWorkspaceDeltaObservation {
  root: string;
  before?: GitWorkspaceSnapshot;
  baselineFailure?: true;
  probeFailure?: true;
  runGit: GitRunner;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  return result.stdout;
}

function pathsFromPorcelain(raw: string): string[] {
  const records = raw.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.add(record.slice(3));
    if (/[RC]/.test(status)) {
      const source = records[index + 1];
      if (source) paths.add(source);
      index += 1;
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function pathFingerprint(
  root: string,
  relative: string,
): Promise<string> {
  const absolute = path.resolve(root, relative);
  const relativeCheck = path.relative(root, absolute);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw new Error("Git reported a path outside its worktree root.");
  }
  try {
    const stat = await fs.lstat(absolute);
    const hash = createHash("sha256");
    hash.update(
      `${stat.mode}:${stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other"}\0`,
    );
    if (stat.isFile()) hash.update(await fs.readFile(absolute));
    else if (stat.isSymbolicLink()) hash.update(await fs.readlink(absolute));
    else hash.update(`${stat.size}:${stat.mtimeMs}`);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function captureAtRoot(
  root: string,
  runGit: GitRunner,
): Promise<GitWorkspaceSnapshot> {
  const [head, headRef, index, raw] = await Promise.all([
    runGit(root, ["rev-parse", "--verify", "HEAD"]),
    runGit(root, ["rev-parse", "--symbolic-full-name", "HEAD"]),
    runGit(root, ["ls-files", "--stage", "-z"]),
    runGit(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
  ]);
  const hash = createHash("sha256");
  hash.update("head\0");
  hash.update(head.trim());
  hash.update("\0head-ref\0");
  hash.update(headRef.trim());
  hash.update("\0index\0");
  hash.update(index);
  hash.update("\0status\0");
  hash.update(raw);
  for (const relative of pathsFromPorcelain(raw)) {
    hash.update("\0");
    hash.update(relative);
    hash.update("\0");
    hash.update(await pathFingerprint(root, relative));
  }
  return { root, fingerprint: hash.digest("hex") };
}

async function findGitMarkerRoot(cwd: string): Promise<string | undefined> {
  let current = await fs.realpath(cwd);
  while (true) {
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

/** Returns undefined when cwd is not inside a Git worktree. */
export async function beginLocalWorkspaceDeltaObservation(
  cwd: string,
  dependencies: LocalWorkspaceDeltaDependencies = {},
): Promise<LocalWorkspaceDeltaObservation | undefined> {
  const runGit = dependencies.runGit ?? git;
  let root: string;
  try {
    root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    // error-policy:J7 a filesystem-confirmed worktree whose Git probe failed is
    // indeterminate. A true non-repository remains outside this receipt's scope.
    let markerRoot: string | undefined;
    try {
      markerRoot = await findGitMarkerRoot(cwd);
    } catch {
      // error-policy:J7 the fallback probe is diagnostic only and must not block
      // execution when the cwd itself cannot be inspected.
      return undefined;
    }
    if (markerRoot) {
      return { root: markerRoot, probeFailure: true, runGit };
    }
    return undefined;
  }
  if (!root) return undefined;
  try {
    return { root, before: await captureAtRoot(root, runGit), runGit };
  } catch {
    // error-policy:J7 observation failure must not kill command execution. The
    // final receipt is indeterminate and cannot masquerade as unchanged.
    return { root, baselineFailure: true, runGit };
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
      reasonCode: "BASELINE_SNAPSHOT_FAILED",
    };
  }
  try {
    const after = await captureAtRoot(observation.root, observation.runGit);
    return {
      ...base,
      outcome:
        after.fingerprint === observation.before.fingerprint
          ? "unchanged"
          : "changed",
      beforeFingerprint: observation.before.fingerprint,
      afterFingerprint: after.fingerprint,
    };
  } catch {
    // error-policy:J7 post-command observation failure is retained as an
    // indeterminate receipt so completion gating fails conservatively.
    return {
      ...base,
      outcome: "indeterminate",
      beforeFingerprint: observation.before.fingerprint,
      reasonCode: "POST_SNAPSHOT_FAILED",
    };
  }
}

export function workspaceDeltaResultData(
  receipt: WorkspaceDeltaReceipt | undefined,
): Record<string, unknown> {
  return receipt ? { [WORKSPACE_DELTA_RECEIPT_DATA_KEY]: receipt } : {};
}
