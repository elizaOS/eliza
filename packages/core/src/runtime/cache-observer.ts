export interface CacheUsageObservation {
	provider?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	cachedInputTokens?: number;
	rawUsage?: unknown;
}

export interface CacheUsageNormalizationOptions {
	provider?: string;
	model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericValue(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string" && value.trim().length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function recordAt(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const child = value[key];
	return isRecord(child) ? child : {};
}

export function normalizeCacheUsage(
	usage: unknown,
	options: CacheUsageNormalizationOptions = {},
): CacheUsageObservation {
	const root = isRecord(usage) ? usage : {};
	const inputTokenDetails = recordAt(root, "inputTokenDetails");
	const promptTokensDetails = recordAt(root, "prompt_tokens_details");
	const inputTokensDetailsSnake = recordAt(root, "input_tokens_details");

	const cacheReadInputTokens = numericValue(
		root.cacheReadInputTokens,
		root.cache_read_input_tokens,
		root.cacheReadTokens,
		inputTokenDetails.cacheReadTokens,
		inputTokenDetails.cacheRead,
		inputTokenDetails.cachedTokens,
		inputTokenDetails.cached_tokens,
		promptTokensDetails.cache_read_input_tokens,
		inputTokensDetailsSnake.cache_read_input_tokens,
	);

	const cacheCreationInputTokens = numericValue(
		root.cacheCreationInputTokens,
		root.cache_creation_input_tokens,
		root.cacheWriteInputTokens,
		root.cacheWriteTokens,
		inputTokenDetails.cacheCreationInputTokens,
		inputTokenDetails.cacheCreationTokens,
		inputTokenDetails.cacheWriteTokens,
		inputTokenDetails.cacheWrite,
		inputTokensDetailsSnake.cache_creation_input_tokens,
	);

	const cachedInputTokens = numericValue(
		root.cachedInputTokens,
		root.cached_input_tokens,
		root.cachedTokens,
		root.cached_tokens,
		inputTokenDetails.cachedInputTokens,
		inputTokenDetails.cachedTokens,
		inputTokenDetails.cacheReadTokens,
		inputTokenDetails.cacheRead,
		promptTokensDetails.cached_tokens,
		promptTokensDetails.cachedTokens,
		inputTokensDetailsSnake.cached_tokens,
		cacheReadInputTokens,
	);

	return {
		provider: options.provider,
		model: options.model,
		inputTokens: numericValue(
			root.inputTokens,
			root.input_tokens,
			root.promptTokens,
			root.prompt_tokens,
		),
		outputTokens: numericValue(
			root.outputTokens,
			root.output_tokens,
			root.completionTokens,
			root.completion_tokens,
		),
		totalTokens: numericValue(root.totalTokens, root.total_tokens),
		cacheReadInputTokens,
		cacheCreationInputTokens,
		cachedInputTokens,
		rawUsage: usage,
	};
}

export function hasCacheUsage(observation: CacheUsageObservation): boolean {
	return (
		observation.cacheReadInputTokens !== undefined ||
		observation.cacheCreationInputTokens !== undefined ||
		observation.cachedInputTokens !== undefined
	);
}
