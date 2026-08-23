/**
 * Local Git workspace fingerprinting for the foreground SHELL attestation
 * receipt. `captureWorkspaceBaseline` snapshots the worktree containing the
 * SHELL cwd immediately before execution and `resolveWorkspaceDeltaReceipt`
 * re-snapshots afterwards, reducing the pair to a typed, content-free
 * `WorkspaceDeltaReceipt` (changed / unchanged / indeterminate).
 *
 * The fingerprint covers HEAD, the porcelain-v2 status (which encodes index
 * identity relative to HEAD, so staging and clean-to-clean commit or checkout
 * changes are visible), and the byte contents of worktree-dirty tracked files
 * plus non-ignored untracked files — the one dimension status output cannot
 * distinguish when a file is dirty both before and after. Observation is
 * strictly local and read-only: git runs with `--no-optional-locks`, never
 * through the capability router, and every failure degrades to an explicit
 * `indeterminate` receipt instead of throwing out of the SHELL handler.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceDeltaIndeterminateReason,
  WorkspaceDeltaReceipt,
} from "@elizaos/core";
import { WORKSPACE_DELTA_RECEIPT_VERSION } from "@elizaos/core";

const execFileAsync = promisify(execFile);

// One git invocation must never consume a meaningful share of the SHELL turn
// budget; a probe that cannot answer in this window yields `indeterminate`.
const GIT_PROBE_TIMEOUT_MS = 10_000;

// Status output for pathological worktrees (hundreds of thousands of entries)
// stays well under this; exceeding it aborts the capture as unobservable.
const GIT_PROBE_MAX_BUFFER = 64 * 1024 * 1024;

export type WorkspaceBaseline =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: WorkspaceDeltaIndeterminateReason };

type CaptureFailure = "not_a_git_worktree" | "git_unavailable" | "failed";

class WorkspaceCaptureError extends Error {
  readonly kind: CaptureFailure;

  constructor(kind: CaptureFailure, message: string) {
    super(message);
    this.name = "WorkspaceCaptureError";
    this.kind = kind;
  }
}

async function runGitProbe(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
        env: gitProbeEnv(),
      },
    );
    return result.stdout;
  } catch (error) {
    // error-policy:J2 context-adding rethrow; spawn/exit failures become a
    // typed capture error so the caller can map them onto the receipt's
    // indeterminate reasons instead of leaking through the SHELL handler.
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new WorkspaceCaptureError("git_unavailable", err.message);
    }
    throw new WorkspaceCaptureError(
      "failed",
      err.stderr?.trim() || err.message,
    );
  }
}

/**
 * Environment overrides like GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would
 * make the probe observe a different repository than the one containing the
 * SHELL cwd; strip them so the receipt always describes the cwd's worktree.
 */
function gitProbeEnv(): NodeJS.ProcessEnv {
  const {
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_INDEX_FILE: _gitIndexFile,
    GIT_OBJECT_DIRECTORY: _gitObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _gitAlternates,
    ...rest
  } = process.env;
  return rest;
}

