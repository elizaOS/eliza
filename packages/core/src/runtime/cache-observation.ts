export interface CacheUsageObservation {
	provider?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	cachedInputTokens?: number;
	cacheHitRate?: number;
	rawUsage?: unknown;
}

export interface CacheUsageNormalizationOptions {
	provider?: string;
	model?: string;
}

export interface CacheUsageSummary {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	cachedInputTokens: number;
	cacheHitRate: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const child = value[key];
	return isRecord(child) ? child : {};
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

function usageRoot(value: unknown): Record<string, unknown> {
	const root = isRecord(value) ? value : {};
	const nestedUsage = recordAt(root, "usage");
	return Object.keys(nestedUsage).length > 0 ? nestedUsage : root;
}

export function normalizeCacheUsage(
	usageOrResponse: unknown,
	options: CacheUsageNormalizationOptions = {},
): CacheUsageObservation {
	const root = usageRoot(usageOrResponse);
	const inputTokenDetails = recordAt(root, "inputTokenDetails");
	const promptTokensDetails = recordAt(root, "prompt_tokens_details");
	const inputTokensDetailsSnake = recordAt(root, "input_tokens_details");

	const cacheReadInputTokens = numericValue(
		root.cacheReadInputTokens,
		root.cache_read_input_tokens,
		root.cacheReadTokens,
		root.cache_read_tokens,
		inputTokenDetails.cacheReadTokens,
		inputTokenDetails.cacheReadInputTokens,
		inputTokenDetails.cacheRead,
		promptTokensDetails.cache_read_input_tokens,
		inputTokensDetailsSnake.cache_read_input_tokens,
	);

	const cachedInputTokens = numericValue(
		root.cachedInputTokens,
		root.cached_input_tokens,
		root.cachedTokens,
		root.cached_tokens,
		inputTokenDetails.cachedInputTokens,
		inputTokenDetails.cachedTokens,
		inputTokenDetails.cached_tokens,
		inputTokenDetails.cacheReadTokens,
		promptTokensDetails.cached_tokens,
		promptTokensDetails.cachedTokens,
		inputTokensDetailsSnake.cached_tokens,
		cacheReadInputTokens,
	);

	const cacheCreationInputTokens = numericValue(
		root.cacheCreationInputTokens,
		root.cache_creation_input_tokens,
		root.cacheWriteInputTokens,
		root.cache_write_input_tokens,
		root.cacheWriteTokens,
		root.cache_write_tokens,
		inputTokenDetails.cacheCreationInputTokens,
		inputTokenDetails.cacheCreationTokens,
		inputTokenDetails.cacheWriteTokens,
		inputTokenDetails.cacheCreation,
		inputTokensDetailsSnake.cache_creation_input_tokens,
	);

	const inputTokens = numericValue(
		root.inputTokens,
		root.input_tokens,
		root.promptTokens,
		root.prompt_tokens,
	);
	const outputTokens = numericValue(
		root.outputTokens,
		root.output_tokens,
		root.completionTokens,
		root.completion_tokens,
	);
	const totalTokens = numericValue(root.totalTokens, root.total_tokens);
	const effectiveCachedInputTokens = cachedInputTokens ?? cacheReadInputTokens;
	const effectiveCacheReadInputTokens =
		cacheReadInputTokens ?? cachedInputTokens;

	return {
		provider: options.provider,
		model: options.model,
		inputTokens,
		outputTokens,
		totalTokens,
		cacheReadInputTokens: effectiveCacheReadInputTokens,
		cacheCreationInputTokens,
		cachedInputTokens: effectiveCachedInputTokens,
		cacheHitRate: cacheHitRate({
			provider: options.provider,
			inputTokens,
			cacheReadInputTokens: effectiveCacheReadInputTokens,
			cacheCreationInputTokens,
			cachedInputTokens: effectiveCachedInputTokens,
		}),
		rawUsage: usageOrResponse,
	};
}

function usesAdditiveCacheDenominator(provider?: string): boolean {
	return provider?.toLowerCase() === "anthropic";
}

export function cacheHitRate(observation: {
	provider?: string;
	inputTokens?: number;
	cachedInputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}): number | undefined {
	const inputTokens = observation.inputTokens;
	const cacheRead =
		observation.cacheReadInputTokens ?? observation.cachedInputTokens;
	if (!inputTokens || inputTokens <= 0 || cacheRead === undefined) {
		return undefined;
	}
	if (usesAdditiveCacheDenominator(observation.provider)) {
		const denom =
			inputTokens +
			(observation.cacheReadInputTokens ?? 0) +
			(observation.cacheCreationInputTokens ?? 0);
		return denom > 0 ? cacheRead / denom : undefined;
	}
	return cacheRead / inputTokens;
}

export function hasCacheUsage(observation: CacheUsageObservation): boolean {
	return (
		observation.cacheReadInputTokens !== undefined ||
		observation.cacheCreationInputTokens !== undefined ||
		observation.cachedInputTokens !== undefined
	);
}

export function summarizeCacheUsage(
	observations: CacheUsageObservation[],
): CacheUsageSummary {
	const summary: CacheUsageSummary = {
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		cachedInputTokens: 0,
		cacheHitRate: 0,
	};

	for (const observation of observations) {
		summary.calls += 1;
		summary.inputTokens += observation.inputTokens ?? 0;
		summary.outputTokens += observation.outputTokens ?? 0;
		summary.totalTokens += observation.totalTokens ?? 0;
		summary.cacheReadInputTokens += observation.cacheReadInputTokens ?? 0;
		summary.cacheCreationInputTokens +=
			observation.cacheCreationInputTokens ?? 0;
		summary.cachedInputTokens += observation.cachedInputTokens ?? 0;
	}

	let denom = 0;
	let cacheReads = 0;
	for (const observation of observations) {
		denom += observation.inputTokens ?? 0;
		if (usesAdditiveCacheDenominator(observation.provider)) {
			denom +=
				(observation.cacheReadInputTokens ?? 0) +
				(observation.cacheCreationInputTokens ?? 0);
		}
		cacheReads +=
			observation.cacheReadInputTokens ?? observation.cachedInputTokens ?? 0;
	}
	summary.cacheHitRate = denom > 0 ? cacheReads / denom : 0;
	return summary;
}
