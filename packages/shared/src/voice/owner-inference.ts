/**
 * Owner-candidate inference for voice (#8785).
 *
 * "How does the agent know which speaker is the device OWNER?" Today the owner
 * entity must be enrolled explicitly (the first-run voice flow). But when no
 * owner is set, the agent should still be able to FORM a hypothesis from what it
 * hears — the person who speaks to it most, most confidently, and clearly more
 * than anyone else is the likely owner. This is the pure decision logic a
 * provider/evaluator runs when the owner is unknown: it accumulates recognized
 * voice turns and proposes a candidate only when the evidence is both sufficient
 * (enough confident observations) and unambiguous (a clear lead over the
 * runner-up). Otherwise it stays UNDECIDED — it never guesses an owner from one
 * stray turn, because a wrong owner is a security and personalization hazard.
 *
 * Pure (no I/O, no models); the runtime feeds it the diarized/recognized
 * observations and acts on a decided candidate (e.g. prompt to confirm, or set
 * the owner setting). The Voice Workbench exercises the SAME function so the
 * inference is benchmarked, not just shipped.
 */

/** One recognized voice turn: which enrolled/clustered speaker, how confident. */
export interface OwnerObservation {
  /** The entity/cluster the recognized voice resolved to (null = unrecognized). */
  entityId: string | null;
  /** Recognition confidence 0..1 (cosine-rescaled by the attribution pipeline). */
  confidence: number;
}

export interface OwnerInferenceOptions {
  /** Minimum qualifying observations before any candidate is proposed. */
  minObservations?: number;
  /** Confidence floor; observations below it don't count toward a candidate. */
  minConfidence?: number;
  /**
   * Minimum lead (in confidence-weighted score) the top speaker must hold over
   * the runner-up to be unambiguous. Prevents naming an owner in a two-equals
   * household.
   */
  minMargin?: number;
}

export interface OwnerInferenceResult {
  /** The proposed owner entity, or null when the evidence is insufficient. */
  ownerEntityId: string | null;
  /** Confidence-weighted share of the proposed owner (0..1), 0 when undecided. */
  share: number;
  /** Number of qualifying (confident, recognized) observations considered. */
  qualifyingObservations: number;
  /** Why the function decided / declined — surfaced for the provider's logs. */
  reason: string;
}

const DEFAULT_MIN_OBSERVATIONS = 3;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MIN_MARGIN = 1;

/**
 * Propose the most likely owner from recognized voice observations, or stay
 * undecided. A candidate is returned only when there are at least
 * `minObservations` confident, recognized turns AND the top speaker leads the
 * runner-up by at least `minMargin` (confidence-weighted). Ties and thin
 * evidence yield `ownerEntityId: null`.
 */
export function resolveOwnerCandidate(
  observations: ReadonlyArray<OwnerObservation>,
  options: OwnerInferenceOptions = {},
): OwnerInferenceResult {
  const minObservations = options.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;

  const scores = new Map<string, number>();
  let qualifying = 0;
  let totalScore = 0;
  for (const obs of observations) {
    if (obs.entityId === null) continue;
    if (!(obs.confidence >= minConfidence)) continue;
    qualifying += 1;
    const next = (scores.get(obs.entityId) ?? 0) + obs.confidence;
    scores.set(obs.entityId, next);
    totalScore += obs.confidence;
  }

  if (qualifying < minObservations) {
    return {
      ownerEntityId: null,
      share: 0,
      qualifyingObservations: qualifying,
      reason: `insufficient evidence (${qualifying}/${minObservations} confident observations)`,
    };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [topId, topScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] ?? 0;
  if (topScore - runnerUpScore < minMargin) {
    return {
      ownerEntityId: null,
      share: totalScore > 0 ? topScore / totalScore : 0,
      qualifyingObservations: qualifying,
      reason: `ambiguous lead (top ${topScore.toFixed(2)} vs runner-up ${runnerUpScore.toFixed(2)}, margin < ${minMargin})`,
    };
  }

  return {
    ownerEntityId: topId,
    share: totalScore > 0 ? topScore / totalScore : 0,
    qualifyingObservations: qualifying,
    reason: `dominant speaker (${topScore.toFixed(2)} of ${totalScore.toFixed(2)} over ${qualifying} observations)`,
  };
}
