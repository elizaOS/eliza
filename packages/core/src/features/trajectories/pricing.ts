/**
 * Per-provider LLM price table — canonical source of truth.
 *
 * Closes M40 / W1-X1 (see docs/eliza-1-pipeline/{02-gap-analysis.md,
 * 03-implementation-plan.md}). Every LLM step recorded in the trajectory
 * subsystem is annotated with `cost_usd` computed from this table.
 *
 * All numbers are USD per 1,000,000 tokens (the standard unit pricing
 * providers publish).
 *
 * Versioned via `PRICE_TABLE_ID`. When prices change, bump the date suffix
 * so downstream readers (the trajectory CLI, the cost-regression report,
 * the dashboard cost roll-ups) can detect a snapshot boundary.
 *
 * Sources and dates of the published numbers below are noted inline so the
 * table is auditable. Update both the entry and the corresponding source
 * comment if a provider changes their rate card.
 */
import type {
	TokenUsageForCost,
	TrajectoryRuntimeLogger,
} from "./pricing-types";

export type { TokenUsageForCost } from "./pricing-types";

/**
 * Stable identifier for the on-disk price table snapshot.
 *
 * Bump the date suffix every time any rate in `MODEL_PRICES_USD_PER_M_TOKENS`
 * changes. The recorder writes this id alongside the per-step `cost_usd`
 * so consumers can disambiguate cost numbers computed against different
 * snapshots.
 */
export const PRICE_TABLE_ID = "eliza-v1-2026-05-11" as const;
export type PriceTableId = typeof PRICE_TABLE_ID;

/**
 * Provider name as recorded on the trajectory step. Drives the local-tier
 * default (Ollama / LM Studio / llama.cpp report cost 0 with no warning).
 */
export type ProviderName =
	| "anthropic"
	| "openai"
	| "google"
	| "groq"
	| "cerebras"
	| "eliza-cloud"
	| "ollama"
	| "lm-studio"
	| "llama.cpp"
	| "local"
	| "unknown";

export interface ModelPriceUsdPerMTokens {
	/** Provider that publishes this rate card. */
	provider: ProviderName;
	/** USD per 1M input tokens (non-cached prompt). */
	input: number;
	/** USD per 1M output (completion) tokens. */
	output: number;
	/**
	 * USD per 1M tokens served from cache. 0 means the provider does not
	 * publish a separate cache-read rate — `computeCallCostUsd` falls back to
	 * the regular input rate.
	 */
	cacheRead: number;
	/**
	 * USD per 1M tokens written into cache (Anthropic's surcharge on top of
	 * the regular input cost). 0 means no surcharge — fallback to input rate.
	 */
	cacheWrite: number;
}

/**
 * Per-model price table. Keys are the canonical family name; the lookup
 * helper performs a longest-prefix match so versioned ids
 * (e.g. `claude-haiku-4-5-20251001`) resolve to the family entry.
 *
 * Pricing comments cite the source page and the date the number was
 * captured from. Update both when bumping `PRICE_TABLE_ID`.
 */
export const MODEL_PRICES_USD_PER_M_TOKENS: Record<
	string,
	ModelPriceUsdPerMTokens
