/**
 * Time-weighted confidence decay.
 *
 * Based on the Ebbinghaus forgetting curve, adapted for information
 * reliability: confidence decays with a configurable half-life, and
 * corroborations increase stability (each corroboration doubles the
 * effective half-life).
 *
 * Formula: confidence(t) = baseConfidence * 0.5^(elapsed / effectiveHalfLife)
 *
 * References:
 *  - Ebbinghaus, H. (1885). Memory: A Contribution to Experimental Psychology.
 *  - Leitner spaced-repetition stability model.
 */

import type { InformationClaim } from '../types/index';

/**
 * Compute the current confidence of a claim, accounting for time decay
 * and corroboration stability.
 *
 * @param claim The information claim to evaluate.
 * @param now   Current timestamp (ms). Defaults to Date.now().
 * @returns     The decayed confidence, clamped to [0, 1].
 */
export function computeDecayedConfidence(claim: InformationClaim, now: number = Date.now()): number {
  if (claim.halfLifeMs === Infinity || claim.halfLifeMs <= 0) {
    // Ground truth or invalid half-life: no decay
    return claim.baseConfidence;
  }

  const effectiveHalfLife = getEffectiveHalfLife(claim);
  const elapsed = now - claim.updatedAt;

  if (elapsed <= 0) {
    return claim.baseConfidence;
  }

  const decayFactor = Math.pow(0.5, elapsed / effectiveHalfLife);
  return Math.max(0, Math.min(1, claim.baseConfidence * decayFactor));
}

/**
 * Each corroboration doubles the half-life, making information stickier
 * the more people confirm it.  Disputes halve it.
 *
 * effectiveHalfLife = halfLifeMs * 2^(corroborations - unresolvedDisputes)
 *
 * Clamped so it never drops below 1 day or exceeds 365 days (unless
 * the base half-life is already Infinity for ground truth).
 */
export function getEffectiveHalfLife(claim: InformationClaim): number {
  if (claim.halfLifeMs === Infinity) return Infinity;

  const corroborationCount = claim.corroborations.length;
  const activeDisputeCount = countUnresolvedDisputes(claim);
  const stabilityExponent = corroborationCount - activeDisputeCount;

  const ONE_DAY = 24 * 60 * 60 * 1000;
  const ONE_YEAR = 365 * ONE_DAY;

  const raw = claim.halfLifeMs * Math.pow(2, stabilityExponent);
  return Math.max(ONE_DAY, Math.min(ONE_YEAR, raw));
}

/**
 * Count unresolved disputes on a claim.
 */
function countUnresolvedDisputes(claim: InformationClaim): number {
  return claim.disputes.filter((d) => !d.resolved).length;
}

/**
 * Compute decayed relationship strength.
 *
 * Uses the same half-life model: strength decays from its base value
 * since the last interaction.
 *
 * @param baseStrength   The strength at last interaction (0-100).
 * @param lastInteractionAt ISO timestamp of last interaction.
 * @param halfLifeMs     Decay half-life in ms.
 * @param now            Current timestamp.
 * @returns              Decayed strength (0-100).
 */
export function computeRelationshipDecay(
  baseStrength: number,
  lastInteractionAt: string | undefined,
  halfLifeMs: number,
  now: number = Date.now()
): number {
  if (!lastInteractionAt || halfLifeMs === Infinity || halfLifeMs <= 0) {
    return baseStrength;
  }

  const elapsed = now - new Date(lastInteractionAt).getTime();
  if (elapsed <= 0) return baseStrength;

  const decayFactor = Math.pow(0.5, elapsed / halfLifeMs);
  return Math.max(0, Math.round(baseStrength * decayFactor));
}

/**
 * Compute a new base confidence after a corroboration event.
 *
 * Each corroboration nudges the base confidence upward using a
 * diminishing-returns formula:
 *   newBase = oldBase + (1 - oldBase) * boostFactor
 *
 * where boostFactor decreases with each successive corroboration.
 */
export function boostConfidenceFromCorroboration(
  currentBase: number,
  corroborationCount: number
): number {
  // Each successive corroboration has diminishing returns
  const boostFactor = 0.15 / (1 + corroborationCount * 0.3);
  return Math.min(1, currentBase + (1 - currentBase) * boostFactor);
}

/**
 * Reduce confidence when a dispute is filed.
 *
 * Drops base confidence by a penalty that scales with how many unresolved
 * disputes exist vs corroborations.
 */
export function penalizeConfidenceFromDispute(
  currentBase: number,
  unresolvedDisputeCount: number,
  corroborationCount: number
): number {
  // More corroborations make the claim harder to challenge
  const resilience = Math.min(0.8, corroborationCount * 0.15);
  const penalty = 0.2 * (1 - resilience) * unresolvedDisputeCount;
  return Math.max(0.05, currentBase - penalty);
}
