/**
 * Builds the LifeOps context-budget benchmark report: the fixed context provider-id set
 * plus the per-provider token payload and ablation math consumed by the budget tests.
 */
export const LIFEOPS_CONTEXT_PROVIDER_IDS = [
  "lifeops",
  "pendingPrompts",
  "recentTaskStates",
  "crossChannelContext",
  "workThreads",
  "inboxTriage",
  "activityProfile",
  "health",
  "roomPolicy",
  "firstRun",
] as const;

export type LifeOpsContextProviderId =
  (typeof LIFEOPS_CONTEXT_PROVIDER_IDS)[number];

export type LifeOpsContextBudgetScenario = {
  id: string;
  providerPayloads: Partial<Record<LifeOpsContextProviderId, string>>;
  requiredProviders: readonly LifeOpsContextProviderId[];
  tokenBudget: number;
};

export type LifeOpsProviderBudgetMetric = {
  providerId: LifeOpsContextProviderId;
  tokens: number;
  ablationDelta: number;
};

export type LifeOpsContextBudgetScenarioReport = {
  scenarioId: string;
  totalTokens: number;
  tokenBudget: number;
  overBudget: boolean;
  overBudgetKind?: "trajectory_token_budget";
  providers: LifeOpsProviderBudgetMetric[];
};

export type LifeOpsContextBudgetReport = {
  generatedAt: string;
  scenarios: LifeOpsContextBudgetScenarioReport[];
  providerTotals: Record<LifeOpsContextProviderId, number>;
};

export function estimateLifeOpsContextTokens(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return 0;
  return Math.ceil(normalized.length / 4);
}

function buildProviderMetric(
  scenario: LifeOpsContextBudgetScenario,
  providerId: LifeOpsContextProviderId,
): LifeOpsProviderBudgetMetric {
  const payload = scenario.providerPayloads[providerId] ?? "";
  return {
    providerId,
    tokens: estimateLifeOpsContextTokens(payload),
    // Proxy accuracy contribution for this deterministic benchmark: dropping a
    // provider that the scenario declares required creates a measurable
    // one-point regression. Live ablation can swap this for scenario pass-rate.
    ablationDelta: scenario.requiredProviders.includes(providerId) ? 1 : 0,
  };
}

export function buildLifeOpsContextBudgetReport(
  scenarios: readonly LifeOpsContextBudgetScenario[],
): LifeOpsContextBudgetReport {
  const providerTotals = Object.fromEntries(
    LIFEOPS_CONTEXT_PROVIDER_IDS.map((providerId) => [providerId, 0]),
  ) as Record<LifeOpsContextProviderId, number>;

  const scenarioReports = scenarios.map((scenario) => {
    const providers = LIFEOPS_CONTEXT_PROVIDER_IDS.map((providerId) =>
      buildProviderMetric(scenario, providerId),
    );
    for (const metric of providers) {
      providerTotals[metric.providerId] += metric.tokens;
    }
    const totalTokens = providers.reduce(
      (sum, metric) => sum + metric.tokens,
      0,
    );
    const overBudget = totalTokens > scenario.tokenBudget;
    return {
      scenarioId: scenario.id,
      totalTokens,
      tokenBudget: scenario.tokenBudget,
      overBudget,
      ...(overBudget
        ? ({ overBudgetKind: "trajectory_token_budget" } as const)
        : {}),
      providers,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    scenarios: scenarioReports,
    providerTotals,
  };
}
