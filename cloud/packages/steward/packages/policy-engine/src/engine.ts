import type { PolicyResult, PolicyRule, PriceOracle, SignRequest } from "@stwd/shared";
import { type EvaluatorContext, evaluatePolicy } from "./evaluators";

export interface PolicyEvaluationContext {
  request: SignRequest;
  recentTxCount24h: number;
  recentTxCount1h: number;
  spentToday: bigint;
  spentThisWeek: bigint;
  /** Optional price oracle for USD-based policy evaluation */
  priceOracle?: PriceOracle;
  /** Optional reputation score for reputation-based policies */
  reputationScore?: number;
}

export interface EvaluationResult {
  approved: boolean;
  results: PolicyResult[];
  requiresManualApproval: boolean;
}

/**
 * Policy Engine — evaluates a set of policy rules against a transaction request.
 *
 * Logic:
 * - All enabled policies must pass for auto-approval
 * - If auto-approve-threshold fails but all other policies pass, tx is queued for manual approval
 * - If any hard policy (spending-limit, approved-addresses, rate-limit, time-window) fails, tx is rejected
 */
export class PolicyEngine {
  /**
   * Evaluate all policies for an agent's transaction request.
   *
   * Now async to support USD-based evaluations that require price oracle lookups.
   */
  async evaluate(policies: PolicyRule[], ctx: PolicyEvaluationContext): Promise<EvaluationResult> {
    if (policies.length === 0) {
      // No policies = everything auto-approved (dangerous but valid for testing)
      return { approved: true, results: [], requiresManualApproval: false };
    }

    const evaluatorCtx: EvaluatorContext = {
      request: ctx.request,
      recentTxCount24h: ctx.recentTxCount24h,
      recentTxCount1h: ctx.recentTxCount1h,
      spentToday: ctx.spentToday,
      spentThisWeek: ctx.spentThisWeek,
      priceOracle: ctx.priceOracle,
      reputationScore: ctx.reputationScore,
    };

    const results: PolicyResult[] = await Promise.all(
      policies.map((policy) => evaluatePolicy(policy, evaluatorCtx)),
    );

    const hardPolicies = results.filter((r) => r.type !== "auto-approve-threshold");
    const autoApproveResult = results.find((r) => r.type === "auto-approve-threshold");

    const allHardPass = hardPolicies.every((r) => r.passed);
    const autoApprovePass = autoApproveResult ? autoApproveResult.passed : true;

    if (allHardPass && autoApprovePass) {
      return { approved: true, results, requiresManualApproval: false };
    }

    if (allHardPass && !autoApprovePass) {
      // Hard policies pass but value exceeds auto-approve threshold
      // Queue for manual approval
      return { approved: false, results, requiresManualApproval: true };
    }

    // Hard policy failed — reject
    return { approved: false, results, requiresManualApproval: false };
  }
}
