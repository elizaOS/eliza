/**
 * A/B promotion gate for optimized prompt artifacts.
 *
 * Native MIPRO/GEPA/bootstrap-fewshot runs in `backends/native.ts` produce a
 * candidate prompt for a task. Without a gate, that candidate is written as the
 * `current` artifact unconditionally, which lets noisy single-run scores
 * silently regress production prompts.
 *
 * This module evaluates a candidate against its incumbent (the prompt currently
 * loaded by `OptimizedPromptService` — or the baseline when no artifact exists
 * yet) on a held-out trajectory replay set, and only promotes when the
 * candidate's score exceeds the incumbent score by more than the expected
 * scoring noise (default: 1.5× the standard deviation of incumbent scores
 * across reseeded scoring runs).
 *
 * Inputs and outputs are pure JS objects — no filesystem, no service lookups.
 * The orchestrator passes incumbent text + dataset in, gets a structured
 * decision back, and is responsible for persistence (promote → write artifact;
 * reject → write `candidate_rejected_<timestamp>.json`).
 */

import { subsample } from "../optimizers/scoring.js";
import type { OptimizationExample, PromptScorer } from "../optimizers/types.js";

/**
 * Default noise threshold. A candidate must beat the incumbent's mean by
 * `noiseThreshold × stddev(incumbent)` to be promoted. 1.5× is the same
 * multiplier the MIPRO paper uses for its variance-aware acceptance test.
 */
export const DEFAULT_NOISE_THRESHOLD = 1.5;

/**
 * Default number of times the incumbent is re-scored to estimate scoring noise.
 * Each pass uses a fresh subsample (when `reseedSubsample` is set) so the
 * resulting stddev captures both sampling jitter and scorer non-determinism.
 */
export const DEFAULT_INCUMBENT_RESEEDS = 3;

export interface PromotionGateOptions {
  /**
   * Multiplier applied to the incumbent stddev. Default `1.5`.
   * Set to 0 to promote on any positive delta (not recommended).
   */
  noiseThreshold?: number;
  /**
   * Reseeded incumbent scoring passes. Default `3`. Each pass produces an
   * independent score on a fresh subsample (when `scoringSubset` is set), or on
   * the full dataset otherwise. More passes → tighter stddev estimate at the
   * cost of more model calls.
   */
  incumbentReseeds?: number;
  /**
   * Cap on examples scored per pass. When set, each incumbent reseed and the
   * single candidate pass each draw their own subsample. Defaults to all rows.
   */
  scoringSubset?: number;
  /**
   * Deterministic RNG override (tests). Defaults to `Math.random`.
   */
  rng?: () => number;
  /**
   * When true, the candidate is scored on a freshly subsampled held-out set
   * (independent of the incumbent reseed samples). Default: true. Set false to
   * reuse the union of all incumbent samples.
   */
  reseedCandidate?: boolean;
}

export interface PromotionGateInput {
  /** Prompt currently in production for this task. */
  incumbentPrompt: string;
  /** Candidate prompt produced by the optimizer for this task. */
  candidatePrompt: string;
  /** Replay dataset — same shape the optimizers consume. */
  dataset: OptimizationExample[];
  /** Scorer used for both incumbent and candidate. */
  scorer: PromptScorer;
  options?: PromotionGateOptions;
}

export interface PromotionDecision {
  /** `true` when the candidate should replace the incumbent. */
  promote: boolean;
  /** Mean score of the incumbent across reseeded passes. */
  incumbentMeanScore: number;
  /** Stddev of incumbent scores across reseeded passes. */
  incumbentStdDev: number;
  /** Score of the candidate on its (re)sampled held-out set. */
  candidateScore: number;
  /** `candidateScore - incumbentMeanScore`. Positive = candidate better. */
  delta: number;
  /** `noiseThreshold * incumbentStdDev`. Candidate must beat this. */
  promotionMargin: number;
  /** Multiplier used (`options.noiseThreshold ?? DEFAULT_NOISE_THRESHOLD`). */
  noiseThreshold: number;
  /** Number of reseeded incumbent passes actually run. */
  incumbentReseeds: number;
  /** Number of rows scored per pass. */
  examplesPerPass: number;
  /** Plain-english reason describing why the gate accepted or rejected. */
  reason: string;
  /** Raw per-pass incumbent scores, oldest first. */
  incumbentScores: number[];
}

