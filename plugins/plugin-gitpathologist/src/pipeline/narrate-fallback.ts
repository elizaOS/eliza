/**
 * Deterministic narration fallback. Kept in its own module so it has zero
 * dependency on @elizaos/core — usable from the dogfood script and from any
 * caller that doesn't want to pull the agent runtime.
 */

import type { CommitHealthPoint, InflectionPoint, RotCategory, RotCause } from "../types.ts";

export interface FallbackContext {
  timeline: CommitHealthPoint[];
  drifts: InflectionPoint[];
}

export function buildFallbackCauses(ctx: FallbackContext): RotCause[] {
  const indexBySha = new Map<string, number>(
    ctx.timeline.map((point, idx) => [point.sha, idx]),
  );
  const causes: RotCause[] = [];
  for (const drift of ctx.drifts) {
    const idx = indexBySha.get(drift.sha);
    if (idx === undefined) continue;
    const point = ctx.timeline[idx];
    if (!point) continue;
    const before = ctx.timeline.slice(Math.max(0, idx - 3), idx);
    const after = ctx.timeline.slice(idx + 1, idx + 4);
    causes.push(fallbackRotCause(point, before, after));
  }
  return causes;
}

export function fallbackRotCause(
  point: CommitHealthPoint,
  before: CommitHealthPoint[],
  after: CommitHealthPoint[],
): RotCause {
  const category = categoryFromFlags(point);
  const churn = point.churn;
  const flagSummary = point.riskFlags.length > 0 ? point.riskFlags.join(", ") : "no specific flags";
  const last = after.length > 0 ? after[after.length - 1] : null;
  const narrative =
    `Heuristic match (no LLM). Commit ${point.sha.slice(0, 7)} (${point.type}) ` +
    `touched ${point.files.length} files with ${churn} lines of churn and triggered ${flagSummary}. ` +
    `Following ${after.length} commits drifted toward lower health, suggesting ${category}.`;
  return {
    shaRange: [point.sha, last ? last.sha : point.sha],
    category,
    evidence: [...before.map((p) => p.sha), point.sha, ...after.map((p) => p.sha)],
    narrative,
  };
}

export function categoryFromFlags(point: CommitHealthPoint): RotCategory {
  if (point.riskFlags.includes("later-reverted")) return "revert-cycle";
  if (point.type === "merge" && point.churn >= 200) return "bad-merge";
  if (point.riskFlags.includes("wip-message")) return "rushed-fix";
  if (point.riskFlags.includes("wide-blast")) return "scope-creep";
  if (point.riskFlags.includes("large-churn")) return "churn-spiral";
  return "other";
}
