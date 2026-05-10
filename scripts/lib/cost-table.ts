/**
 * Per-model price table and helpers for computing per-call USD cost.
 *
 * Source of truth for the trajectory recorder + the trajectory CLI. Mirrors
 * the price table in PLAN.md §18.7. The numbers are per 1,000,000 tokens
 * (the standard unit pricing providers publish).
 *
 * `cacheRead` is the discount applied when the input was served from cache.
 * `cacheWrite` is the surcharge for writing the prompt into cache (Anthropic
 * specifically charges this; OpenAI does not). When a provider does not
 * differentiate, set the cache rates to 0 — `computeCallCostUsd` will fall
 * back to the regular input rate.
 */

export interface ModelPriceUsdPerMTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TokenUsageForCost {
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	totalTokens?: number;
}

export const MODEL_PRICES_USD_PER_M_TOKENS: Record<string, ModelPriceUsdPerMTokens> = {
	// Cerebras (gpt-oss family, served at https://api.cerebras.ai/v1)
	"gpt-oss-120b": { input: 0.5, output: 0.8, cacheRead: 0, cacheWrite: 0 },

	// Anthropic
	"claude-opus-4-7": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
	"claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-haiku-4-5": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },

	// OpenAI (current ship targets per CLAUDE.md)
	"gpt-5.5": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 0 },
	"gpt-5.5-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0 },
};

/**
 * Look up the price entry for a model name. Falls back to a partial match
 * when an exact key is missing — the adapter sometimes emits a versioned
 * model id (e.g. `claude-haiku-4-5-20251001`) where the price table only
 * stores the family key (`claude-haiku-4-5`).
 */
export function lookupModelPrice(modelName: string | undefined): ModelPriceUsdPerMTokens | null {
	if (!modelName) return null;
	const exact = MODEL_PRICES_USD_PER_M_TOKENS[modelName];
	if (exact) return exact;

	const normalized = modelName.toLowerCase();
	const match = Object.keys(MODEL_PRICES_USD_PER_M_TOKENS)
		.filter((k) => normalized.includes(k.toLowerCase()))
		.sort((a, b) => b.length - a.length)[0];
	return match ? (MODEL_PRICES_USD_PER_M_TOKENS[match] ?? null) : null;
}

/**
 * Compute the USD cost of a single model call given its model name and
 * token usage breakdown. Returns 0 when the model is unknown — cost
 * computation must never be a hard error in the recorder.
 *
 * Cache-read tokens are billed at the cacheRead rate when set, otherwise
 * the regular input rate. Cache-creation tokens are billed at cacheWrite
 * (Anthropic's surcharge) on top of the regular input portion that paid
 * for them. Non-cached input is billed at the input rate.
 */
export function computeCallCostUsd(
	modelName: string | undefined,
	usage: TokenUsageForCost | undefined,
): number {
	if (!usage) return 0;
	const price = lookupModelPrice(modelName);
	if (!price) return 0;

	const cacheRead = usage.cacheReadInputTokens ?? 0;
	const cacheWrite = usage.cacheCreationInputTokens ?? 0;
	const totalPrompt = usage.promptTokens ?? 0;
	const nonCachedInput = Math.max(0, totalPrompt - cacheRead - cacheWrite);
	const completion = usage.completionTokens ?? 0;

	const inputCost = (nonCachedInput / 1_000_000) * price.input;
	const cacheReadCost = (cacheRead / 1_000_000) * (price.cacheRead || price.input);
	const cacheWriteCost = (cacheWrite / 1_000_000) * (price.cacheWrite || price.input);
	const outputCost = (completion / 1_000_000) * price.output;

	return inputCost + cacheReadCost + cacheWriteCost + outputCost;
}

/**
 * Format a cost value for terminal display. Always 4 fractional digits so
 * stage-level lines line up nicely.
 */
export function formatUsd(amount: number): string {
	if (!Number.isFinite(amount)) return "$?.????";
	return `$${amount.toFixed(4)}`;
}