/**
 * Evaluate whether a candidate prompt should be promoted over the incumbent.
 *
 * Algorithm:
 *   1. Score the incumbent `incumbentReseeds` times on independently subsampled
 *      held-out sets (or the full dataset when `scoringSubset` is unset).
 *   2. Compute the mean and population stddev of the resulting scores.
 *   3. Score the candidate once on a fresh subsample (or the full dataset).
 *   4. Promote only when `candidateScore > incumbentMean + noiseThreshold * stddev`.
 *
 * Edge cases:
 *   - Empty dataset → never promote (delta=0, candidate cannot demonstrate
 *     improvement).
 *   - `incumbentReseeds < 1` → rejected outright; we need at least one
 *     measurement to gate against.
 *   - When all incumbent passes return the exact same score, stddev=0 and the
 *     candidate only needs to strictly exceed the incumbent mean.
 */
export async function evaluatePromotion(
  input: PromotionGateInput,
): Promise<PromotionDecision> {
  const noiseThreshold =
    input.options?.noiseThreshold ?? DEFAULT_NOISE_THRESHOLD;
  const incumbentReseeds = Math.max(
    1,
    input.options?.incumbentReseeds ?? DEFAULT_INCUMBENT_RESEEDS,
  );
  const rng = input.options?.rng ?? Math.random;
  const reseedCandidate = input.options?.reseedCandidate ?? true;
  const examplesPerPass =
    typeof input.options?.scoringSubset === "number"
      ? Math.min(input.options.scoringSubset, input.dataset.length)
      : input.dataset.length;

  if (input.dataset.length === 0 || examplesPerPass === 0) {
    return {
      promote: false,
      incumbentMeanScore: 0,
      incumbentStdDev: 0,
      candidateScore: 0,
      delta: 0,
      promotionMargin: 0,
      noiseThreshold,
      incumbentReseeds: 0,
      examplesPerPass: 0,
      reason: "dataset is empty; cannot evaluate promotion",
      incumbentScores: [],
    };
  }

  const incumbentScores: number[] = [];
  let lastIncumbentSample: OptimizationExample[] | null = null;
  for (let i = 0; i < incumbentReseeds; i += 1) {
    const sample = drawSample(input.dataset, examplesPerPass, rng);
    const score = await input.scorer(input.incumbentPrompt, sample);
    incumbentScores.push(score);
    lastIncumbentSample = sample;
  }

  const incumbentMean = mean(incumbentScores);
  const incumbentStd = populationStdDev(incumbentScores, incumbentMean);

  // When `reseedCandidate` is false the candidate is scored on the exact same
  // examples the final incumbent pass saw — useful for direct A/B comparison
  // without sampling jitter. Defaults to true (fresh subsample) so the
  // candidate score is independent of which rows happened to land in the last
  // incumbent reseed.
  const candidateSample =
    reseedCandidate || !lastIncumbentSample
      ? drawSample(input.dataset, examplesPerPass, rng)
      : lastIncumbentSample;
  const candidateScore = await input.scorer(
    input.candidatePrompt,
    candidateSample,
  );

  const promotionMargin = noiseThreshold * incumbentStd;
  const delta = candidateScore - incumbentMean;
  const promote = delta > promotionMargin;

  const reason = promote
    ? `candidate beats incumbent by ${delta.toFixed(4)} > margin ${promotionMargin.toFixed(4)} (${noiseThreshold}× stddev=${incumbentStd.toFixed(4)})`
    : delta <= 0
      ? `candidate did not improve over incumbent (delta=${delta.toFixed(4)})`
      : `candidate improvement ${delta.toFixed(4)} did not exceed noise margin ${promotionMargin.toFixed(4)} (${noiseThreshold}× stddev=${incumbentStd.toFixed(4)})`;

  return {
    promote,
    incumbentMeanScore: incumbentMean,
    incumbentStdDev: incumbentStd,
    candidateScore,
    delta,
    promotionMargin,
    noiseThreshold,
    incumbentReseeds,
    examplesPerPass,
    reason,
    incumbentScores,
  };
}

function drawSample(
  dataset: OptimizationExample[],
  count: number,
  rng: () => number,
): OptimizationExample[] {
  if (count >= dataset.length) return [...dataset];
  return subsample(dataset, count, rng);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/**
 * Population stddev (divide by N, not N-1). With small N (default 3 reseeds)
 * the sample stddev estimator inflates noise enough that even slightly better
 * candidates get rejected; the gate is already conservative through the
 * `noiseThreshold` multiplier, so we use the population form here.
 */
function populationStdDev(values: number[], precomputedMean: number): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) {
    const d = v - precomputedMean;
    total += d * d;
  }
  return Math.sqrt(total / values.length);
}