async function resolveWorktreeRoot(cwd: string): Promise<string> {
  try {
    const stdout = await runGitProbe(cwd, ["rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    if (!root) {
      throw new WorkspaceCaptureError(
        "not_a_git_worktree",
        "git rev-parse returned no worktree root",
      );
    }
    return root;
  } catch (error) {
    // error-policy:J2 context-adding rethrow; a rev-parse failure in an
    // existing directory means "not inside a git worktree" (including bare
    // repos), which the receipt reports as its own indeterminate reason.
    if (
      error instanceof WorkspaceCaptureError &&
      error.kind === "git_unavailable"
    ) {
      throw error;
    }
    throw new WorkspaceCaptureError(
      "not_a_git_worktree",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function headIdentity(root: string): Promise<string> {
  try {
    const stdout = await runGitProbe(root, ["rev-parse", "--verify", "HEAD"]);
    return stdout.trim();
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing; an unborn branch (fresh
    // `git init`) has no HEAD commit — represent that state explicitly
    // rather than failing the whole capture.
    if (
      error instanceof WorkspaceCaptureError &&
      error.kind === "git_unavailable"
    ) {
      throw error;
    }
    return "UNBORN";
  }
}

interface StatusSnapshot {
  raw: string;
  contentPaths: string[];
}

/**
 * Parses `git status --porcelain=v2 -z -uall --no-renames` output. The raw
 * output already fingerprints HEAD/index/worktree *state* transitions; the
 * returned `contentPaths` are the entries whose worktree bytes must be hashed
 * because status alone cannot see dirty-to-dirty or untracked content edits.
 */
function parseStatusSnapshot(raw: string): StatusSnapshot {
  const contentPaths: string[] = [];
  const records = raw.split("\0");
  for (const record of records) {
    if (!record) continue;
    const kind = record[0];
    if (kind === "?") {
      contentPaths.push(record.slice(2));
      continue;
    }
    if (kind === "1" || kind === "u") {
      const fields = record.split(" ");
      const xy = fields[1] ?? "";
      const worktreeState = xy[1] ?? ".";
      // Path is everything after the fixed field prefix: 8 fields for `1`
      // records, 10 for `u` records, then the path (which may contain spaces).
      const fixedFields = kind === "1" ? 8 : 10;
      const pathStart = fields.slice(0, fixedFields).join(" ").length + 1;
      const filePath = record.slice(pathStart);
      // A worktree-side deletion has no content to hash; the status record
      // itself already witnesses it. `u` (unmerged) entries are always
      // content-hashed because their worktree bytes are the conflict state.
      if (kind === "u" || (worktreeState !== "." && worktreeState !== "D")) {
        contentPaths.push(filePath);
      }
    }
  }
  return { raw, contentPaths };
}

/**
 * Hashes one worktree entry without following through to git's object store.
 * Concurrent mutation (a file vanishing between status and hashing) yields a
 * deterministic marker instead of failing the capture: a workspace that is
 * being modified while we observe it will fingerprint differently across the
 * two captures, which is exactly the honest answer.
 */
async function hashWorktreeEntry(
  root: string,
  relativePath: string,
): Promise<string> {
  const absolute = path.join(root, relativePath);
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(absolute);
  } catch {
    // error-policy:J3 untrusted-input sanitizing; the entry vanished between
    // the status listing and the hash — record that state explicitly.
    return "missing";
  }
  if (stats.isSymbolicLink()) {
    try {
      const target = await fs.readlink(absolute);
      return createHash("sha256").update(`link:${target}`).digest("hex");
    } catch {
      // error-policy:J3 untrusted-input sanitizing; unreadable link state is
      // itself part of the fingerprint.
      return "unreadable-link";
    }
  }
  if (!stats.isFile()) {
    return `non-file:${stats.mode.toString(8)}`;
  }
  return new Promise<string>((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolute);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", () => {
      // error-policy:J3 untrusted-input sanitizing; a file that cannot be
      // read (permissions, concurrent unlink) is fingerprinted as that state.
      resolve("unreadable-file");
    });
  });
}

async function captureFingerprint(cwd: string): Promise<string> {
  await assertDirectoryExists(cwd);
  const root = await resolveWorktreeRoot(cwd);
  const head = await headIdentity(root);
  const statusRaw = await runGitProbe(root, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  const snapshot = parseStatusSnapshot(statusRaw);
  const sortedPaths = [...new Set(snapshot.contentPaths)].sort();
  const hash = createHash("sha256");
  hash.update(`head:${head}\0`);
  hash.update(`status:${snapshot.raw}\0`);
  for (const relativePath of sortedPaths) {
    const digest = await hashWorktreeEntry(root, relativePath);
    hash.update(`entry:${relativePath}\0${digest}\0`);
  }
  return hash.digest("hex");
}

async function assertDirectoryExists(cwd: string): Promise<void> {
  try {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new WorkspaceCaptureError("failed", `not a directory: ${cwd}`);
    }
  } catch (error) {
    // error-policy:J2 context-adding rethrow; a missing cwd makes the
    // workspace relationship unobservable and must resolve to indeterminate.
    if (error instanceof WorkspaceCaptureError) throw error;
    throw new WorkspaceCaptureError(
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Snapshots the Git worktree containing `cwd` immediately before a foreground
 * SHELL execution. Never throws: every failure is reported as a typed
 * not-ok baseline that resolves to an `indeterminate` receipt.
 */
export async function captureWorkspaceBaseline(
  cwd: string,
): Promise<WorkspaceBaseline> {
  try {
    return { ok: true, fingerprint: await captureFingerprint(cwd) };
  } catch (error) {
    // error-policy:J4 user-facing degrade; capture failure becomes the
    // explicit indeterminate baseline instead of aborting the SHELL call.
    if (error instanceof WorkspaceCaptureError) {
      return {
        ok: false,
        reason:
          error.kind === "failed" ? "baseline_capture_failed" : error.kind,
      };
    }
    return { ok: false, reason: "baseline_capture_failed" };
  }
}

/**
 * Re-snapshots the workspace after execution and reduces the before/after
 * pair to the typed receipt. Never throws.
 */
export async function resolveWorkspaceDeltaReceipt(
  baseline: WorkspaceBaseline,
  cwd: string,
): Promise<WorkspaceDeltaReceipt> {
  if (!baseline.ok) {
    return {
      version: WORKSPACE_DELTA_RECEIPT_VERSION,
      status: "indeterminate",
      reason: baseline.reason,
    };
  }
  try {
    const after = await captureFingerprint(cwd);
    return {
      version: WORKSPACE_DELTA_RECEIPT_VERSION,
      status: after === baseline.fingerprint ? "unchanged" : "changed",
      beforeFingerprint: baseline.fingerprint,
      afterFingerprint: after,
    };
  } catch (error) {
    // error-policy:J4 user-facing degrade; a post-execution capture failure
    // (including a repo deleted by the command itself) cannot prove either
    // direction, so the receipt is explicitly indeterminate.
    const reason: WorkspaceDeltaIndeterminateReason =
      error instanceof WorkspaceCaptureError && error.kind === "git_unavailable"
        ? "git_unavailable"
        : "post_capture_failed";
    return {
      version: WORKSPACE_DELTA_RECEIPT_VERSION,
      status: "indeterminate",
      reason,
      beforeFingerprint: baseline.fingerprint,
    };
  }
}

/**
 * Builds the receipt for a dispatch failure where it is unknown whether the
 * command executed locally or was routed to a remote capability host; a local
 * fingerprint comparison cannot attest a remote execution, so the receipt is
 * explicitly indeterminate.
 */
export function unknownExecutionRouteReceipt(): WorkspaceDeltaReceipt {
  return {
    version: WORKSPACE_DELTA_RECEIPT_VERSION,
    status: "indeterminate",
    reason: "execution_route_unknown",
  };
}
