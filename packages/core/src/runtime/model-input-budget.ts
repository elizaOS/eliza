import type {
	ChatMessage,
	PromptSegment,
	ToolDefinition,
} from "../types/model";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 10_000;

export interface ModelInputBudget {
	estimatedInputTokens: number;
	contextWindowTokens: number;
	reserveTokens: number;
	compactionThresholdTokens: number;
	shouldCompact: boolean;
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
	prompt?: string;
	messages?: readonly ChatMessage[];
	promptSegments?: readonly PromptSegment[];
	tools?: readonly ToolDefinition[];
}): number {
	const messageChars =
		args.messages?.reduce(
			(total, message) => total + textLength(message.content),
			0,
		) ?? 0;
	const promptChars =
		args.messages && args.messages.length > 0
			? 0
			: args.promptSegments && args.promptSegments.length > 0
				? args.promptSegments.reduce(
						(total, segment) => total + textLength(segment.content),
						0,
					)
				: textLength(args.prompt);
	const toolChars =
		args.tools?.reduce((total, tool) => total + textLength(tool), 0) ?? 0;
	return estimateTokensFromChars(promptChars + messageChars + toolChars);
}

export function buildModelInputBudget(args: {
	prompt?: string;
	messages?: readonly ChatMessage[];
	promptSegments?: readonly PromptSegment[];
	tools?: readonly ToolDefinition[];
	contextWindowTokens?: number;
	reserveTokens?: number;
}): ModelInputBudget {
	const contextWindowTokens =
		Number.isFinite(args.contextWindowTokens) && args.contextWindowTokens
			? Math.max(1, Math.floor(args.contextWindowTokens))
			: DEFAULT_CONTEXT_WINDOW_TOKENS;
	const reserveTokens =
		Number.isFinite(args.reserveTokens) && args.reserveTokens !== undefined
			? Math.max(0, Math.floor(args.reserveTokens))
			: DEFAULT_COMPACTION_RESERVE_TOKENS;
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
