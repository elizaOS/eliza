import type { PromptSegment } from "../types/model";
import type { JsonValue } from "../types/primitives.ts";

export type CacheTTL = "short" | "long";

export interface CacheableSection {
	id: string;
	segmentIndex?: number;
	segmentHash?: string;
	cacheable?: boolean;
	stable?: boolean;
	ttl?: CacheTTL;
	priority?: number;
}

export interface ProviderCachePlanArgs {
	prefixHash: string;
	segmentHashes?: readonly string[];
	promptSegments?:
		| readonly Pick<PromptSegment, "stable">[]
		| readonly { stable?: boolean }[];
	sections?: readonly CacheableSection[];
	provider?: string;
	model?: string;
	hasTools?: boolean;
}

export interface AnthropicCacheControl {
	type: "ephemeral";
	ttl?: "1h";
}

export interface AnthropicCacheBreakpoint {
	id?: string;
	segmentIndex: number;
	segmentHash?: string;
	ttl: CacheTTL;
	cacheControl: AnthropicCacheControl;
}

export interface ProviderCachePlan {
	promptCacheKey: string;
	providerOptions: Record<string, JsonValue | object | undefined>;
	anthropic: {
		cacheSystem: boolean;
		maxBreakpoints: number;
		breakpoints: AnthropicCacheBreakpoint[];
	};
	warnings: string[];
}

const MAX_PROMPT_CACHE_KEY_LENGTH = 1024;
const ANTHROPIC_MAX_BREAKPOINTS = 4;

export function buildProviderCachePlan(
	args: ProviderCachePlanArgs,
): ProviderCachePlan {
	const promptCacheKey = buildPromptCacheKey(args.prefixHash);
	const segmentHashes = args.segmentHashes
		? [...args.segmentHashes]
		: undefined;
	const warnings: string[] = [];
	const geminiExplicitCacheDisabled =
		isGeminiProvider(args.provider, args.model) && args.hasTools === true;
	const anthropicBreakpoints = geminiExplicitCacheDisabled
		? []
		: selectAnthropicBreakpoints(args, warnings);

	const openaiOptions: Record<string, JsonValue> = {
		promptCacheKey,
	};
	if (supportsOpenAIExtendedPromptCacheRetention(args.model)) {
		openaiOptions.promptCacheRetention = "24h";
	}

	const providerOptions: Record<string, JsonValue | object | undefined> = {
		eliza: {
			promptCacheKey,
			prefixHash: args.prefixHash,
			...(segmentHashes ? { segmentHashes } : {}),
			cachePlan: {
				version: 1,
				anthropicBreakpoints,
			},
		},
		cerebras: {
			promptCacheKey,
			prompt_cache_key: promptCacheKey,
		},
		openai: openaiOptions,
		openrouter: {
			promptCacheKey,
			prompt_cache_key: promptCacheKey,
		},
		gateway: {
			caching: "auto",
		},
	};

	if (!geminiExplicitCacheDisabled) {
		providerOptions.anthropic = {
			cacheControl: ttlToAnthropicCacheControl("short"),
			cacheSystem: true,
			maxBreakpoints: ANTHROPIC_MAX_BREAKPOINTS,
			cacheBreakpoints: anthropicBreakpoints,
		};
	} else {
		warnings.push(
			"Gemini explicit caching is disabled when tools are present; relying on implicit/provider caching.",
		);
	}

	return {
		promptCacheKey,
		providerOptions,
		anthropic: {
			cacheSystem: !geminiExplicitCacheDisabled,
			maxBreakpoints: ANTHROPIC_MAX_BREAKPOINTS,
			breakpoints: anthropicBreakpoints,
		},
		warnings,
	};
}

export function buildPromptCacheKey(prefixHash: string): string {
	return `v5:${prefixHash}`.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH);
}

