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
 *
 * The lock's exclusivity has to survive its own stale-holder reclamation: a
 * crashed worker leaves a lockfile that later writers must break, and a naive
 * break (stat-then-unlink) is TOCTOU — two waiters can both remove one
 * observed-stale lock, and the second unlink deletes the first's freshly
 * recreated LIVE lock, putting both inside the critical section and losing an
 * analyzer result. Two mechanisms close that window: reclamation is atomic
 * (rename the stale lock aside; exactly one racer wins, the rest see a fresh
 * lock and wait), and every acquire stamps a random nonce into the lockfile
 * that the holder re-reads immediately before committing — if the nonce is gone
 * or changed the holder was broken in, so it aborts the write and retries the
 * whole read-modify-write rather than clobbering the other holder's result.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnalysisDocument, AnalyzerResult } from "../analyzers/types.ts";
import { EvidenceError } from "../errors.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnalysisDocument(value: unknown): value is AnalysisDocument {
  return (
    isRecord(value) &&
    value.schema === 1 &&
    typeof value.artifact === "string" &&
    isRecord(value.results)
  );
}

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
  if (!isAnalysisDocument(parsed)) {
    throw new EvidenceError(
      `analysis document has an unexpected shape: ${analysisPath}`,
      { code: "ANALYSIS_MERGE_CORRUPT", context: { analysisPath } },
    );
  }
  if (parsed.artifact !== artifact) {
    throw new EvidenceError(
      `analysis document describes a different artifact: ${analysisPath}`,
      {
        code: "ANALYSIS_MERGE_ARTIFACT_MISMATCH",
        context: { analysisPath, artifact, existingArtifact: parsed.artifact },
      },
    );
  }
  return parsed;
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
  const lockPath = `${analysisPath}.lock`;

  // Retry the whole acquire + read-modify-write when a stale-lock break-in
  // steals the lock out from under us mid-critical-section. STALE < ACQUIRE, so
  // the deadline that bounds acquisition also bounds this outer retry.
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    const lock = acquireLock(lockPath);
    let broke: boolean;
    try {
      const document = loadOrInit(analysisPath, artifact);
      // Computed own properties preserve analyzer IDs such as "__proto__" on disk.
      document.results = { ...document.results, [analyzerId]: result };

      const tmp = path.join(
        dir,
        `.${path.basename(analysisPath)}.${process.pid}.${Date.now()}.tmp`,
      );
      // Stage the bytes first so the only work between the theft check and the
      // commit is the single atomic rename — the smallest possible window.
      fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);

      // Theft check: if our nonce is no longer the lockfile's, a stale-lock
      // break-in let a second worker into the critical section, so committing
      // now could silently drop its analyzer result. Abort and retry instead.
      if (!lockHeldBy(lockPath, lock.nonce)) {
        try {
          fs.unlinkSync(tmp);
        } catch (error) {
          // error-policy:J6 best-effort teardown — an orphaned temp file is
          // inert and named per-pid+timestamp, so a failed cleanup cannot
          // corrupt the target or wedge a later writer.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        broke = true;
      } else {
        fs.renameSync(tmp, analysisPath);
        releaseHeldLock(lock.fd, lockPath);
        return document;
      }
    } catch (error) {
      // A real merge fault: the lock is still ours, so release it normally.
      releaseHeldLock(lock.fd, lockPath);
      throw error;
    }
    if (broke) {
      // The lockfile now belongs to the thief; close our fd but do NOT unlink,
      // or we would remove the live holder's lock and reopen the same window.
      fs.closeSync(lock.fd);
      if (Date.now() >= deadline) {
        throw new EvidenceError(
          `timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms retrying broken-in analysis lock ${lockPath}`,
          { code: "ANALYSIS_LOCK_TIMEOUT", context: { lockPath } },
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

// A merge holds the lock only for one small synchronous read-write, so the
// contention window is tiny; the retry budget is generous enough to serialize a
// burst of workers on one subject, and the staleness break-in keeps a holder
// that crashed mid-merge from wedging the subject forever. STALE < ACQUIRE so a
// dead holder is reclaimed before a live waiter exhausts its budget.
const LOCK_RETRY_MS = 20;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 10_000;

/** A held lock: the open fd plus the random nonce stamped into the lockfile. */
interface AnalysisLock {
  fd: number;
  nonce: string;
}

/**
 * Close and remove a lockfile we still hold. A failed unlink is best-effort
 * teardown: a leaked lockfile is self-healing — the next writer's staleness
 * break-in reclaims it — so it never throws (which would mask a merge error)
 * and never escalates. Only call this while the lockfile still carries our
 * nonce; a broken-in caller closes its fd without unlinking so it cannot delete
 * the live holder's lock.
 */
function releaseHeldLock(fd: number, lockPath: string): void {
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

/**
 * True when `lockPath` still carries `nonce` — i.e. this acquire has not been
 * broken in. A missing lockfile (a break-in removed ours before recreating)
 * counts as not-held so the caller retries rather than committing.
 */
function lockHeldBy(lockPath: string, nonce: string): boolean {
  let contents: string;
  try {
    contents = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // error-policy:J2 context-adding rethrow — an unreadable lockfile (perms,
    // I/O) is a real fault the worker must surface, not silently treat as held.
    throw new EvidenceError(`cannot read analysis lock ${lockPath}`, {
      code: "ANALYSIS_LOCK_FAILED",
      cause: error,
      context: { lockPath },
    });
  }
  return contents.trimEnd() === nonce;
}

/** Spin on an O_EXCL create until the lock is ours; the create IS the mutex. */
function acquireLock(lockPath: string): AnalysisLock {
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
    // A per-acquire nonce identifies this exact hold. The committer re-reads it
    // before renaming; if it changed, a break-in stole the lock and the write
    // must not proceed. randomUUID makes collisions across retries impossible.
    const nonce = `${process.pid} ${randomUUID()} ${new Date().toISOString()}`;
    fs.writeSync(fd, `${nonce}\n`);
    return { fd, nonce };
  }
}

/**
 * Reclaim a lockfile whose holder is gone (mtime older than the stale window).
 * Returns true when the caller should retry the create immediately — either a
 * stale lock was reclaimed or the lock vanished on its own between open and
 * stat.
 *
 * Reclamation is atomic: rather than unlink the observed-stale path (a TOCTOU
 * that lets two racers both "reclaim" it, the second deleting the first's fresh
 * live lock), rename it aside to a process-unique sidecar. rename moves one
 * inode atomically, so exactly one racer wins; the losers get ENOENT and retry
 * the create, where they meet the winner's fresh lock and wait instead of
 * breaking it. If the file that got renamed turns out to be fresh (a holder
 * recreated it in the stat→rename gap), it is put back untouched so the live
 * holder is never silently evicted.
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

  const sidecar = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(lockPath, sidecar);
  } catch (error) {
    // error-policy:J6 best-effort break-in — another racer already moved or
    // released the stale lock; retry the create (it will wait on any fresh
    // lock). Any non-ENOENT fault is a real error to surface.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new EvidenceError(`cannot reclaim analysis lock ${lockPath}`, {
      code: "ANALYSIS_LOCK_FAILED",
      cause: error,
      context: { lockPath },
    });
  }
  // We won the rename. Confirm the inode we grabbed is still the stale one; if a
  // holder recreated a fresh lock in the stat→rename gap, restore it verbatim.
  let reclaimedMtimeMs: number;
  try {
    reclaimedMtimeMs = fs.statSync(sidecar).mtimeMs;
  } catch {
    return true; // vanished after we moved it: safe to retry the create.
  }
  if (Date.now() - reclaimedMtimeMs <= LOCK_STALE_MS) {
    try {
      fs.renameSync(sidecar, lockPath);
    } catch {
      // error-policy:J6 best-effort restore — a new lock already occupies the
      // path; the committer's nonce re-check is the backstop against any hold
      // this narrow gap could produce.
    }
    return false;
  }
  try {
    fs.unlinkSync(sidecar);
  } catch (error) {
    // error-policy:J6 best-effort teardown — a leftover sidecar is inert.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

/** Block this thread for `ms` in a synchronous context without a busy spin. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
