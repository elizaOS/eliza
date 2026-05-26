/**
 * Phase 3 — score: per-commit health delta + running EMA.
 *
 * Deterministic. The goal is a stable, explainable score that a human can
 * sanity-check against the actual history. No LLM.
 *
 * Formula sketch (all components small, bounded):
 *   delta = baseScore(type)
 *         - churnPenalty            (log10 of total lines, capped)
 *         - filesPenalty            (5% per file, capped at 0.5)
 *         - wipPenalty              (-0.3 if subject signals WIP/fixup)
 *         - revertProximityPenalty  (-0.5 on the commit that gets reverted within window)
 *         + testBonus               (+0.2 if any file touches a test path)
 *
 * EMA: score_i = alpha * delta_i + (1 - alpha) * score_{i-1},  alpha = 0.3.
 *
 * The timeline is processed CHRONOLOGICALLY (oldest first). `git log` returns
 * newest-first; the caller reverses before scoring.
 */

import type { ClassifiedCommit, CommitHealthPoint, CommitType } from "../types.ts";

const ALPHA = 0.3;
const REVERT_LOOKBACK = 7;

const BASE: Record<CommitType, number> = {
  feature: 0.5,
  refactor: 0.4,
  fix: 0.2,
  chore: 0.1,
  merge: 0.0,
  other: 0.0,
  wip: -0.3,
  revert: -0.5,
};

const TEST_PATH_RE = /(?:^|\/)(__tests__|tests?)\/|\.(?:test|spec)\.[jt]sx?$/i;
const REVERT_SHA_RE = /\b([0-9a-f]{7,40})\b/i;

/**
 * Free under 100 lines (normal commit size), log-scaled penalty above that.
 * Examples:
 *   100 lines → 0       500 lines → 0.28
 *  1000 lines → 0.40  10000 lines → 0.80
 * Capped at 1.2 so a single catastrophic commit cannot overwhelm the EMA.
 */
function churnPenalty(churn: number): number {
  if (churn <= 100) return 0;
  const value = Math.log10(churn / 100) * 0.4;
  return Math.min(value, 1.2);
}

function filesPenalty(count: number): number {
  return Math.min(count * 0.05, 0.5);
}

function testBonus(commit: ClassifiedCommit): number {
  return commit.files.some((f) => TEST_PATH_RE.test(f.path)) ? 0.2 : 0;
}

function wipPenalty(commit: ClassifiedCommit): number {
  return commit.riskFlags.includes("wip-message") ? 0.3 : 0;
}

function findRevertTarget(commit: ClassifiedCommit, byShortSha: Map<string, number>): number | null {
  if (commit.type !== "revert") return null;
  const match = commit.body.match(REVERT_SHA_RE) ?? commit.subject.match(REVERT_SHA_RE);
  if (!match) return null;
  const sha = (match[1] ?? "").toLowerCase();
  const short = sha.slice(0, 7);
  const idx = byShortSha.get(short);
  return typeof idx === "number" ? idx : null;
}

export function score(commits: ClassifiedCommit[]): CommitHealthPoint[] {
  const points: CommitHealthPoint[] = [];
  const byShortSha = new Map<string, number>();
  let running = 0;

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!commit) continue;
    const churn = commit.files.reduce((acc, f) => acc + f.added + f.deleted, 0);
    const base = BASE[commit.type];
    const delta =
      base
      - churnPenalty(churn)
      - filesPenalty(commit.files.length)
      - wipPenalty(commit)
      + testBonus(commit);
    running = ALPHA * delta + (1 - ALPHA) * running;
    points.push({ ...commit, delta, score: running, churn });
    byShortSha.set(commit.sha.slice(0, 7), i);
  }

  // Apply revert-proximity penalty by mutating the reverted commit's score and
  // re-rolling the EMA forward from that point.
  let needsRecompute = false;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    const targetIdx = findRevertTarget(point, byShortSha);
    if (targetIdx === null) continue;
    const distance = i - targetIdx;
    if (distance <= 0 || distance > REVERT_LOOKBACK) continue;
    const target = points[targetIdx];
    if (!target) continue;
    target.delta -= 0.5;
    target.riskFlags = [...target.riskFlags, "later-reverted"];
    needsRecompute = true;
  }
  if (needsRecompute) {
    running = 0;
    for (const point of points) {
      running = ALPHA * point.delta + (1 - ALPHA) * running;
      point.score = running;
    }
  }

  return points;
}
