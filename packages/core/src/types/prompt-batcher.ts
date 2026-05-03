import type { Memory } from "./memory";
import type { GenerateTextParams } from "./model";
import type { Content } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { SchemaRow } from "./state";

export type SectionFrequency = "once" | "per-drain" | "recurring";

export interface DrainMeta {
	drainId: string;
	timestamp: number;
	messages: Memory[];
	sectionId: string;
	actualModel: "small" | "large";
	durationMs: number;
	cacheHit: boolean;
	staleRevalidation: boolean;
	packedWith: string[];
	retryAttempt: number;
	fallbackUsed: boolean;
}

/**
 * Result of a batcher section delivery. All section promises (addSection, onDrain) resolve
 * with this shape so callers get both extracted fields and drain metadata in one object.
 * WHY: Single consistent type; meta (fallbackUsed, durationMs, etc.) is available when
 * callers need it. askOnce/askNow unwrap to fields only for backward compatibility.
 */
export interface BatcherResult<T = Record<string, unknown>> {
	fields: T;
	meta: DrainMeta;
}

export interface DrainLog {
	drainId: string;
	agentId: string;
	affinityKey: string;
	timestamp: number;
	durationMs: number;
	sectionsIncluded: string[];
	sectionsSkipped: string[];
	cacheHits: string[];
	callCount: number;
	calls: Array<{
		model: "small" | "large";
		sectionIds: string[];
		estimatedTokens: number;
		durationMs: number;
		success: boolean;
		retried: boolean;
		fallbackUsed: string[];
	}>;
}

export interface BatcherStats {
	totalDrains: number;
	totalCalls: number;
	totalCacheHits: number;
	totalFallbacks: number;
	avgSectionsPerCall: number;
	avgDrainDurationMs: number;
}

export type ContextResolver = (
	runtime: IAgentRuntime,
	messages: Memory[],
) => Promise<string> | string;

export interface PromptSection {
	id: string;
	frequency: SectionFrequency;
	providers?: string[];
	contextBuilder?: (
		runtime: IAgentRuntime,
		messages: Memory[],
	) => Promise<string> | string;
	contextResolvers?: string[];
	dependsOnEvaluators?: boolean;
	preamble?: string;
	priority?: "background" | "normal" | "immediate";
	model?: "small" | "large";
	isolated?: boolean;
	schema: SchemaRow[];
	onResult?: (
		fields: Record<string, unknown>,
		meta: DrainMeta,
	) => void | Promise<void>;
	fallback?: () => Record<string, unknown>;
	validate?: (
		fields: Record<string, unknown>,
	) => Record<string, unknown> | null;
	cacheTtlMs?: number;
	staleWhileRevalidate?: boolean;
	forceRegenerate?: boolean;
	execOptions?: {
		temperature?: number;
		maxTokens?: number;
		stopSequences?: string[];
	};
	shouldRun?: (runtime: IAgentRuntime) => Promise<boolean> | boolean;
	maxRetries?: number;
	minCycleMs?: number;
	affinityKey?: string;
}

export interface ResolvedSection {
	section: PromptSection;
	resolvedContext: string;
	contextCharCount: number;
	schemaFieldCount: number;
	estimatedTokens: number;
	priority: "background" | "normal" | "immediate";
	preferredModel: "small" | "large";
	isolated: boolean;
	affinityKey: string;
	execOptions?: {
		temperature?: number;
		maxTokens?: number;
		stopSequences?: string[];
	};
}

export interface PreCallbackHandler {
	id: string;
	actionFilter: string[];
	schema: SchemaRow[];
	preamble: string;
	providers?: string[];
	model?: "small" | "large";
	execOptions?: {
		temperature?: number;
		maxTokens?: number;
		stopSequences?: string[];
	};
	validate?: (
		fields: Record<string, unknown>,
	) => Record<string, unknown> | null;
	apply: (fields: Record<string, unknown>, content: Content) => Content | null;
	fallback?: () => Record<string, unknown>;
}

export class BatcherDisposedError extends Error {
	constructor() {
		super("PromptBatcher has been disposed");
		this.name = "BatcherDisposedError";
	}
}

export type PromptBatcherExecOptions = NonNullable<
	PromptSection["execOptions"]
>;
export type PromptBatcherGenerateTextParams = Omit<
	GenerateTextParams,
	"prompt"
> & {
	prompt: string;
};
