import { lookupModelContextWindow } from "../features/trajectories/pricing";
import type {
	ChatMessage,
	PromptSegment,
	ToolDefinition,
} from "../types/model";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 10_000;

/**
 * When the context window is resolved from `lookupModelContextWindow` (i.e.
 * we know the exact ceiling for this model), use this fraction of the window
 * as the compaction reserve floor.
 *
 * 0.20 is chosen so the estimator + provider tokenization variance + the
 * planner's small re-render growth between the budget-check and the actual
 * send all fit under the ceiling. Empirically: char/3.5 underestimates by
 * roughly 25–30% on tool-heavy planner prompts; a 20% reserve absorbs that
 * without compacting healthy traffic prematurely.
 *
 * The reserve is `max(DEFAULT_COMPACTION_RESERVE_TOKENS, window * 0.20)` so
 * tiny windows (≤ 50k) still get the 10k floor and large windows (≥ 200k)
 * scale up proportionally.
 *
 * **Important:** the scaled reserve only applies when (a) the model name was
 * passed AND resolved through `lookupModelContextWindow` AND (b) the caller
 * did not supply an explicit `reserveTokens`. Callers that pre-compute a
 * window-and-reserve pair keep their exact behavior — no regression for
 * existing call sites that don't pass `modelName`.
 */
export const MODEL_WINDOW_RESERVE_FRACTION = 0.2;

export interface ModelInputBudget {
	estimatedInputTokens: number;
	contextWindowTokens: number;
	reserveTokens: number;
	compactionThresholdTokens: number;
	shouldCompact: boolean;
	/**
	 * The matched model-family key from the context-window lookup, or null
	 * when the window came from the caller's explicit argument or the
	 * `DEFAULT_CONTEXT_WINDOW_TOKENS` fallback. Surfaced for observability
	 * (e.g. trajectory recorder, compaction logs).
	 */
	resolvedModelKey: string | null;
}

function textLength(value: unknown): number {
	if (typeof value === "string") {
		return value.length;
	}
	if (value == null) {
		return 0;
	}
	return JSON.stringify(value)?.length ?? 0;
}

function estimateTokensFromChars(chars: number): number {
	return Math.ceil(chars / 3.5);
}

export function estimateModelInputTokens(args: {
	messages?: readonly ChatMessage[];
	promptSegments?: readonly PromptSegment[];
	tools?: readonly ToolDefinition[];
}): number {
	const messageChars =
		args.messages?.reduce(
			(total, message) => total + textLength(message.content),
			0,
		) ?? 0;
	const segmentChars =
		args.messages && args.messages.length > 0
			? 0
			: (args.promptSegments?.reduce(
					(total, segment) => total + textLength(segment.content),
					0,
				) ?? 0);
	const toolChars =
		args.tools?.reduce((total, tool) => total + textLength(tool), 0) ?? 0;
	return estimateTokensFromChars(segmentChars + messageChars + toolChars);
}

export function buildModelInputBudget(args: {
	messages?: readonly ChatMessage[];
	promptSegments?: readonly PromptSegment[];
	tools?: readonly ToolDefinition[];
	/**
	 * Explicit ceiling. When set, wins over the per-model lookup and the
	 * `DEFAULT_CONTEXT_WINDOW_TOKENS` fallback. Pass this when you have a
	 * provider-side limit that isn't representable in the lookup table
	 * (e.g. a custom long-context tier).
	 */
	contextWindowTokens?: number;
	/**
	 * Explicit reserve. When set, wins over the per-model 20%-of-window
	 * derivation and the `DEFAULT_COMPACTION_RESERVE_TOKENS` fallback.
	 */
	reserveTokens?: number;
	/**
	 * Optional model id. When set and `contextWindowTokens` is unset, the
	 * window is resolved through `lookupModelContextWindow` (longest-prefix
	 * family match). When the lookup hits and `reserveTokens` is unset, the
	 * reserve is scaled to `MODEL_WINDOW_RESERVE_FRACTION` of the window.
	 *
	 * Pass-through callers that don't know the active model name should
	 * omit this — the existing default behavior is preserved exactly.
	 */
	modelName?: string;
}): ModelInputBudget {
	const explicitWindow =
		Number.isFinite(args.contextWindowTokens) && args.contextWindowTokens
			? Math.max(1, Math.floor(args.contextWindowTokens))
			: undefined;

	// Resolution order is `lookup > explicit > default`:
	//
	//   1. `modelName` resolved by `lookupModelContextWindow` — the
	//      provider-published ceiling for THIS specific model. Always
	//      authoritative because it reflects the actual hard limit you'd
	//      hit on the wire.
	//   2. `contextWindowTokens` passed by the caller — usually the
	//      generic 128k default carried on `ChainingLoopConfig` from when
	//      the loop assumed a single context size. Used when no lookup.
	//   3. `DEFAULT_CONTEXT_WINDOW_TOKENS` — last-resort fallback.
	//
	// This ordering means a caller can opt into the per-model ceiling
	// just by setting `modelName`, without having to also unset the
	// generic default. Callers who *need* an exact override (e.g. a
	// custom long-context tier) can still pin a number explicitly by
	// omitting `modelName` and passing `contextWindowTokens` — that path
	// is unchanged from the pre-lookup behavior.
	const lookup = lookupModelContextWindow(args.modelName);

	const contextWindowTokens =
		lookup?.contextWindowTokens ??
		explicitWindow ??
		DEFAULT_CONTEXT_WINDOW_TOKENS;

	const explicitReserve =
		Number.isFinite(args.reserveTokens) && args.reserveTokens !== undefined
			? Math.max(0, Math.floor(args.reserveTokens))
			: undefined;

	// Reserve resolution order:
	//   1. Explicit caller arg (any value, including 0) — strict override.
	//   2. Per-model derived reserve (only when window came from lookup):
	//      `max(DEFAULT_COMPACTION_RESERVE_TOKENS, window * 0.20)`. This
	//      absorbs the char/3.5 estimator's empirical 25–30% under-shoot on
	//      tool-heavy planner prompts plus the small per-iteration re-render
	//      growth between the budget check and the actual send.
	//   3. `DEFAULT_COMPACTION_RESERVE_TOKENS` — unchanged backwards-compat
	//      default for callers that don't pass `modelName`.
	const derivedReserveFromLookup =
		lookup !== null
			? Math.max(
					DEFAULT_COMPACTION_RESERVE_TOKENS,
					Math.floor(contextWindowTokens * MODEL_WINDOW_RESERVE_FRACTION),
				)
			: undefined;

	const reserveTokens =
		explicitReserve ?? derivedReserveFromLookup ?? DEFAULT_COMPACTION_RESERVE_TOKENS;

	const compactionThresholdTokens = Math.max(
		1,
		contextWindowTokens - reserveTokens,
	);
	const estimatedInputTokens = estimateModelInputTokens(args);
	return {
		estimatedInputTokens,
		contextWindowTokens,
		reserveTokens,
		compactionThresholdTokens,
		shouldCompact: estimatedInputTokens >= compactionThresholdTokens,
		resolvedModelKey: lookup?.matchedKey ?? null,
	};
}

export function withModelInputBudgetProviderOptions<
	T extends Record<string, unknown>,
>(providerOptions: T, budget: ModelInputBudget): T {
	const eliza =
		typeof providerOptions.eliza === "object" && providerOptions.eliza !== null
			? (providerOptions.eliza as Record<string, unknown>)
			: {};
	return {
		...providerOptions,
		eliza: {
			...eliza,
			modelInputBudget: budget,
		},
	} as T;
}
