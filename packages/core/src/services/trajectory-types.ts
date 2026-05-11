import type { JsonValue } from "../types/primitives.ts";

// Re-export the canonical retrieval-funnel shapes from `trajectory-recorder`
// so external consumers can depend on the services-layer surface instead of
// reaching into runtime/. Closes the Wave 2-C funnel-instrumentation
// contract: per-stage retrieval entries + fused top-K + selected/correct
// action lists.
export type {
	RecordedRetrievalStageEntry,
	RecordedRetrievalPerStageScores,
	RecordedToolSearchStage,
} from "../runtime/trajectory-recorder.ts";

export const ELIZA_NATIVE_TRAJECTORY_FORMAT = "eliza_native_v1" as const;

export type ElizaNativeTrajectoryFormat = typeof ELIZA_NATIVE_TRAJECTORY_FORMAT;

export const ELIZA_NATIVE_MODEL_BOUNDARIES = [
	"vercel_ai_sdk.generateText",
	"vercel_ai_sdk.streamText",
] as const;

export type ElizaNativeModelBoundary =
	(typeof ELIZA_NATIVE_MODEL_BOUNDARIES)[number];

export type TrajectoryStatus = "active" | "completed" | "error" | "timeout";

export interface TrajectoryListOptions {
	limit?: number;
	offset?: number;
	source?: string;
	status?: TrajectoryStatus;
	runId?: string;
	startDate?: string;
	endDate?: string;
	search?: string;
	scenarioId?: string;
	batchId?: string;
	isTrainingData?: boolean;
}

export interface TrajectorySummaryRecord {
	id: string;
	agentId: string;
	source: string;
	status: TrajectoryStatus;
	startTime: number;
	endTime: number | null;
	durationMs: number | null;
	llmCallCount: number;
	providerAccessCount: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCacheReadInputTokens?: number;
	totalCacheCreationInputTokens?: number;
	scenarioId?: string | null;
	batchId?: string | null;
	createdAt: string;
	stepCount?: number;
	totalReward?: number;
	roomId?: string | null;
	entityId?: string | null;
	conversationId?: string | null;
	updatedAt?: string;
	metadata?: Record<string, JsonValue | undefined>;
}

export interface TrajectoryListResult<
	TTrajectory extends TrajectorySummaryRecord = TrajectorySummaryRecord,
> {
	trajectories: TTrajectory[];
	total: number;
	offset: number;
	limit: number;
}

export type TrajectoryScalar = string | number | boolean | null;
export type TrajectoryData = Record<string, TrajectoryScalar>;

export interface TrajectoryLlmCallRecord {
	callId?: string;
	stepId?: string;
	trajectoryId?: string;
	timestamp?: number;
	provider?: string;
	model?: string;
	modelVersion?: string;
	modelType?: string;
	systemPrompt?: string;
	userPrompt?: string;
	prompt?: string;
	messages?: unknown[];
	tools?: unknown;
	toolChoice?: unknown;
	output?: unknown;
	responseSchema?: unknown;
	providerOptions?: unknown;
	response?: string;
	toolCalls?: unknown[];
	finishReason?: string;
	providerMetadata?: unknown;
	reasoning?: string;
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	purpose?: string;
	actionType?: string;
	stepType?: string;
	tags?: string[];
	latencyMs?: number;
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	modelSlot?: string;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
	createdAt?: string;
	tokenUsageEstimated?: boolean;
}

export interface TrajectoryProviderAccessRecord {
	providerId?: string;
	stepId?: string;
	trajectoryId?: string;
	providerName?: string;
	purpose?: string;
	data?: Record<string, unknown>;
	query?: Record<string, unknown>;
	timestamp?: number;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
	createdAt?: string;
}

export type TrajectoryStepKind = "llm" | "action";

export type TrajectoryStepId = string;

/**
 * Structured truncation marker shape persisted alongside per-skill
 * invocation records. Mirrors the W1-T4 action-step marker emitted by
 * `applyTrajectoryFieldCap` so downstream consumers can apply identical
 * handling regardless of which seam produced the cap.
 */
export interface TrajectorySkillInvocationTruncationMarker {
	field: "args" | "result";
	originalBytes: number;
	capBytes: number;
}

/**
 * One captured skill invocation. Closes M13 (W1-T5): every USE_SKILL
 * execution emits one of these against the active trajectory step so the
 * trajectory viewer and training pipelines can replay the skill seam in
 * full detail.
 *
 * Shape mirrors the W1-T4 tool-stage capture: encoded JSON strings for
 * structured fields, per-field 64KB cap with a structured marker on
 * overflow. `args` and `result` are stored pre-encoded so reads do not
 * need to re-parse; consumers can `JSON.parse` when they need the
 * structured form.
 */