> = {
	// ---- Anthropic ----------------------------------------------------------
	// Source: https://www.anthropic.com/pricing (captured 2026-05-11)
	"claude-opus-4-7": {
		provider: "anthropic",
		input: 15.0,
		output: 75.0,
		cacheRead: 1.5,
		cacheWrite: 18.75,
	},
	"claude-sonnet-4-6": {
		provider: "anthropic",
		input: 3.0,
		output: 15.0,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"claude-haiku-4-5": {
		provider: "anthropic",
		input: 0.8,
		output: 4.0,
		cacheRead: 0.08,
		cacheWrite: 1.0,
	},

	// ---- OpenAI -------------------------------------------------------------
	// Source: https://openai.com/api/pricing (captured 2026-05-11)
	"gpt-5.5": {
		provider: "openai",
		input: 1.25,
		output: 10.0,
		cacheRead: 0.125,
		cacheWrite: 0,
	},
	"gpt-5.5-mini": {
		provider: "openai",
		input: 0.25,
		output: 2.0,
		cacheRead: 0.025,
		cacheWrite: 0,
	},

	// ---- Google -------------------------------------------------------------
	// Source: https://ai.google.dev/pricing (captured 2026-05-11).
	// Gemini 2.5 Pro published rate is $1.25/M input ($2.50 above 200k tokens)
	// and $10/M output. We bill the standard tier; long-context premium is
	// tracked separately if a downstream consumer needs it.
	"gemini-2.5-pro": {
		provider: "google",
		input: 1.25,
		output: 10.0,
		cacheRead: 0.31,
		cacheWrite: 0,
	},
	"gemini-2.5-flash": {
		provider: "google",
		input: 0.3,
		output: 2.5,
		cacheRead: 0.075,
		cacheWrite: 0,
	},

	// ---- Groq ---------------------------------------------------------------
	// Source: https://groq.com/pricing (captured 2026-05-11). Groq publishes
	// per-model rates; numbers below are the Llama-3.3-70B and Llama-3.1-8B
	// production endpoints.
	"llama-3.3-70b-versatile": {
		provider: "groq",
		input: 0.59,
		output: 0.79,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"llama-3.1-8b-instant": {
		provider: "groq",
		input: 0.05,
		output: 0.08,
		cacheRead: 0,
		cacheWrite: 0,
	},

	// ---- Cerebras -----------------------------------------------------------
	// Source: https://inference-docs.cerebras.ai/introduction (captured
	// 2026-05-11). The gpt-oss family is served at https://api.cerebras.ai/v1.
	"gpt-oss-120b": {
		provider: "cerebras",
		input: 0.5,
		output: 0.8,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"llama-3.3-70b": {
		provider: "cerebras",
		input: 0.85,
		output: 1.2,
		cacheRead: 0,
		cacheWrite: 0,
	},

	// ---- Eliza Cloud --------------------------------------------------------
	// Source: internal price card (captured 2026-05-11). Eliza Cloud passes
	// through Anthropic + OpenAI inventory at a published markup; the table
	// below reflects the customer-facing rate for the two ship targets.
	// When a different upstream model is routed via the elizacloud provider,
	// the provider tag stays "eliza-cloud" and the model id determines the
	// rate (longest-prefix match still resolves the Anthropic/OpenAI key).
	"eliza-cloud-opus": {
		provider: "eliza-cloud",
		input: 18.0,
		output: 90.0,
		cacheRead: 1.8,
		cacheWrite: 22.5,
	},
	"eliza-cloud-sonnet": {
		provider: "eliza-cloud",
		input: 3.6,
		output: 18.0,
		cacheRead: 0.36,
		cacheWrite: 4.5,
	},

	// ---- Local (zero cost) --------------------------------------------------
	// Ollama / LM Studio / llama.cpp run on user hardware — no metered cost.
	// Listed explicitly so `lookupModelPrice` returns a known-zero entry
	// instead of warning on common local model ids.
	ollama: {
		provider: "ollama",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"lm-studio": {
		provider: "lm-studio",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	"llama.cpp": {
		provider: "llama.cpp",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
};

/**
 * Provider tags that emit cost 0 with no warning when no model entry is
 * found. Local inference is a real zero, not a missing price — per
 * AGENTS.md: "cost=0 for local is a real zero (not 'missing'). No fallback
 * that masks."
 */
const LOCAL_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>([
	"ollama",
	"lm-studio",
	"llama.cpp",
	"local",
]);

/**
 * Result of a price lookup. Carries the matched table key so callers can
 * surface "matched as family X" diagnostics if needed.
 */
export interface PriceLookupResult {
	matchedKey: string;
	price: ModelPriceUsdPerMTokens;
}

/**
 * Look up the price entry for a model name. Returns null when the model is
 * unknown.
 *
 * Falls back to the longest-prefix family-key match when an exact key is
 * missing — adapters often emit a versioned id
 * (e.g. `claude-haiku-4-5-20251001`) where the table only stores the
 * family key (`claude-haiku-4-5`).
 */
export function lookupModelPrice(
	modelName: string | undefined,
): PriceLookupResult | null {
	if (!modelName) return null;
	const exact = MODEL_PRICES_USD_PER_M_TOKENS[modelName];
	if (exact) return { matchedKey: modelName, price: exact };

	const normalized = modelName.toLowerCase();
	const candidates = Object.keys(MODEL_PRICES_USD_PER_M_TOKENS)
		.filter((k) => normalized.includes(k.toLowerCase()))
		.sort((a, b) => b.length - a.length);
	const match = candidates[0];
	if (!match) return null;
	const price = MODEL_PRICES_USD_PER_M_TOKENS[match];
	if (!price) return null;
	return { matchedKey: match, price };
}

/**
 * Compute the USD cost of a single LLM call.
 *
 * Returns 0 when:
 *  - `usage` is undefined or all-zero,
 *  - the model is unknown (cost computation is observability; it must
 *    never crash the runtime),
 *  - the provider is a known local tier (Ollama / LM Studio / llama.cpp /
 *    "local") — local cost is a real zero, not a missing price.
 *
 * When the model is unknown and the provider is *not* local, the optional
 * `logger.warn` is invoked once per call. Callers in hot paths can pass
 * `logger: undefined` to suppress noise.
 *
 * Cache-read tokens are billed at the cacheRead rate when set, otherwise
 * the regular input rate. Cache-creation tokens are billed at cacheWrite
 * (Anthropic's surcharge) on top of the regular input portion that paid
 * for them. Non-cached input is billed at the input rate.
 */
export function computeCallCostUsd(
	modelName: string | undefined,
	usage: TokenUsageForCost | undefined,
	options: {
		provider?: string;
		logger?: TrajectoryRuntimeLogger;
	} = {},
): number {
	if (!usage) return 0;

	const provider = options.provider?.toLowerCase().trim();
	const isLocalProvider =
		provider !== undefined &&
		LOCAL_PROVIDERS.has(provider as ProviderName);

	const lookup = lookupModelPrice(modelName);
	if (!lookup) {
		if (!isLocalProvider) {
			options.logger?.warn?.(
				{
					modelName: modelName ?? "(undefined)",
					provider: provider ?? "(unknown)",
					priceTableId: PRICE_TABLE_ID,
				},
				"[pricing] no price entry — cost_usd defaulted to 0",
			);
		}
		return 0;
	}

	const { price } = lookup;
	const cacheRead = usage.cacheReadInputTokens ?? 0;
	const cacheWrite = usage.cacheCreationInputTokens ?? 0;
	const totalPrompt = usage.promptTokens ?? 0;
	const nonCachedInput = Math.max(0, totalPrompt - cacheRead - cacheWrite);
	const completion = usage.completionTokens ?? 0;

	const inputCost = (nonCachedInput / 1_000_000) * price.input;
	const cacheReadCost =
		(cacheRead / 1_000_000) * (price.cacheRead || price.input);
	const cacheWriteCost =
		(cacheWrite / 1_000_000) * (price.cacheWrite || price.input);
	const outputCost = (completion / 1_000_000) * price.output;

	return inputCost + cacheReadCost + cacheWriteCost + outputCost;
}

/**
 * Whether the provided provider tag is a known local-tier inference target.
 * Used by the recorder to suppress the missing-model warning when a user
 * runs entirely on local hardware.
 */
export function isLocalProvider(provider: string | undefined): boolean {
	if (!provider) return false;
	return LOCAL_PROVIDERS.has(provider.toLowerCase().trim() as ProviderName);
}
