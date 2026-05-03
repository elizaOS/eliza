/**
 * Reputation-threshold policy evaluator.
 *
 * Gates transactions based on the agent's reputation score.
 * If no score is available in context, falls back to the configured fallbackAction.
 */

import type { PolicyResult, PolicyRule } from "@stwd/shared";

export interface ReputationThresholdConfig {
  minScore: number;
  action: "approve" | "require-approval" | "block";
  source: "internal" | "onchain" | "combined";
  fallbackAction: "approve" | "require-approval" | "block";
}

export interface ReputationThresholdContext {
  reputationScore?: number;
}

export function evaluateReputationThreshold(
  rule: PolicyRule,
  ctx: ReputationThresholdContext,
): PolicyResult {
  const config = rule.config as unknown as ReputationThresholdConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  if (ctx.reputationScore === undefined || ctx.reputationScore === null) {
    // No score available, use fallback
    const passed = config.fallbackAction === "approve";
    return {
      ...base,
      passed,
      reason: `No reputation score available; fallback action: ${config.fallbackAction}`,
    };
  }

  if (ctx.reputationScore >= config.minScore) {
    return {
      ...base,
      passed: true,
      reason: `Reputation score ${ctx.reputationScore} meets minimum ${config.minScore}`,
    };
  }

  return {
    ...base,
    passed: false,
    reason: `Reputation score ${ctx.reputationScore} below minimum ${config.minScore} (action: ${config.action})`,
  };
}
