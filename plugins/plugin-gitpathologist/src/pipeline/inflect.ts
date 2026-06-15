/**
 * Step 4 — inflect: find peaks and drift onsets in the health timeline.
 *
 * Peak = local maximum of the EMA score over a small window. We require the
 * point to dominate its neighbours strictly on both sides and to be at least
 * PEAK_MIN above zero — otherwise everything is a "peak" in flat early history.
 *
 * Drift onset = a commit i where the average score over the next WINDOW
 * commits is at least DRIFT_DROP below the score at i. The point itself is
 * the inflection; subsequent commits realize the decline.
 *
 * Both lists are sorted by absolute significance and capped.
 */

import type { CommitHealthPoint, InflectionPoint } from "../types.ts";

const PEAK_WINDOW = 2;
const PEAK_MIN_SCORE = 0.05;
const PEAK_LIMIT = 5;

const DRIFT_WINDOW = 5;
const DRIFT_DROP = 0.25;
const DRIFT_LIMIT = 5;

function toInflection(point: CommitHealthPoint, reason: string): InflectionPoint {
  return {
    sha: point.sha,
    date: point.date,
    author: point.author,
    score: point.score,
    delta: point.delta,
    reasonShort: reason,
  };
}

function reasonForPeak(point: CommitHealthPoint): string {
  const parts: string[] = [];
  if (point.type === "feature") parts.push("feature landed");
  else if (point.type === "refactor") parts.push("clean refactor");
  else if (point.type === "fix") parts.push("targeted fix");
  else parts.push(`${point.type} commit`);
  if (point.riskFlags.includes("large-churn") === false && point.churn < 200) {
    parts.push("low churn");
  }
  if (point.delta > 0.4) parts.push("strong delta");
  return parts.join(", ") || "local maximum";
}

function reasonForDrift(point: CommitHealthPoint, avgAfter: number): string {
  const drop = (point.score - avgAfter).toFixed(2);
  const flags = point.riskFlags.length > 0 ? ` flags=${point.riskFlags.join("|")}` : "";
  return `score drops ${drop} over next ${DRIFT_WINDOW} commits${flags}`;
}

function avg(points: CommitHealthPoint[], from: number, count: number): number {
  let sum = 0;
  let taken = 0;
  for (let i = from; i < points.length && taken < count; i++) {
    const p = points[i];
    if (!p) continue;
    sum += p.score;
    taken += 1;
  }
  return taken === 0 ? 0 : sum / taken;
}

export function findInflections(points: CommitHealthPoint[]): {
  peaks: InflectionPoint[];
  drifts: InflectionPoint[];
} {
  const peaks: InflectionPoint[] = [];
  const drifts: InflectionPoint[] = [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    if (point.score < PEAK_MIN_SCORE) continue;
    const window = points.slice(Math.max(0, i - PEAK_WINDOW), i + PEAK_WINDOW + 1);
    // Peak = max-in-window with at least one strictly lower neighbour. On
    // plateaus we keep the first occurrence: subsequent identical scores
    // are rejected because they tie with the earlier (already-picked) peak.
    const isMaxInWindow = window.every((p) => p.score <= point.score);
    const hasStrictlyLessNeighbour = window.some((p) => p.score < point.score);
    if (!isMaxInWindow || !hasStrictlyLessNeighbour) continue;
    // Reject a tied score within the same window — we already picked an
    // earlier peak with the same score, so this one would be a duplicate.
    const tiedEarlier = peaks.some((existing) => {
      const prevIdx = points.findIndex((p) => p.sha === existing.sha);
      return prevIdx >= 0 && prevIdx >= i - PEAK_WINDOW && existing.score === point.score;
    });
    if (tiedEarlier) continue;
    peaks.push(toInflection(point, reasonForPeak(point)));
  }

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    if (i + DRIFT_WINDOW >= points.length) break;
    const after = avg(points, i + 1, DRIFT_WINDOW);
    const drop = point.score - after;
    if (drop >= DRIFT_DROP) {
      drifts.push(toInflection(point, reasonForDrift(point, after)));
    }
  }

  peaks.sort((a, b) => b.score - a.score);
  drifts.sort((a, b) => b.score - b.delta - (a.score - a.delta));

  return {
    peaks: peaks.slice(0, PEAK_LIMIT),
    drifts: drifts.slice(0, DRIFT_LIMIT),
  };
}
