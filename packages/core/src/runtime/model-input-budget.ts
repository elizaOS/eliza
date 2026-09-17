/**
 * Estimates a complete model request for diagnostics using an explicit context
 * window and output reserve. Estimates never reject or rewrite model input.
 */

import { ElizaError } from "../errors";
import type {
	ChatMessage,
	PromptSegment,
	ToolDefinition,
} from "../types/model";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_INPUT_RESERVE_TOKENS = 10_000;
/** @deprecated Use {@link DEFAULT_INPUT_RESERVE_TOKENS}. */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = DEFAULT_INPUT_RESERVE_TOKENS;
/** @deprecated Content projection is retired; retained for source compatibility. */
export const DEFAULT_CONTENT_PROJECTION_PER_RESULT_TOKENS = 16_000;
/** @deprecated Content projection is retired; retained for source compatibility. */
export const DEFAULT_CONTENT_PROJECTION_AGGREGATE_TOKENS = 64_000;

/** Optional reserve fraction for caller-owned planning policy. */
export const MODEL_WINDOW_RESERVE_FRACTION = 0.2;

export interface ModelInputBudget {
	estimatedInputTokens: number;
	contextWindowTokens: number;
	reserveTokens: number;
	dispatchThresholdTokens: number;
	/** @deprecated Estimates are diagnostic only and never authorize rejection. */
	shouldReject: false;
	/** @deprecated Alias of dispatchThresholdTokens for source compatibility. */
	compactionThresholdTokens: number;
	/** @deprecated Always false; automatic compaction is retired. */
	shouldCompact: false;
	estimationMode: "heuristic" | "utf8-upper-bound";
	/** @deprecated Always null; model-name catalog inference is removed. */
	resolvedModelKey: string | null;
}

/** @deprecated Content projection is retired. */
export interface ContentProjectionBudget {
	perResultTokens: number;
	aggregateTokens: number;
}

/**
 * @deprecated Content projection is retired. Complete input must reach the
 * final runtime boundary, which either dispatches it unchanged or rejects it.
 */
export function buildContentProjectionBudget(_args: {
	budget: ModelInputBudget;
	resultCount: number;
	perResultCeilingTokens?: number;
	aggregateCeilingTokens?: number;
}): never {
	throw new ElizaError("Automatic content projection is retired", {
		code: "CONTENT_PROJECTION_RETIRED",
	});
}

function serializedText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value == null) {
		return "";
	}
	try {
		return JSON.stringify(value) ?? "";
	} catch (cause) {
		throw new ElizaError("Model input cannot be serialized completely", {
			code: "MODEL_INPUT_SERIALIZATION_FAILED",
			cause,
		});
	}
}

function textMeasure(
	value: unknown,
	mode: "heuristic" | "utf8-upper-bound",
): number {
	const text = serializedText(value);
	return mode === "utf8-upper-bound"
		? new TextEncoder().encode(text).byteLength
		: text.length;
}

export function estimateTokensFromChars(chars: number): number {
	return Math.ceil(chars / 3.5);
}

export function estimateModelInputTokens(args: {
	/** The complete immutable handler request. When present, it is the sole
	 * measurement authority; the legacy field list remains for diagnostic and
	 * compatibility callers that do not own the final dispatch boundary. */
	completeRequest?: unknown;
	messages?: readonly ChatMessage[];
	promptSegments?: readonly PromptSegment[];
	tools?: readonly ToolDefinition[];
	system?: unknown;
	prompt?: unknown;
	input?: unknown;
	responseSchema?: unknown;
	responseFormat?: unknown;
	grammar?: unknown;
	responseSkeleton?: unknown;
	prefill?: unknown;
	estimationMode?: "heuristic" | "utf8-upper-bound";
}): number {
	const estimationMode = args.estimationMode ?? "heuristic";
	if (Object.hasOwn(args, "completeRequest")) {
		const measured = textMeasure(args.completeRequest, estimationMode);
		return estimationMode === "utf8-upper-bound"
			? measured
			: estimateTokensFromChars(measured);
	}
	const messageChars =
		estimationMode === "utf8-upper-bound"
			? textMeasure(args.messages, estimationMode)
			: (args.messages?.reduce(
					(total, message) =>
						total + textMeasure(message.content, estimationMode),
					0,
				) ?? 0);
	const segmentChars =
		args.messages && args.messages.length > 0
			? 0
			: estimationMode === "utf8-upper-bound"
				? textMeasure(args.promptSegments, estimationMode)
				: (args.promptSegments?.reduce(
						(total, segment) =>
							total + textMeasure(segment.content, estimationMode),
						0,
					) ?? 0);
	const toolChars =
		estimationMode === "utf8-upper-bound"
			? textMeasure(args.tools, estimationMode)
			: (args.tools?.reduce(
					(total, tool) => total + textMeasure(tool, estimationMode),
					0,
				) ?? 0);
	const additionalChars = [
		args.system,
		args.prompt,
		args.input,
		args.responseSchema,
		args.responseFormat,
		args.grammar,
		args.responseSkeleton,
		args.prefill,
	].reduce<number>(
		(total, value) => total + textMeasure(value, estimationMode),
		0,
	);
	const measured = segmentChars + messageChars + toolChars + additionalChars;
	return estimationMode === "utf8-upper-bound"
		? measured
		: estimateTokensFromChars(measured);
}

export function buildModelInputBudget(args: {
	/** Complete final handler request; measured instead of the legacy fields. */
	completeRequest?: unknown;
	messages?: readonly ChatMessage[];
	promptSegments?: readonly PromptSegment[];
	tools?: readonly ToolDefinition[];
	system?: unknown;
	prompt?: unknown;
	input?: unknown;
	responseSchema?: unknown;
	responseFormat?: unknown;
	grammar?: unknown;
	responseSkeleton?: unknown;
	prefill?: unknown;
	/** Conservative final-wire mode: one token per UTF-8 byte upper bound. */
	estimationMode?: "heuristic" | "utf8-upper-bound";
	/** Provider registration or explicit caller window; never inferred from a name. */
	contextWindowTokens?: number;
	/** Explicit output reserve, including zero and values equal to the default. */
	reserveTokens?: number;
	/** Opaque model id retained for diagnostics; it does not select a limit. */
	modelName?: string;
}): ModelInputBudget {
	const explicitWindow =
		Number.isFinite(args.contextWindowTokens) && args.contextWindowTokens
			? Math.max(1, Math.floor(args.contextWindowTokens))
			: undefined;

	// Model names are opaque provider identifiers. Only registration/caller
	// metadata supplies a limit; the legacy fallback is diagnostic, never an
	// authoritative provider limit or permission to discard input.
	const contextWindowTokens = explicitWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
	const reserveTokens =
		Number.isFinite(args.reserveTokens) && args.reserveTokens !== undefined
			? Math.max(0, Math.floor(args.reserveTokens))
			: DEFAULT_INPUT_RESERVE_TOKENS;

	const dispatchThresholdTokens = Math.max(
		1,
		contextWindowTokens - reserveTokens,
	);
	const estimatedInputTokens = estimateModelInputTokens(args);
	const estimationMode = args.estimationMode ?? "heuristic";
	return {
		estimatedInputTokens,
		contextWindowTokens,
		reserveTokens,
		dispatchThresholdTokens,
		// Token estimates are not provider tokenization. Rejecting from them can
		// discard valid complete requests, so only the provider's authoritative
		// boundary may fail this call.
		shouldReject: false,
		compactionThresholdTokens: dispatchThresholdTokens,
		shouldCompact: false,
		estimationMode,
		resolvedModelKey: null,
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
