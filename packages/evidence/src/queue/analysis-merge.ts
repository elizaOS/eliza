/**
 * Merge one analyzer's result into a subject's `analysis.json`. The runner
 * writes a whole document at once, but the GPU queue worker contributes ONE
 * `gpu`-tier analyzer's result per job, out of band, after the cpu-tier document
 * already exists — so it reads-modify-writes the `results` map keyed by analyzer
 * name. Each write is atomic (temp file + rename) so a certification run reading
 * `analysis.json` mid-stream never sees torn JSON, AND the whole read-modify-
 * write is serialized by a per-subject O_EXCL lockfile: two workers merging two
 * different gpu analyzers for the same subject would otherwise both read the old
 * document and the later rename would silently drop the earlier analyzer's
 * result (temp+rename guards readers, not lost updates across processes).
 *
 * A missing target document is created as a fresh schema-1 doc rather than
 * failing: the worker can legitimately land a gpu result before the cpu pass
 * wrote anything for a newly-captured subject.
 */

import fs from "node:fs";
import path from "node:path";
import type { AnalysisDocument, AnalyzerResult } from "../analyzers/types.ts";
import { EvidenceError } from "../errors.ts";

/** Read an existing analysis document, or start a fresh one for `artifact`. */
function loadOrInit(analysisPath: string, artifact: string): AnalysisDocument {
  let raw: string;
  try {
    raw = fs.readFileSync(analysisPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: 1, artifact, results: {} };
    }
    // error-policy:J2 context-adding rethrow — an unreadable target (perms, I/O)
    // is a real failure the worker must surface, not silently overwrite.
    throw new EvidenceError(
      `cannot read analysis document at ${analysisPath}`,
      {
        code: "ANALYSIS_MERGE_READ_FAILED",
        cause: error,
        context: { analysisPath },
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 corrupt existing document — refuse to merge onto garbage
    // rather than fabricate a fresh doc that would drop prior analyzers' results.
    throw new EvidenceError(
      `analysis document is not valid JSON: ${analysisPath}`,
      { code: "ANALYSIS_MERGE_CORRUPT", cause, context: { analysisPath } },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== 1 ||
    typeof (parsed as { results?: unknown }).results !== "object" ||
    (parsed as { results?: unknown }).results === null
  ) {
    throw new EvidenceError(
      `analysis document has an unexpected shape: ${analysisPath}`,
      { code: "ANALYSIS_MERGE_CORRUPT", context: { analysisPath } },
    );
  }
  return parsed as AnalysisDocument;
}

/**
 * Merge `result` under `analyzerId` into the analysis document at
 * `analysisPath`, creating the document (and its directory) when absent. Returns
 * the written document. The read-modify-write runs under a per-subject lock and
 * the write itself is temp-file + atomic-rename within the same directory, so
 * concurrent readers see either the old or the new document (never a partial
 * one) and concurrent writers never drop each other's analyzer result.
 */
export function mergeAnalyzerResult(params: {
  analysisPath: string;
  artifact: string;
  analyzerId: string;
  result: AnalyzerResult;
}): AnalysisDocument {
  const { analysisPath, artifact, analyzerId, result } = params;
  const dir = path.dirname(analysisPath);
  fs.mkdirSync(dir, { recursive: true });

  return withAnalysisLock(analysisPath, () => {
    const document = loadOrInit(analysisPath, artifact);
    document.results[analyzerId] = result;

    const tmp = path.join(
      dir,
      `.${path.basename(analysisPath)}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(tmp, analysisPath);
    return document;
  });
}

// A merge holds the lock only for one small synchronous read-write, so the
// contention window is tiny; the retry budget is generous enough to serialize a
// burst of workers on one subject, and the staleness break-in keeps a holder
// that crashed mid-merge from wedging the subject forever. STALE < ACQUIRE so a
// dead holder is reclaimed before a live waiter exhausts its budget.
const LOCK_RETRY_MS = 20;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 10_000;

/**
 * Run `fn` while holding an exclusive lock on `<analysisPath>.lock`. Release
 * happens on both the success and error paths (not in a `finally`, so a release
 * fault can never mask fn()'s own error).
 */
function withAnalysisLock<T>(analysisPath: string, fn: () => T): T {
  const lockPath = `${analysisPath}.lock`;
  const fd = acquireLock(lockPath);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    releaseLock(fd, lockPath);
    throw error;
  }
  releaseLock(fd, lockPath);
  return result;
}

/**
 * Close and remove the lockfile. A failed unlink is best-effort teardown: a
 * leaked lockfile is self-healing — the next writer's staleness break-in
 * reclaims it — so it never throws (which would mask a merge error) and never
 * escalates.
 */
function releaseLock(fd: number, lockPath: string): void {
  fs.closeSync(fd);
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    // error-policy:J6 best-effort teardown — ENOENT means a staleness break-in
    // already reclaimed it; any other fault leaves a lockfile the next writer's
    // break-in clears, so swallowing here cannot wedge the subject.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
}

/** Spin on an O_EXCL create until the lock is ours; the create IS the mutex. */
function acquireLock(lockPath: string): number {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    let fd: number;
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY: exactly one racing process creates
      // the file; every other open fails with EEXIST and retries.
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // error-policy:J2 context-adding rethrow — a non-contention fault
        // (perms, ENOSPC) is a real failure the worker must surface.
        throw new EvidenceError(`cannot acquire analysis lock ${lockPath}`, {
          code: "ANALYSIS_LOCK_FAILED",
          cause: error,
          context: { lockPath },
        });
      }
      if (breakStaleLock(lockPath)) continue; // crashed holder reclaimed
      if (Date.now() >= deadline) {
        throw new EvidenceError(
          `timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for analysis lock ${lockPath}`,
          { code: "ANALYSIS_LOCK_TIMEOUT", context: { lockPath } },
        );
      }
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    return fd;
  }
}

/**
 * Remove a lockfile whose holder is gone (mtime older than the stale window).
 * Returns true when the caller should retry the create immediately — either a
 * stale lock was broken or the lock vanished on its own between open and stat.
 */
function breakStaleLock(lockPath: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    // Released between the failed open and the stat: a normal retry wins now.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    // error-policy:J6 best-effort break-in — another waiter unlinked it first;
    // ENOENT is success, anything else is a real fault to surface.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

/** Block this thread for `ms` in a synchronous context without a busy spin. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