export interface TrajectorySkillInvocationRecord {
	/** Canonical skill identifier (the slug enabled by the agent). */
	skillSlug: string;
	/** Encoded handler input (JSON string when structured, plain when not). */
	args?: string;
	/** Encoded handler output (JSON string when structured, plain when not). */
	result?: string;
	/** Wall-clock duration of the skill execution. */
	durationMs: number;
	/**
	 * Trajectory step under which the invocation ran. Mirrors the parent
	 * relationship the database trajectory logger uses for child steps.
	 */
	parentStepId: TrajectoryStepId;
	/**
	 * Identifier of the script that was run, when invocation went through
	 * the bundled-script path (`mode='script'`). Absent for guidance-mode.
	 */
	script?: string;
	/** `"script"` or `"guidance"`. */
	mode?: "script" | "guidance";
	/** Whether the skill reported a successful run. */
	success: boolean;
	/** ms-epoch when the invocation started. */
	startedAt: number;
	/** Per-field truncation markers (W1-T4 contract: 64KB caps). */
	truncated?: TrajectorySkillInvocationTruncationMarker[];
}

export interface TrajectoryStepRecord {
	stepId?: TrajectoryStepId;
	timestamp: number;
	llmCalls?: TrajectoryLlmCallRecord[];
	providerAccesses?: TrajectoryProviderAccessRecord[];
	kind?: TrajectoryStepKind;
	childSteps?: TrajectoryStepId[];
	script?: string;
	scriptHash?: string;
	usedSkills?: string[];
	/**
	 * Per-skill invocation records. Closes M13 (W1-T5). Each record carries
	 * `(skillSlug, args, result, durationMs, parentStepId)` plus mode/script
	 * metadata so the trajectory viewer can render the skill seam without
	 * re-running the action.
	 */
	skillInvocations?: TrajectorySkillInvocationRecord[];
}

export const TRAJECTORY_STEP_SCRIPT_MAX_CHARS = 4096;

export interface TrajectoryUsageTotalsRecord {
	stepCount: number;
	llmCallCount: number;
	providerAccessCount: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

export interface TrajectoryCacheStatsRecord {
	totalInputTokens: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	cachedCallCount: number;
	cacheReadCallCount: number;
	cacheWriteCallCount: number;
	tokenUsageEstimatedCallCount: number;
}

export interface TrajectoryDetailRecord {
	trajectoryId: string;
	agentId: string;
	source?: string;
	status?: TrajectoryStatus;
	startTime: number;
	endTime?: number;
	durationMs?: number;
	scenarioId?: string;
	batchId?: string;
	steps?: TrajectoryStepRecord[];
	metrics?: { finalStatus?: string };
	/** Plain JSON-like bag; values are not validated as {@link JsonValue} at the boundary. */
	metadata?: Record<string, unknown>;
	stepsJson?: string;
	totals?: TrajectoryUsageTotalsRecord;
}

export interface TrajectoryFlattenedLlmCallRecord
	extends TrajectoryLlmCallRecord {
	trajectoryId: string;
	agentId: string;
	source?: string;
	status: TrajectoryStatus;
	startTime: number;
	endTime?: number;
	durationMs?: number;
	scenarioId?: string;
	batchId?: string;
	callId: string;
	stepId: string;
	stepIndex: number;
	stepTimestamp: number;
	stepKind?: TrajectoryStepKind;
	callIndex: number;
	timestamp: number;
	tags: string[];
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	tokenUsageEstimated: boolean;
}

export interface ElizaNativeModelRequestRecord {
	prompt?: string;
	system?: string;
	messages?: unknown[];
	tools?: unknown;
	toolChoice?: unknown;
	output?: unknown;
	responseSchema?: unknown;
	providerOptions?: unknown;
	settings?: {
		temperature?: number;
		maxOutputTokens?: number;
		topP?: number;
	};
}

export interface ElizaNativeModelResponseRecord {
	text: string;
	toolCalls?: unknown[];
	finishReason?: string;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
	};
	providerMetadata?: unknown;
}

export interface ElizaNativeTrajectoryRow
	extends Pick<
		TrajectoryFlattenedLlmCallRecord,
		| "trajectoryId"
		| "agentId"
		| "source"
		| "status"
		| "scenarioId"
		| "batchId"
		| "stepId"
		| "callId"
		| "stepIndex"
		| "callIndex"
		| "timestamp"
		| "purpose"
		| "actionType"
		| "stepType"
		| "tags"
		| "model"
		| "modelVersion"
		| "modelType"
		| "provider"
	> {
	format: ElizaNativeTrajectoryFormat;
	schemaVersion: 1;
	boundary: ElizaNativeModelBoundary;
	request: ElizaNativeModelRequestRecord;
	response: ElizaNativeModelResponseRecord;
	metadata: Record<string, unknown>;
	trajectoryTotals: TrajectoryUsageTotalsRecord;
	cacheStats: TrajectoryCacheStatsRecord;
}

export type TrajectoryJsonShape = ElizaNativeTrajectoryFormat;

export type TrajectoryExportFormat = "json" | "jsonl" | "csv" | "art" | "zip";

export interface TrajectoryExportOptions {
	format: TrajectoryExportFormat;
	jsonShape?: TrajectoryJsonShape;
	includePrompts?: boolean;
	trajectoryIds?: string[];
	source?: string;
	status?: TrajectoryStatus;
	runId?: string;
	search?: string;
	startDate?: string;
	endDate?: string;
	scenarioId?: string;
	batchId?: string;
}

export interface TrajectoryExportResult {
	filename: string;
	data: string | Uint8Array;
	mimeType: string;
}