function selectAnthropicBreakpoints(
	args: ProviderCachePlanArgs,
	warnings: string[],
): AnthropicCacheBreakpoint[] {
	// The Anthropic adapter also caches the system prompt when present, so only
	// three user-content breakpoints are available under Anthropic's four-block cap.
	const maxSegmentBreakpoints = ANTHROPIC_MAX_BREAKPOINTS - 1;
	const fromSections = selectSectionBreakpoints(args, maxSegmentBreakpoints);
	if (fromSections.length > 0) {
		return fromSections;
	}

	const fromStableRuns = selectStableRunBreakpoints(
		args.promptSegments,
		args.segmentHashes,
		maxSegmentBreakpoints,
	);
	if (
		args.promptSegments &&
		args.promptSegments.filter((segment) => segment.stable).length >
			fromStableRuns.length
	) {
		warnings.push(
			`Anthropic cache markers capped at ${maxSegmentBreakpoints} prompt segments plus system.`,
		);
	}
	return fromStableRuns;
}

function selectSectionBreakpoints(
	args: ProviderCachePlanArgs,
	maxSegmentBreakpoints: number,
): AnthropicCacheBreakpoint[] {
	const sections = (args.sections ?? [])
		.filter((section) => section.cacheable !== false)
		.filter((section) => section.stable !== false)
		.filter((section) => Number.isInteger(section.segmentIndex))
		.map((section) => ({
			section,
			segmentIndex: section.segmentIndex as number,
			priority: section.priority ?? 0,
		}))
		.sort((left, right) => {
			const priorityDelta = right.priority - left.priority;
			return priorityDelta !== 0
				? priorityDelta
				: left.segmentIndex - right.segmentIndex;
		})
		.slice(0, maxSegmentBreakpoints)
		.sort((left, right) => left.segmentIndex - right.segmentIndex);

	return sections.map(({ section, segmentIndex }) => {
		const ttl = section.ttl ?? "short";
		return {
			id: section.id,
			segmentIndex,
			segmentHash:
				section.segmentHash ?? args.segmentHashes?.[segmentIndex] ?? undefined,
			ttl,
			cacheControl: ttlToAnthropicCacheControl(ttl),
		};
	});
}

function selectStableRunBreakpoints(
	promptSegments:
		| readonly Pick<PromptSegment, "stable">[]
		| readonly { stable?: boolean }[]
		| undefined,
	segmentHashes: readonly string[] | undefined,
	maxSegmentBreakpoints: number,
): AnthropicCacheBreakpoint[] {
	if (!promptSegments || promptSegments.length === 0) {
		return [];
	}

	const runEnds: number[] = [];
	let activeStableIndex: number | undefined;
	for (let index = 0; index < promptSegments.length; index++) {
		if (promptSegments[index]?.stable) {
			activeStableIndex = index;
			continue;
		}
		if (activeStableIndex !== undefined) {
			runEnds.push(activeStableIndex);
			activeStableIndex = undefined;
		}
	}
	if (activeStableIndex !== undefined) {
		runEnds.push(activeStableIndex);
	}

	return runEnds.slice(0, maxSegmentBreakpoints).map((segmentIndex) => ({
		segmentIndex,
		segmentHash: segmentHashes?.[segmentIndex],
		ttl: "short" as const,
		cacheControl: ttlToAnthropicCacheControl("short"),
	}));
}

function ttlToAnthropicCacheControl(ttl: CacheTTL): AnthropicCacheControl {
	return ttl === "long"
		? { type: "ephemeral", ttl: "1h" }
		: { type: "ephemeral" };
}

function isGeminiProvider(provider?: string, model?: string): boolean {
	const combined = `${provider ?? ""}/${model ?? ""}`.toLowerCase();
	return combined.includes("google") || combined.includes("gemini");
}

function supportsOpenAIExtendedPromptCacheRetention(model?: string): boolean {
	const normalizedModel = String(model ?? "")
		.toLowerCase()
		.split("/")
		.pop()
		?.split(":")[0];

	return (
		normalizedModel !== undefined &&
		OPENAI_EXTENDED_PROMPT_CACHE_RETENTION_MODELS.has(normalizedModel)
	);
}

const OPENAI_EXTENDED_PROMPT_CACHE_RETENTION_MODELS = new Set([
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-mini",
	"gpt-5.1-chat-latest",
	"gpt-5",
	"gpt-5-codex",
	"gpt-4.1",
]);
