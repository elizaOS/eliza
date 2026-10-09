/** Additional policy evaluators registered by the composing host. */
export interface ContributedPolicyRule {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
}

export interface ContributedPolicyResult {
  readonly policyId: string;
  readonly type: string;
  readonly passed: boolean;
  readonly reason?: string;
  /** Only meaningful for a failing result; otherwise the rule denies outright. */
  readonly requiresManualApproval?: boolean;
}

export interface PolicyRuleContribution<Ctx = unknown> {
  readonly type: string;
  /** Reads supplied context without reserving or committing money. Throws deny. */
  evaluate(
    rule: ContributedPolicyRule,
    ctx: Ctx,
  ): ContributedPolicyResult | Promise<ContributedPolicyResult>;
  readonly description?: string;
}
