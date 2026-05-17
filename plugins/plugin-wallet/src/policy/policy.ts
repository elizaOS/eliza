import type { ApprovalSummary, SignScope } from "../wallet/pending.js";

export interface PolicyEvaluation {
  readonly kind: "ok" | "requires_approval" | "blocked";
  readonly reason?: string;
  readonly rule?: string;
  readonly cooldownUntil?: number;
}

/**
 * Business rules for size limits, allowlists, and cooldowns. Actions never
 * inline policy checks — they delegate here after zod parse + plugin checks.
 */
export interface PolicyModule {
  evaluate(
    scope: SignScope,
    summary: ApprovalSummary,
  ): Promise<PolicyEvaluation>;
}
