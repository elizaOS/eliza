import type { JsonValue } from "../types/primitives.ts";

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
	model?: string;
	modelVersion?: string;
	systemPrompt?: string;
	userPrompt?: string;
	response?: string;
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

export interface TrajectoryTrainingMessageRecord {
	role: "system" | "user" | "model";
	content: string;
}

export interface TrajectoryTrainingExampleRecord {
	messages: TrajectoryTrainingMessageRecord[];
}

export interface TrajectoryHarnessExportRow
	extends TrajectoryFlattenedLlmCallRecord,
		TrajectoryTrainingExampleRecord {
	format: "trajectory_harness_v1";
	trajectoryTotals: TrajectoryUsageTotalsRecord;
	cacheStats: TrajectoryCacheStatsRecord;
}

export type TrajectoryJsonShape =
	| "legacy"
	| "context_object_events_v5"
	| "harness_v1";

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
