/**
 * Per-tier retrieval defaults for the action retrieval / RRF system.
 *
 * The Pareto sweep recommends a `topK` and stage-weight profile for each
 * `ModelTier`. Smaller tiers prefer high-precision
 * stages (exact match + BM25) and tighter top-K to keep the action block
 * short; frontier tiers can afford to spread retrieval across more
 * stages with a wider top-K because the planner has the context budget
 * to disambiguate.
 *
 * Values are heuristic / Pareto-driven, not magic — re-run
 * `scripts/lifeops-retrieval-pareto.mjs` against fresh trajectories to
 * recalibrate.
 *
 * Consumers:
 * - `action-retrieval.ts` reads these via `tierOverrides` to apply the
 *   `topK` cap and stage weights at fusion time.
 * - The benchmark runners read these by `MODEL_TIER` and pass them
 *   through to `retrieveActions`.
 */

import { isModelTier, type ModelTier } from "./model-tiers.ts";

/**
 * Canonical retrieval stage names — kept in sync with
 * `@elizaos/core` `RetrievalStageName`. Duplicated here so this package
 * doesn't take a runtime dep on core.
 */
export type RetrievalStageName =
  | "exact"
  | "regex"
  | "keyword"
  | "bm25"
  | "embedding"
  | "contextMatch";

export interface RetrievalTierDefaults {
  /** Final fused-top-K cap. Monotone non-decreasing across tiers. */
  topK: number;
  /**
   * Per-stage RRF weight. Default weight per stage is 1.0 — values >1
   * up-weight that stage, values <1 down-weight. Missing stages default
   * to 1.0.
   */
  stageWeights: Partial<Record<RetrievalStageName, number>>;
}

/**
 * Pareto-derived defaults. Rationale (per
 * `docs/audits/lifeops-2026-05-11/retrieval-pareto.md`):
 *
 * The 2026-05-11 measured Pareto sweep (n=479 LifeOpsBench
 * trajectories replayed through `retrieveActions` with
 * `measurementMode: true`) showed fused recall saturating at
 * K=5 (recall 0.98) — K=8/12/20 each add < 1pp recall. The
 * topK values below pull the tier defaults toward that measured
 * optimum while keeping margin for the embedding + contextMatch
 * stages that the replay couldn't exercise.
 *
 * - `small` — Qwen 0.6B: short context, brittle at long action blocks.
 *   Prefer exact+BM25 (high precision, deterministic). topK=5 keeps the
 *   action block under ~1.5KB. *Matches measured optimum.*
 * - `mid` — Qwen 1.7B: tolerates more candidates but still benefits
 *   from precision-heavy weighting. topK=6 (was 8 heuristic; measured
 *   K=5 saturates).
 * - `large` — Cerebras gpt-oss-120b: long context, embedding ranking
 *   pays off here. Balanced weights, topK=8 (was 12 heuristic;
 *   measured K=5 saturates, +3 margin for embedding/contextMatch).
 * - `frontier` — Opus 4.7: context-rich planner — let it see a wider
 *   slate. topK=12 (was 20 heuristic; reduced based on saturation,
 *   keeps margin for long-tail catalogs the replay didn't sample).
 *
 * Pre-measurement heuristic values (history): small=5 / mid=8 /
 * large=12 / frontier=20. Stage weights are unchanged from the
 * heuristic — the measurement only informed `topK`. Re-run
 * `scripts/lifeops-retrieval-pareto.mjs` against fresh trajectories
 * to recalibrate.
 */
export const RETRIEVAL_DEFAULTS_BY_TIER: Record<
  ModelTier,
  RetrievalTierDefaults
> = {
  small: {
    topK: 5, // measured: K=5 saturates (heuristic was 5; unchanged)
    stageWeights: {
      exact: 1.5,
      regex: 1.3,
      bm25: 1.2,
      keyword: 1.0,
      embedding: 0.7,
      contextMatch: 0.9,
    },
  },
  mid: {
    topK: 6, // measured: K=5 saturates (heuristic was 8)
    stageWeights: {
      exact: 1.4,
      regex: 1.2,
      bm25: 1.15,
      keyword: 1.0,
      embedding: 0.85,
      contextMatch: 1.0,
    },
  },
  large: {
    topK: 8, // measured: K=5 saturates (heuristic was 12)
    stageWeights: {
      exact: 1.2,
      regex: 1.1,
      bm25: 1.0,
      keyword: 1.0,
      embedding: 1.0,
      contextMatch: 1.0,
    },
  },
  frontier: {
    topK: 12, // measured: K=5 saturates (heuristic was 20)
    stageWeights: {
      exact: 1.0,
      regex: 1.0,
      bm25: 1.0,
      keyword: 1.1,
      embedding: 1.2,
      contextMatch: 1.0,
    },
  },
};

/**
 * Resolve retrieval defaults from `MODEL_TIER` (or a passed-in env).
 * Falls back to `large` when the env var is missing/unknown. Mirrors
 * the resolution policy in `resolveTier`.
 */
export function resolveRetrievalDefaults(
  env: NodeJS.ProcessEnv = process.env,
): RetrievalTierDefaults {
  const raw = env.MODEL_TIER?.trim();
  const tier: ModelTier = raw && isModelTier(raw) ? raw : "large";
  // Return a fresh copy so callers can mutate without poisoning the
  // module-level registry.
  const source = RETRIEVAL_DEFAULTS_BY_TIER[tier];
  return {
    topK: source.topK,
    stageWeights: { ...source.stageWeights },
  };
}
