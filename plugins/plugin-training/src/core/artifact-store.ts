/**
 * Filesystem helpers around the `OptimizedPromptService` store.
 *
 * Two responsibilities, both intentionally separate from the strict per-task
 * artifact loader in `packages/core/src/services/optimized-prompt.ts`:
 *
 *   1. Persist `candidate_rejected_<timestamp>.json` files for runs the
 *      promotion gate refused. These live under `<task>/rejected/` so the
 *      strict artifact parser never picks them up at boot.
 *   2. Prune the per-task directory to the most recent N promoted artifacts.
 *      Older `.json` files are removed so a long-running deployment doesn't
 *      accumulate unbounded history. The pruning is rollback-friendly: when
 *      operators want to revert, they pick from the retained N files.
 *
 * Both helpers operate on file mtime/timestamp, never on the artifact contents.
 * The strict parser owns content validation; this module is filesystem-only.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Maximum number of promoted artifacts retained per task. Older files are
 * deleted by `prunePromotedArtifacts`. Keeping 5 lines up with the W1-P3
 * rollback budget (one current + four historical fallbacks).
 */
export const DEFAULT_PROMOTED_ARTIFACT_RETENTION = 5;

/** Subdirectory under `<storeRoot>/<task>/` for rejected candidates. */
export const REJECTED_DIRNAME = "rejected";

export interface RejectedCandidatePayload {
  /** ISO-8601 timestamp of when the candidate was rejected. */
  rejectedAt: string;
  /** Task the rejected candidate targeted. */
  task: string;
  /** Optimizer name that produced the candidate. */
  optimizer: string;
  /** The candidate prompt body that did not clear the gate. */
  candidatePrompt: string;
  /** Incumbent prompt body the gate evaluated against. */
  incumbentPrompt: string;
  /** Score / margin block from the promotion gate. */
  scores: {
    incumbentMeanScore: number;
    incumbentStdDev: number;
    candidateScore: number;
    delta: number;
    promotionMargin: number;
    noiseThreshold: number;
    incumbentReseeds: number;
    examplesPerPass: number;
    incumbentScores: number[];
  };
  /** Plain-english reason from the promotion gate. */
  reason: string;
  /** Backreference to the dataset that drove the run. */
  datasetId: string;
  /** Backreference to the run id from the training orchestrator. */
  runId?: string;
}

/**
 * Write a `candidate_rejected_<timestamp>.json` file under
 * `<storeRoot>/<task>/rejected/`. Atomic (temp + rename). Returns the final
 * path. The parent directory is created if missing.
 */
export async function writeRejectedCandidate(
  storeRoot: string,
  task: string,
  payload: RejectedCandidatePayload,
): Promise<string> {
  const dir = join(storeRoot, task, REJECTED_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const stamp = payload.rejectedAt.replace(/[^0-9]/g, "");
  const finalPath = join(dir, `candidate_rejected_${stamp}.json`);
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(tempPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await rename(tempPath, finalPath);
  return finalPath;
}

/**
 * Delete promoted artifacts older than the most recent `retain` (by mtime).
 * Only `.json` files at the top level of `<storeRoot>/<task>/` are considered;
 * the `rejected/` subdirectory is left alone.
 *
 * Returns the list of removed paths. No-op when fewer than `retain` files
 * exist. Errors during stat/unlink propagate — the caller decides whether to
 * fail the whole run.
 */
export async function prunePromotedArtifacts(
  storeRoot: string,
  task: string,
  retain: number = DEFAULT_PROMOTED_ARTIFACT_RETENTION,
): Promise<string[]> {
  if (retain < 1) {
    throw new Error(
      `[artifact-store] prunePromotedArtifacts retain must be >= 1; got ${retain}`,
    );
  }
  const dir = join(storeRoot, task);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const jsonFiles = entries.filter((name) => name.endsWith(".json"));
  if (jsonFiles.length <= retain) return [];
  // Sort by mtime descending so the newest files are first; we delete the tail.
  const withStats: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of jsonFiles) {
    const path = join(dir, name);
    const stats = await stat(path);
    withStats.push({ path, mtimeMs: stats.mtimeMs });
  }
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = withStats.slice(retain);
  const removed: string[] = [];
  for (const entry of toRemove) {
    await unlink(entry.path);
    removed.push(entry.path);
  }
  return removed;
}
