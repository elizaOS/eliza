/**
 * Internal reputation scoring for Steward agents.
 *
 * Produces a 0-100 score used by reputation-based policy evaluators
 * to dynamically gate or scale transaction permissions.
 */

export interface ReputationInput {
  totalTransactions: number;
  successRate: number; // 0-1
  policyViolationRate: number; // 0-1
  accountAgeDays: number;
}

/**
 * Calculate an internal reputation score from on-platform metrics.
 *
 * Weights:
 *   success rate        40%
 *   violation inverse   30%
 *   account age         20%  (caps at 365 days)
 *   transaction volume  10%  (caps at 1000 txs)
 *
 * @returns integer 0-100
 */
export function calculateInternalReputation(input: ReputationInput): number {
  const successScore = input.successRate * 40;
  const violationScore = (1 - input.policyViolationRate) * 30;
  const ageScore = Math.min(input.accountAgeDays / 365, 1) * 20;
  const volumeScore = Math.min(input.totalTransactions / 1000, 1) * 10;
  return Math.round(successScore + violationScore + ageScore + volumeScore);
}
