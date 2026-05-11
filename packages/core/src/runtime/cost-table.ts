/**
 * Per-model price table — backwards-compatible shim over the canonical
 * `features/trajectories/pricing.ts` module.
 *
 * The canonical source of truth now lives at
 * `eliza/packages/core/src/features/trajectories/pricing.ts` and carries
 * versioned `PRICE_TABLE_ID`, full provider coverage (Anthropic, OpenAI,
 * Google, Groq, Cerebras, Eliza Cloud, Ollama, LM Studio, llama.cpp), and
 * a structured warning on missing models.
 *
 * This file preserves the legacy export shape used by the planner, the
 * evaluator, and the standalone `scripts/lib/cost-table.ts` mirror. New
 * callers should import from `features/trajectories/pricing` directly.
 */
import {
	computeCallCostUsd as computeCallCostUsdFromPricing,
	lookupModelPrice as lookupModelPriceFromPricing,
	type ModelPriceUsdPerMTokens as ModelPriceUsdPerMTokensWithProvider,
	MODEL_PRICES_USD_PER_M_TOKENS as PRICING_TABLE,
	type TokenUsageForCost,
} from "../features/trajectories/pricing";

export type { TokenUsageForCost } from "../features/trajectories/pricing";
export {
	isLocalProvider,
	PRICE_TABLE_ID,
} from "../features/trajectories/pricing";

/**
 * Legacy price-entry shape (no `provider` field). Preserved so any external
 * caller that imports the type continues to compile.
 */
export interface ModelPriceUsdPerMTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Legacy flat price table — provider field stripped for back-compat with
 * the original cost-table shape.
 *
 * Built lazily from the canonical pricing table. Mutating the canonical
 * table would not flow through here; the table is read-only by contract.
 */
export const MODEL_PRICES_USD_PER_M_TOKENS: Record<
	string,
	ModelPriceUsdPerMTokens
> = (() => {
	const out: Record<string, ModelPriceUsdPerMTokens> = {};
	for (const [key, entry] of Object.entries(PRICING_TABLE) as Array<
		[string, ModelPriceUsdPerMTokensWithProvider]
	>) {
		out[key] = {
			input: entry.input,
			output: entry.output,
			cacheRead: entry.cacheRead,
			cacheWrite: entry.cacheWrite,
		};
	}
	return out;
})();

/**
 * Look up the price entry for a model name. Returns the legacy
 * `{ input, output, cacheRead, cacheWrite }` shape (no provider field).
 *
 * New callers that need the provider field should use the canonical
 * `lookupModelPrice` from `features/trajectories/pricing` directly.
 */
export function lookupModelPrice(
	modelName: string | undefined,
): ModelPriceUsdPerMTokens | null {
	const result = lookupModelPriceFromPricing(modelName);
	if (!result) return null;
	const { price } = result;
	return {
		input: price.input,
		output: price.output,
		cacheRead: price.cacheRead,
		cacheWrite: price.cacheWrite,
	};
}

/**
 * Compute the USD cost of a single model call.
 *
 * Thin wrapper over `features/trajectories/pricing.computeCallCostUsd`.
 * No logger is passed so this entry point stays silent; the trajectory
 * recorder uses the canonical entry point directly and surfaces the
 * missing-model warning there.
 */
export function computeCallCostUsd(
	modelName: string | undefined,
	usage: TokenUsageForCost | undefined,
): number {
	return computeCallCostUsdFromPricing(modelName, usage);
}
