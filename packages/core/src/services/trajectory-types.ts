import type { JsonValue } from "../types/primitives.ts";

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

export type TrajectoryStepKind = "llm" | "action" | "executeCode";

export type TrajectoryStepId = string;

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
