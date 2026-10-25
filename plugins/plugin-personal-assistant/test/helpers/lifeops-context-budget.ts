/**
 * LifeOps context-budget benchmark (#8795 item 8).
 *
 * The LifeOps planner is fed by ~10 context providers (`src/providers/*.ts`).
 * Together they can dominate the prompt; without a measured budget, a provider
 * that quietly grows its payload silently steals context window (and money)
 * from the rest of the turn. This module is the measurement + ablation
 * primitive:
 *
 *   - `measureProviderPayloads` — per-provider char/token payload, sorted by
 *     cost, so a regression in one provider is attributable.
 *   - `summarizeContextBudget` — asserts the combined per-turn payload stays
 *     within a token budget (the LifeOps counterpart of the core planner-loop
 *     `trajectory_token_budget`), surfacing over-budget context as a measured
 *     number instead of a silent truncation.
 *   - `ablateProviders` — drops each provider in turn and scores the remainder
 *     via a pluggable `scoreFn`, quantifying each provider's contribution. The
 *     token-accounting is deterministic and credential-free here; the live
 *     accuracy ablation plugs a real scenario scorer into `scoreFn`.
 *
 * Token counts use the standard ~4-chars-per-token approximation. Swap in a
 * real tokenizer via `estimateTokens` when running against a specific model.
 */

/** The 10 LifeOps context providers feeding the planner (src/providers/*.ts). */
export const LIFEOPS_CONTEXT_PROVIDERS = [
  "lifeops",
  "pendingPrompts",
  "recentTaskStates",
  "crossChannelContext",
  "workThreads",
  "inboxTriage",
  "activity-profile",
  "lifeops-health",
  "roomPolicy",
  "firstRun",
] as const;

export type LifeOpsContextProvider = (typeof LIFEOPS_CONTEXT_PROVIDERS)[number];

/** Approximate token count for a payload (~4 chars/token, never negative). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type ProviderPayload = { name: string; text: string };

export type ProviderPayloadMeasurement = {
  name: string;
  chars: number;
  tokens: number;
  /** Share of the total token payload in [0, 1]. */
  share: number;
};

function toPayloadList(
  payloads: ProviderPayload[] | Record<string, string>,
): ProviderPayload[] {
  return Array.isArray(payloads)
    ? payloads
    : Object.entries(payloads).map(([name, text]) => ({ name, text }));
}

/**
 * Per-provider char/token payload, sorted by token cost descending so the
 * heaviest provider is first (the attribution order for a budget regression).
 */
export function measureProviderPayloads(
  payloads: ProviderPayload[] | Record<string, string>,
): ProviderPayloadMeasurement[] {
  const list = toPayloadList(payloads);
  const measured = list.map((p) => ({
    name: p.name,
    chars: p.text.length,
    tokens: estimateTokens(p.text),
  }));
  const totalTokens = measured.reduce((sum, m) => sum + m.tokens, 0);
  return measured
    .map((m) => ({
      ...m,
      share: totalTokens > 0 ? m.tokens / totalTokens : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

export type ContextBudgetSummary = {
  totalTokens: number;
  budgetTokens: number;
  withinBudget: boolean;
  /** Tokens over budget (0 when within budget). */
  overflowTokens: number;
  byProvider: ProviderPayloadMeasurement[];
};

/**
 * Assert the combined per-turn provider payload stays within `budgetTokens`.
 * `withinBudget` is the pass/fail; `overflowTokens` is the measured overage so
 * over-budget context is a number, not a silent truncation.
 */
export function summarizeContextBudget(
  payloads: ProviderPayload[] | Record<string, string>,
  budgetTokens: number,
): ContextBudgetSummary {
  const byProvider = measureProviderPayloads(payloads);
  const totalTokens = byProvider.reduce((sum, m) => sum + m.tokens, 0);
  const overflowTokens = Math.max(0, totalTokens - budgetTokens);
  return {
    totalTokens,
    budgetTokens,
    withinBudget: totalTokens <= budgetTokens,
    overflowTokens,
    byProvider,
  };
}

export type ProviderAblationResult = {
  provider: string;
  baselineScore: number;
  ablatedScore: number;
  /** baseline - ablated: how much accuracy this provider contributed. */
  deltaScore: number;
};

/**
 * Ablation harness: drop each provider in turn and score the remaining set via
 * `scoreFn`, returning each provider's contribution (`deltaScore`). The token
 * accounting here is deterministic; pass a real scenario scorer as `scoreFn`
 * for the live accuracy ablation. Results are sorted by contribution desc.
 */
export async function ablateProviders(
  payloads: ProviderPayload[] | Record<string, string>,
  scoreFn: (remaining: ProviderPayload[]) => number | Promise<number>,
): Promise<{ baselineScore: number; results: ProviderAblationResult[] }> {
  const list = toPayloadList(payloads);
  const baselineScore = await scoreFn(list);
  const results: ProviderAblationResult[] = [];
  for (const dropped of list) {
    const remaining = list.filter((p) => p.name !== dropped.name);
    const ablatedScore = await scoreFn(remaining);
    results.push({
      provider: dropped.name,
      baselineScore,
      ablatedScore,
      deltaScore: baselineScore - ablatedScore,
    });
  }
  results.sort((a, b) => b.deltaScore - a.deltaScore);
  return { baselineScore, results };
}
