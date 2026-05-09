/**
 * Trajectory Logger Service
 *
 * A proper @elizaos/core Service that:
 * - Registers as "trajectories" so the runtime can find it
 * - Persists trajectories to the database
 * - Supports both runtime logging AND RL training data collection
 * - Provides API for UI viewing and export
 */

import { sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../../logger";
import { serializeTrajectoryExport } from "../../services/trajectory-export";
import type {
	TrajectoryExportOptions as CanonicalTrajectoryExportOptions,
	TrajectoryDetailRecord,
	TrajectoryExportResult,
} from "../../services/trajectory-types";

/** Public alias for {@link CanonicalTrajectoryExportOptions} (canonical type lives in services). */
export type TrajectoryExportOptions = CanonicalTrajectoryExportOptions;

import type { TrajectoryRuntimeLlmCallParams } from "../../trajectory-utils";
import type { IAgentRuntime } from "../../types";
import { Service } from "../../types/service";

import type {
	ActionAttempt,
	EnvironmentState,
	JsonObject,
	JsonValue,
	LLMCall,
	ProviderAccess,
	RewardComponents,
	Trajectory,
	TrajectoryStep,
} from "./types";

// ============================================================================
// Database Row Types
// ============================================================================

type SqlPrimitive = string | number | boolean | null;
interface SqlCellArray extends Array<SqlCell> {}
type SqlCell = SqlPrimitive | Date | SqlRow | SqlCellArray;
interface SqlRow {
	[key: string]: SqlCell;
}

interface SqlExecuteResult {
	rows: SqlRow[];
	fields?: Array<{ name: string }>;
}

// ============================================================================
// List/Filter Options
// ============================================================================

export interface TrajectoryListOptions {
	limit?: number;
	offset?: number;
	status?: "active" | "completed" | "error" | "timeout";
	source?: string;
	startDate?: string;
	endDate?: string;
	search?: string;
	scenarioId?: string;
	batchId?: string;
	isTrainingData?: boolean;
}

export interface TrajectoryListResult {
	trajectories: TrajectoryListItem[];
	total: number;
	offset: number;
	limit: number;
}

export interface TrajectoryListItem {
	id: string;
	agentId: string;
	source: string;
	status: "active" | "completed" | "error" | "timeout";
	startTime: number;
	endTime: number | null;
	durationMs: number | null;
	stepCount: number;
	llmCallCount: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalReward: number;
	scenarioId: string | null;
	batchId: string | null;
	createdAt: string;
}

export interface TrajectoryStats {
	totalTrajectories: number;
	totalSteps: number;
	totalLlmCalls: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	averageDurationMs: number;
	averageReward: number;
	bySource: Record<string, number>;
	byStatus: Record<string, number>;
	byScenario: Record<string, number>;
}

export interface TrajectoryZipExportOptions {
	includePrompts?: boolean;
	trajectoryIds?: string[];
	startDate?: string;
	endDate?: string;
	scenarioId?: string;
	batchId?: string;
}

export interface TrajectoryZipEntry {
	name: string;
	data: string;
}

export interface TrajectoryZipExportResult {
	filename: string;
	entries: TrajectoryZipEntry[];
}

// ============================================================================
// SQL Helpers
// ============================================================================

function asNumber(value: SqlCell | undefined): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function asString(value: SqlCell | undefined): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (value instanceof Date) return value.toISOString();
	return null;
}

function asIsoString(value: SqlCell | undefined): string {
	if (value instanceof Date) return value.toISOString();
	const asText = asString(value);
	if (!asText) return new Date(0).toISOString();
	const parsed = new Date(asText);
	if (Number.isNaN(parsed.getTime())) return new Date(0).toISOString();
	return parsed.toISOString();
}

function pickCell(row: SqlRow, ...keys: string[]): SqlCell | undefined {
	for (const key of keys) {
		if (Object.hasOwn(row, key)) {
			return row[key];
		}
	}
	return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (isPlainRecord(value)) {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

function isJsonObject(value: unknown): value is JsonObject {
	return isPlainRecord(value) && isJsonValue(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function stringArrayValue(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string")
		? value
		: undefined;
}

function parseJsonCell(cell: SqlCell | undefined): JsonValue | undefined {
	if (typeof cell === "string") {
		try {
			const parsed: unknown = JSON.parse(cell);
			return isJsonValue(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return isJsonValue(cell) ? cell : undefined;
}

function parseJsonObjectCell(cell: SqlCell | undefined): JsonObject | undefined {
	const value = parseJsonCell(cell);
	return isJsonObject(value) ? value : undefined;
}

function normalizeEnvironmentState(value: unknown): EnvironmentState | null {
	if (!isPlainRecord(value)) return null;
	const timestamp = numberValue(value.timestamp);
	const agentBalance = numberValue(value.agentBalance);
	const agentPoints = numberValue(value.agentPoints);
	const agentPnL = numberValue(value.agentPnL);
	const openPositions = numberValue(value.openPositions);
	if (
		timestamp === null ||
		agentBalance === null ||
		agentPoints === null ||
		agentPnL === null ||
		openPositions === null
	) {
		return null;
	}
	const state: EnvironmentState = {
		timestamp,
		agentBalance,
		agentPoints,
		agentPnL,
		openPositions,
	};
	for (const key of [
		"activeMarkets",
		"portfolioValue",
		"unreadMessages",
		"recentEngagement",
	] as const) {
		const numericValue = numberValue(value[key]);
		if (numericValue !== null) {
			state[key] = numericValue;
		}
	}
	if (isJsonObject(value.custom)) {
		state.custom = value.custom;
	}
	return state;
}

function normalizeLlmCall(value: unknown): LLMCall | null {
	if (!isPlainRecord(value)) return null;
	const callId = stringValue(value.callId);
	const timestamp = numberValue(value.timestamp);
	const model = stringValue(value.model);
	const systemPrompt = stringValue(value.systemPrompt);
	const userPrompt = stringValue(value.userPrompt);
	const response = stringValue(value.response);
	const temperature = numberValue(value.temperature);
	const maxTokens = numberValue(value.maxTokens);
	const purpose = stringValue(value.purpose);
	if (
		!callId ||
		timestamp === null ||
		!model ||
		systemPrompt === null ||
		userPrompt === null ||
		response === null ||
		temperature === null ||
		maxTokens === null ||
		!purpose
	) {
		return null;
	}
	const call: LLMCall = {
		callId,
		timestamp,
		model,
		systemPrompt,
		userPrompt,
		response,
		temperature,
		maxTokens,
		purpose,
	};
	for (const key of [
		"modelVersion",
		"modelType",
		"provider",
		"prompt",
		"finishReason",
		"reasoning",
		"actionType",
		"stepType",
		"modelSlot",
		"runId",
		"roomId",
		"messageId",
		"executionTraceId",
	] as const) {
		const textValue = stringValue(value[key]);
		if (textValue !== null) {
			call[key] = textValue;
		}
	}
	for (const key of [
		"topP",
		"promptTokens",
		"completionTokens",
		"latencyMs",
		"cacheReadInputTokens",
		"cacheCreationInputTokens",
	] as const) {
		const numericValue = numberValue(value[key]);
		if (numericValue !== null) {
			call[key] = numericValue;
		}
	}
	const tags = stringArrayValue(value.tags);
	if (tags) call.tags = tags;
	if (Array.isArray(value.messages)) call.messages = value.messages;
	if (Array.isArray(value.toolCalls)) call.toolCalls = value.toolCalls;
	if ("tools" in value) call.tools = value.tools;
	if ("toolChoice" in value) call.toolChoice = value.toolChoice;
	if ("responseSchema" in value) call.responseSchema = value.responseSchema;
	if ("providerOptions" in value) call.providerOptions = value.providerOptions;
	if ("providerMetadata" in value) call.providerMetadata = value.providerMetadata;
	return call;
}

function normalizeProviderAccess(value: unknown): ProviderAccess | null {
	if (!isPlainRecord(value)) return null;
	const providerId = stringValue(value.providerId);
	const providerName = stringValue(value.providerName);
	const timestamp = numberValue(value.timestamp);
	const data = isJsonObject(value.data) ? value.data : null;
	const purpose = stringValue(value.purpose);
	if (!providerId || !providerName || timestamp === null || !data || !purpose) {
		return null;
	}
	const access: ProviderAccess = {
		providerId,
		providerName,
		timestamp,
		data,
		purpose,
	};
	if (isJsonObject(value.query)) access.query = value.query;
	for (const key of [
		"runId",
		"roomId",
		"messageId",
		"executionTraceId",
	] as const) {
		const textValue = stringValue(value[key]);
		if (textValue !== null) {
			access[key] = textValue;
		}
	}
	return access;
}

function normalizeActionAttempt(value: unknown): ActionAttempt | null {
	if (!isPlainRecord(value)) return null;
	const attemptId = stringValue(value.attemptId);
	const timestamp = numberValue(value.timestamp);
	const actionType = stringValue(value.actionType);
	const actionName = stringValue(value.actionName);
	const parameters = isJsonObject(value.parameters) ? value.parameters : null;
	const success = booleanValue(value.success);
	if (
		!attemptId ||
		timestamp === null ||
		!actionType ||
		!actionName ||
		!parameters ||
		success === null
	) {
		return null;
	}
	const action: ActionAttempt = {
		attemptId,
		timestamp,
		actionType,
		actionName,
		parameters,
		success,
	};
	const reasoning = stringValue(value.reasoning);
	if (reasoning !== null) action.reasoning = reasoning;
	const llmCallId = stringValue(value.llmCallId);
	if (llmCallId !== null) action.llmCallId = llmCallId;
	if (isJsonObject(value.result)) action.result = value.result;
	const error = stringValue(value.error);
	if (error !== null) action.error = error;
	const immediateReward = numberValue(value.immediateReward);
	if (immediateReward !== null) action.immediateReward = immediateReward;
	return action;
}

function normalizeTrajectoryStep(value: unknown): TrajectoryStep | null {
	if (!isPlainRecord(value)) return null;
	const stepId = stringValue(value.stepId);
	const stepNumber = numberValue(value.stepNumber);
	const timestamp = numberValue(value.timestamp);
	const environmentState = normalizeEnvironmentState(value.environmentState);
	const observation = isJsonObject(value.observation) ? value.observation : null;
	const action = normalizeActionAttempt(value.action);
	const reward = numberValue(value.reward);
	const done = booleanValue(value.done);
	if (
		!stepId ||
		stepNumber === null ||
		timestamp === null ||
		!environmentState ||
		!observation ||
		!Array.isArray(value.llmCalls) ||
		!Array.isArray(value.providerAccesses) ||
		!action ||
		reward === null ||
		done === null
	) {
		return null;
	}
	const llmCalls: LLMCall[] = [];
	for (const callValue of value.llmCalls) {
		const call = normalizeLlmCall(callValue);
		if (!call) return null;
		llmCalls.push(call);
	}
	const providerAccesses: ProviderAccess[] = [];
	for (const accessValue of value.providerAccesses) {
		const access = normalizeProviderAccess(accessValue);
		if (!access) return null;
		providerAccesses.push(access);
	}
	const step: TrajectoryStep = {
		stepId,
		stepNumber,
		timestamp,
		environmentState,
		observation,
		llmCalls,
		providerAccesses,
		action,
		reward,
		done,
	};
	const reasoning = stringValue(value.reasoning);
	if (reasoning !== null) step.reasoning = reasoning;
	if (isJsonObject(value.metadata)) step.metadata = value.metadata;
	return step;
}

function parseTrajectorySteps(cell: SqlCell | undefined): TrajectoryStep[] {
	const value = parseJsonCell(cell);
	if (!Array.isArray(value)) return [];
	const steps: TrajectoryStep[] = [];
	for (const stepValue of value) {
		const step = normalizeTrajectoryStep(stepValue);
		if (!step) return [];
		steps.push(step);
	}
	return steps;
}

function parseRewardComponents(cell: SqlCell | undefined): RewardComponents {
	const value = parseJsonObjectCell(cell);
	if (!value || typeof value.environmentReward !== "number") {
		return { environmentReward: 0 };
	}
	const reward: RewardComponents = {
		environmentReward: value.environmentReward,
	};
	if (typeof value.aiJudgeReward === "number") {
		reward.aiJudgeReward = value.aiJudgeReward;
	}
	if (isJsonObject(value.components)) {
		const components: NonNullable<RewardComponents["components"]> = {};
		for (const [key, componentValue] of Object.entries(value.components)) {
			if (typeof componentValue === "number") {
				components[key] = componentValue;
			}
		}
		reward.components = components;
	}
	const judgeModel = stringValue(value.judgeModel);
	if (judgeModel !== null) reward.judgeModel = judgeModel;
	const judgeReasoning = stringValue(value.judgeReasoning);
	if (judgeReasoning !== null) reward.judgeReasoning = judgeReasoning;
	if (typeof value.judgeTimestamp === "number") {
		reward.judgeTimestamp = value.judgeTimestamp;
	}
	return reward;
}

function parseTrajectoryMetrics(
	cell: SqlCell | undefined,
): Trajectory["metrics"] {
	const value = parseJsonObjectCell(cell);
	const finalStatus = value?.finalStatus;
	const metrics: Trajectory["metrics"] = {
		episodeLength:
			typeof value?.episodeLength === "number" ? value.episodeLength : 0,
		finalStatus:
			finalStatus === "completed" ||
			finalStatus === "terminated" ||
			finalStatus === "error" ||
			finalStatus === "timeout"
				? finalStatus
				: "completed",
	};
	if (!value) return metrics;
	for (const [key, metricValue] of Object.entries(value)) {
		metrics[key] = metricValue;
	}
	return metrics;
}

function parseTrajectoryMetadata(
	cell: SqlCell | undefined,
): Trajectory["metadata"] {
	const value = parseJsonObjectCell(cell);
	return value ?? {};
}

function sqlLiteral(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") return String(v);
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	if (typeof v === "object")
		return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
	return `'${String(v).replace(/'/g, "''")}'`;
}

type TrajectoryStatus =
	| "active"
	| "completed"
	| "error"
	| "timeout"
	| "terminated";

type StartTrajectoryOptions = {
	agentId?: string;
	roomId?: string;
	entityId?: string;
	source?: string;
	scenarioId?: string;
	episodeId?: string;
	batchId?: string;
	groupIndex?: number;
	metadata?: Record<string, JsonValue>;
};

type CompleteStepRewardInfo = {
	reward?: number;
	components?: Partial<RewardComponents>;
};

interface StepIndexRow {
	trajectoryId: string;
	stepNumber: number;
	isActive: boolean;
}

// ============================================================================
// Trajectories Service
// ============================================================================

export class TrajectoriesService extends Service {
	static serviceType = "trajectories";
	get serviceType() {
		return TrajectoriesService.serviceType;
	}

	capabilityDescription =
		"Captures and persists LLM calls, provider accesses, and full trajectories for debugging, analysis, and RL training";

	/**
	 * Resolve the *real* SQL-backed TrajectoriesService from the runtime.
	 *
	 * The Eliza core registers a lightweight no-op stub under the same
	 * "trajectories" serviceType.  getService() returns whichever
	 * instance was started first (usually the stub).  This helper scans
	 * all registered services of that type and returns the one that
	 * actually exposes the full trajectory lifecycle API (startTrajectory).
	 */
	/**
	 * Synchronous lookup — returns null if the real service hasn't started yet.
	 */
	static resolveFromRuntime(
		runtime: IAgentRuntime,
	): TrajectoriesService | null {
		// Fast path — if getService already returns the real one, use it.
		const first = runtime.getService(
			TrajectoriesService.serviceType,
		) as Service | null;
		if (first instanceof TrajectoriesService) {
			return first;
		}

		// Slow path — the core stub won, scan all services for the real one.
		const all =
			typeof runtime.getServicesByType === "function"
				? runtime.getServicesByType(TrajectoriesService.serviceType)
				: [];
		for (const svc of all) {
			if (svc instanceof TrajectoriesService) {
				return svc;
			}
		}
		return null;
	}

	/**
	 * Async version that waits for the real SQL-backed service to finish
	 * starting.  The core registers a no-op stub that starts synchronously;
	 * the real plugin starts asynchronously (DB init).  This method polls
	 * briefly so callers don't have to guess at timing.
	 */
	static async waitForService(
		runtime: IAgentRuntime,
		timeoutMs = 10_000,
	): Promise<TrajectoriesService | null> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const svc = TrajectoriesService.resolveFromRuntime(runtime);
			if (svc) return svc;
			await new Promise((r) => setTimeout(r, 50));
		}
		return null;
	}

	private enabled = true;
	private initialized = false;

	// Only keep lightweight ID caches for sync compatibility.
	// Trajectory payloads are always read from / written to the database.
	private activeStepIds: Map<string, string> = new Map();
	private stepToTrajectory: Map<string, string> = new Map();
	private writeQueues: Map<string, Promise<void>> = new Map();

	private exposeBoundMethods(): void {
		const service = this as this & {
			startTrajectory: TrajectoriesService["startTrajectory"];
			endTrajectory: TrajectoriesService["endTrajectory"];
			startStep: TrajectoriesService["startStep"];
			getCurrentStepId: TrajectoriesService["getCurrentStepId"];
			completeStep: TrajectoriesService["completeStep"];
			logLLMCall: TrajectoriesService["logLLMCall"];
			logProviderAccess: TrajectoriesService["logProviderAccess"];
			logProviderAccessByTrajectoryId: TrajectoriesService["logProviderAccessByTrajectoryId"];
			isEnabled: TrajectoriesService["isEnabled"];
			listTrajectories: TrajectoriesService["listTrajectories"];
			getTrajectoryDetail: TrajectoriesService["getTrajectoryDetail"];
			flushWriteQueue: TrajectoriesService["flushWriteQueue"];
		};

		service.startTrajectory = this.startTrajectory.bind(this);
		service.endTrajectory = this.endTrajectory.bind(this);
		service.startStep = this.startStep.bind(this);
		service.getCurrentStepId = this.getCurrentStepId.bind(this);
		service.completeStep = this.completeStep.bind(this);
		service.logLLMCall = this.logLLMCall.bind(this);
		service.logProviderAccess = this.logProviderAccess.bind(this);
		service.logProviderAccessByTrajectoryId =
			this.logProviderAccessByTrajectoryId.bind(this);
		service.isEnabled = this.isEnabled.bind(this);
		service.listTrajectories = this.listTrajectories.bind(this);
		service.getTrajectoryDetail = this.getTrajectoryDetail.bind(this);
		service.flushWriteQueue = this.flushWriteQueue.bind(this);
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new TrajectoriesService(runtime);
		await service.initialize();
		return service;
	}

	async stop(): Promise<void> {
		this.enabled = false;
		await Promise.allSettled(this.writeQueues.values());
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Initialization
	// ─────────────────────────────────────────────────────────────────────────

	private getSqlHelper(): typeof sql {
		return sql;
	}

	private async executeRawSql(
		sqlText: string,
	): Promise<{ rows: SqlRow[]; columns: string[] }> {
		const runtime = this.runtime as IAgentRuntime & {
			adapter?: { db?: unknown };
		};
		if (!runtime?.adapter) {
			throw new Error("Database adapter not available");
		}

		const sqlHelper = this.getSqlHelper();
		const dbCandidate = runtime.adapter.db as { execute?: unknown } | undefined;
		// Adapters without SQL support (e.g. InMemoryDatabaseAdapter used in tests)
		// expose `db = {}` rather than a Drizzle handle. Treat schema/CRUD calls as
		// no-ops so trajectory logging can degrade gracefully instead of spamming
		// "db.execute is not a function" for every step.
		if (!dbCandidate || typeof dbCandidate.execute !== "function") {
			return { rows: [], columns: [] };
		}
		const db = dbCandidate as {
			execute(query: ReturnType<typeof sql.raw>): Promise<SqlExecuteResult>;
		};
		const query = sqlHelper.raw(sqlText);
		const result = await db.execute(query);
		const rows = Array.isArray(result.rows) ? result.rows : [];
		const columns =
			result.fields && Array.isArray(result.fields)
				? result.fields.map((field) => field.name)
				: rows.length > 0
					? Object.keys(rows[0])
					: [];
		return { rows, columns };
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.exposeBoundMethods();

		const runtime = this.runtime as IAgentRuntime & {
			adapter?: { db?: unknown };
		};
		if (!runtime?.adapter) {
			logger.warn(
				"[trajectory-logger] No runtime adapter available, skipping initialization",
			);
			return;
		}

		const db = runtime.adapter.db as { execute?: unknown } | undefined;
		if (!db || typeof db.execute !== "function") {
			logger.warn(
				"[trajectory-logger] Runtime adapter does not support db.execute (likely InMemory adapter); skipping table setup",
			);
			return;
		}

		await this.ensureTablesExist();

		// NOTE: trajectory logging for useModel calls is handled natively in
		// the core runtime (runtime.ts useModel), which checks
		// getTrajectoryContext() and calls trajLogger.logLlmCall() when a
		// trajectory step is active.  No monkey-patching needed here.

		this.initialized = true;
		logger.info("[trajectories] Trajectories service initialized");
	}

	private async ensureStorageReady(): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
			return;
		}

		await this.ensureTablesExist();
	}

	private async getTableColumnNames(tableName: string): Promise<Set<string>> {
		const names = new Set<string>();

		// PostgreSQL path.
		try {
			const result = await this.executeRawSql(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = ${sqlLiteral(tableName)}
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
      `);
			for (const row of result.rows) {
				const name = asString(pickCell(row, "column_name"));
				if (name) names.add(name);
			}
			if (names.size > 0) return names;
		} catch {
			// Fall through to SQLite-compatible PRAGMA lookup.
		}

		// SQLite / generic fallback.
		const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, "");
		if (!safeTableName) return names;
		try {
			const pragma = await this.executeRawSql(
				`PRAGMA table_info(${safeTableName})`,
			);
			for (const row of pragma.rows) {
				const name = asString(pickCell(row, "name"));
				if (name) names.add(name);
			}
		} catch {
			// Ignore lookup failures; callers will perform best-effort migrations.
		}

		return names;
	}

	private async ensureTrajectoryColumnsExist(): Promise<void> {
		let columns = await this.getTableColumnNames("trajectories");
		const requiredColumns: Array<[name: string, definition: string]> = [
			["scenario_id", "TEXT"],
			["episode_id", "TEXT"],
			["batch_id", "TEXT"],
			["group_index", "INTEGER"],
			["steps_json", "JSONB NOT NULL DEFAULT '[]'"],
			["reward_components_json", "JSONB NOT NULL DEFAULT '{}'"],
			["metrics_json", "JSONB NOT NULL DEFAULT '{}'"],
			["metadata_json", "JSONB NOT NULL DEFAULT '{}'"],
			["is_training_data", "BOOLEAN NOT NULL DEFAULT FALSE"],
			["is_evaluation", "BOOLEAN NOT NULL DEFAULT FALSE"],
			["used_in_training", "BOOLEAN NOT NULL DEFAULT FALSE"],
			["judged_at", "TIMESTAMPTZ"],
		];

		for (const [columnName, definition] of requiredColumns) {
			if (columns.has(columnName)) continue;
			await this.executeRawSql(
				`ALTER TABLE trajectories ADD COLUMN ${columnName} ${definition}`,
			);
			columns = await this.getTableColumnNames("trajectories");
			if (columns.has(columnName)) {
				logger.info(
					`[trajectory-logger] Added missing trajectories.${columnName} column`,
				);
				continue;
			}
			throw new Error(
				`[trajectory-logger] Missing required trajectories.${columnName} column (${definition}). Automatic migration did not apply cleanly.`,
			);
		}

		// Legacy Eliza schema used 32-bit INTEGER for ms timestamps. Upgrade to
		// BIGINT so runtime timestamps (Date.now()) can be stored safely.
		// This migration is Postgres-specific. Ignore on adapters that don't support it.
		for (const statement of [
			`ALTER TABLE trajectories
       ALTER COLUMN start_time TYPE BIGINT USING start_time::BIGINT`,
			`ALTER TABLE trajectories
       ALTER COLUMN end_time TYPE BIGINT USING end_time::BIGINT`,
			`ALTER TABLE trajectories
       ALTER COLUMN duration_ms TYPE BIGINT USING duration_ms::BIGINT`,
		]) {
			try {
				await this.executeRawSql(statement);
			} catch {
				// Non-fatal portability fallback.
			}
		}
	}

	private async ensureTablesExist(): Promise<void> {
		// Main trajectories table
		await this.executeRawSql(`
      CREATE TABLE IF NOT EXISTS trajectories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'chat',
        status TEXT NOT NULL DEFAULT 'active',
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms BIGINT,
        step_count INTEGER NOT NULL DEFAULT 0,
        llm_call_count INTEGER NOT NULL DEFAULT 0,
        provider_access_count INTEGER NOT NULL DEFAULT 0,
        total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        total_completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_reward REAL NOT NULL DEFAULT 0,
        scenario_id TEXT,
        episode_id TEXT,
        batch_id TEXT,
        group_index INTEGER,
        steps_json JSONB NOT NULL DEFAULT '[]',
        reward_components_json JSONB NOT NULL DEFAULT '{}',
        metrics_json JSONB NOT NULL DEFAULT '{}',
        metadata_json JSONB NOT NULL DEFAULT '{}',
        is_training_data BOOLEAN NOT NULL DEFAULT FALSE,
        is_evaluation BOOLEAN NOT NULL DEFAULT FALSE,
        used_in_training BOOLEAN NOT NULL DEFAULT FALSE,
        ai_judge_reward REAL,
        ai_judge_reasoning TEXT,
        judged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
		await this.ensureTrajectoryColumnsExist();

		// Indexes for common queries
		try {
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_agent_id ON trajectories(agent_id)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_source ON trajectories(source)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_status ON trajectories(status)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_created_at ON trajectories(created_at)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_scenario_id ON trajectories(scenario_id)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_batch_id ON trajectories(batch_id)`,
			);
			await this.executeRawSql(
				`CREATE INDEX IF NOT EXISTS idx_trajectories_is_training ON trajectories(is_training_data)`,
			);
		} catch (e) {
			// Ignore index creation errors (e.g. if they already exist or are being created by another process)
			logger.warn(
				`[trajectory-logger] Failed to create indexes (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		// Step index keeps step -> trajectory mapping in DB so logs remain routable
		// across process restarts.
		await this.executeRawSql(`
      CREATE TABLE IF NOT EXISTS trajectory_step_index (
        step_id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
		await this.executeRawSql(
			`CREATE INDEX IF NOT EXISTS idx_trajectory_step_index_trajectory_id ON trajectory_step_index(trajectory_id)`,
		);
		await this.executeRawSql(
			`CREATE INDEX IF NOT EXISTS idx_trajectory_step_index_is_active ON trajectory_step_index(is_active)`,
		);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Runtime Interface (called by @elizaos/core runtime)
	// ─────────────────────────────────────────────────────────────────────────

	private normalizePurpose(value: string): LLMCall["purpose"] {
		if (typeof value !== "string" || value.trim() === "") {
			throw new Error(
				`[TrajectoriesService] trajectory purpose must be a non-empty string; got ${JSON.stringify(value)}`,
			);
		}
		return value.trim();
	}

	private defaultEnvironmentState(timestamp = Date.now()): EnvironmentState {
		return {
			timestamp,
			agentBalance: 0,
			agentPoints: 0,
			agentPnL: 0,
			openPositions: 0,
		};
	}

	private createPendingAction(stepTimestamp: number): ActionAttempt {
		return {
			attemptId: "",
			timestamp: stepTimestamp,
			actionType: "pending",
			actionName: "pending",
			parameters: {},
			success: false,
		};
	}

	private createStep(
		stepId: string,
		stepNumber: number,
		envState: EnvironmentState,
	): TrajectoryStep {
		const timestamp = envState.timestamp || Date.now();
		return {
			stepId: stepId as `${string}-${string}-${string}-${string}-${string}`,
			stepNumber,
			timestamp,
			environmentState: envState,
			observation: {},
			llmCalls: [],
			providerAccesses: [],
			action: this.createPendingAction(timestamp),
			reward: 0,
			done: false,
		};
	}

	private computeTotals(steps: TrajectoryStep[]): {
		stepCount: number;
		llmCallCount: number;
		providerAccessCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
	} {
		let llmCallCount = 0;
		let providerAccessCount = 0;
		let totalPromptTokens = 0;
		let totalCompletionTokens = 0;
		for (const step of steps) {
			const llmCalls = Array.isArray(step.llmCalls) ? step.llmCalls : [];
			const providerAccesses = Array.isArray(step.providerAccesses)
				? step.providerAccesses
				: [];
			llmCallCount += llmCalls.length;
			providerAccessCount += providerAccesses.length;
			for (const call of llmCalls) {
				totalPromptTokens += call.promptTokens ?? 0;
				totalCompletionTokens += call.completionTokens ?? 0;
			}
		}
		return {
			stepCount: steps.length,
			llmCallCount,
			providerAccessCount,
			totalPromptTokens,
			totalCompletionTokens,
		};
	}

	/**
	 * Flush any pending writes for a trajectory.
	 * Call before endTrajectory to ensure fire-and-forget writes
	 * (logLLMCall, completeStep) have persisted.
	 */
	async flushWriteQueue(trajectoryId: string): Promise<void> {
		const pending = this.writeQueues.get(trajectoryId);
		if (pending) {
			await pending.catch((err) => {
				logger.error(
					{ err, trajectoryId },
					"[trajectory-logger] flushWriteQueue: pending trajectory write failed",
				);
				throw err;
			});
		}
	}

	private async withTrajectoryWriteLock(
		trajectoryId: string,
		task: () => Promise<void>,
	): Promise<void> {
		const previous = this.writeQueues.get(trajectoryId) ?? Promise.resolve();
		const next = previous
			.catch(() => {
				// Keep queue alive after failures.
			})
			.then(task);
		this.writeQueues.set(trajectoryId, next);
		try {
			await next;
		} finally {
			if (this.writeQueues.get(trajectoryId) === next) {
				this.writeQueues.delete(trajectoryId);
			}
		}
	}

	private reportDetachedWriteFailure(
		message: string,
		metadata: Record<string, unknown>,
		err: unknown,
	): void {
		logger.error({ err, ...metadata }, message);
	}

	private async getTrajectoryById(
		trajectoryId: string,
	): Promise<Trajectory | null> {
		const result = await this.executeRawSql(
			`SELECT * FROM trajectories WHERE id = ${sqlLiteral(trajectoryId)} LIMIT 1`,
		);
		if (result.rows.length === 0) return null;
		return this.rowToTrajectory(result.rows[0]);
	}

	private async getStepIndex(stepId: string): Promise<StepIndexRow | null> {
		const result = await this.executeRawSql(
			`SELECT trajectory_id, step_number, is_active FROM trajectory_step_index WHERE step_id = ${sqlLiteral(stepId)} LIMIT 1`,
		);
		const row = result.rows[0];
		if (!row) return null;
		const trajectoryId = asString(pickCell(row, "trajectory_id"));
		if (!trajectoryId) return null;
		const stepNumber = asNumber(pickCell(row, "step_number")) ?? 0;
		const isActiveText = asString(pickCell(row, "is_active"));
		const isActive =
			isActiveText === "true" ||
			isActiveText === "t" ||
			pickCell(row, "is_active") === true;
		return { trajectoryId, stepNumber, isActive };
	}

	private async setStepIndex(
		stepId: string,
		trajectoryId: string,
		stepNumber: number,
		isActive: boolean,
	): Promise<void> {
		await this.executeRawSql(`
      INSERT INTO trajectory_step_index (
        step_id, trajectory_id, step_number, is_active, updated_at
      ) VALUES (
        ${sqlLiteral(stepId)},
        ${sqlLiteral(trajectoryId)},
        ${stepNumber},
        ${isActive ? "TRUE" : "FALSE"},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (step_id) DO UPDATE SET
        trajectory_id = EXCLUDED.trajectory_id,
        step_number = EXCLUDED.step_number,
        is_active = EXCLUDED.is_active,
        updated_at = CURRENT_TIMESTAMP
    `);
	}

	private async markAllStepsInactive(trajectoryId: string): Promise<void> {
		await this.executeRawSql(`
      UPDATE trajectory_step_index
      SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE trajectory_id = ${sqlLiteral(trajectoryId)}
    `);
	}

	private async resolveTrajectoryId(
		stepIdOrTrajectoryId: string,
	): Promise<string | null> {
		const cached = this.stepToTrajectory.get(stepIdOrTrajectoryId);
		if (cached) return cached;

		const byStep = await this.getStepIndex(stepIdOrTrajectoryId);
		if (byStep?.trajectoryId) {
			this.stepToTrajectory.set(stepIdOrTrajectoryId, byStep.trajectoryId);
			return byStep.trajectoryId;
		}

		const byId = await this.executeRawSql(
			`SELECT id FROM trajectories WHERE id = ${sqlLiteral(stepIdOrTrajectoryId)} LIMIT 1`,
		);
		const row = byId.rows[0];
		const id = row ? asString(pickCell(row, "id")) : null;
		return id;
	}

	private async getCurrentStepIdFromDb(
		trajectoryId: string,
	): Promise<string | null> {
		const result = await this.executeRawSql(`
      SELECT step_id
      FROM trajectory_step_index
      WHERE trajectory_id = ${sqlLiteral(trajectoryId)} AND is_active = TRUE
      ORDER BY step_number DESC, updated_at DESC
      LIMIT 1
    `);
		const row = result.rows[0];
		return row ? asString(pickCell(row, "step_id")) : null;
	}

	private async persistTrajectory(
		trajectoryId: string,
		trajectory: Trajectory,
		status: TrajectoryStatus = "active",
	): Promise<void> {
		const totals = this.computeTotals(trajectory.steps);
		const isFinalStatus = status !== "active";
		const persistedEndTime = isFinalStatus ? trajectory.endTime : null;
		const persistedDuration = isFinalStatus ? trajectory.durationMs : null;
		const updatedAtIso = new Date().toISOString();
		try {
			await this.executeRawSql(`
        UPDATE trajectories SET
          status = ${sqlLiteral(status)},
          end_time = ${sqlLiteral(persistedEndTime)},
          duration_ms = ${sqlLiteral(persistedDuration)},
          step_count = ${totals.stepCount},
          llm_call_count = ${totals.llmCallCount},
          provider_access_count = ${totals.providerAccessCount},
          total_prompt_tokens = ${totals.totalPromptTokens},
          total_completion_tokens = ${totals.totalCompletionTokens},
          total_reward = ${trajectory.totalReward},
          steps_json = ${sqlLiteral(trajectory.steps)},
          reward_components_json = ${sqlLiteral(trajectory.rewardComponents)},
          metrics_json = ${sqlLiteral(trajectory.metrics)},
          metadata_json = ${sqlLiteral(trajectory.metadata)},
          updated_at = ${sqlLiteral(updatedAtIso)}
        WHERE id = ${sqlLiteral(trajectoryId)}
      `);
		} catch (modernErr) {
			// Compatibility fallback for legacy Eliza schema.
			await this.executeRawSql(`
        UPDATE trajectories SET
          status = ${sqlLiteral(status)},
          end_time = ${sqlLiteral(persistedEndTime)},
          duration_ms = ${sqlLiteral(persistedDuration)},
          step_count = ${totals.stepCount},
          llm_call_count = ${totals.llmCallCount},
          provider_access_count = ${totals.providerAccessCount},
          total_prompt_tokens = ${totals.totalPromptTokens},
          total_completion_tokens = ${totals.totalCompletionTokens},
          total_reward = ${trajectory.totalReward},
          steps_json = ${sqlLiteral(trajectory.steps)},
          metadata = ${sqlLiteral(trajectory.metadata)},
          updated_at = ${sqlLiteral(updatedAtIso)}
        WHERE id = ${sqlLiteral(trajectoryId)}
      `).catch((legacyErr) => {
				logger.warn(
					{ err: legacyErr, trajectoryId },
					`[trajectory-logger] Failed to persist trajectory update after compatibility fallback: ${modernErr instanceof Error ? modernErr.message : String(modernErr)}`,
				);
				throw legacyErr;
			});
		}
	}

	private async ensureStepExists(
		trajectory: Trajectory,
		stepId: string,
	): Promise<TrajectoryStep> {
		let step = trajectory.steps.find((entry) => entry.stepId === stepId);
		if (step) {
			if (!Array.isArray(step.llmCalls)) step.llmCalls = [];
			if (!Array.isArray(step.providerAccesses)) step.providerAccesses = [];
			return step;
		}

		const index = await this.getStepIndex(stepId);
		const stepNumber = index?.stepNumber ?? trajectory.steps.length;
		step = this.createStep(stepId, stepNumber, this.defaultEnvironmentState());
		trajectory.steps.push(step);
		trajectory.steps.sort((a, b) => a.stepNumber - b.stepNumber);
		return step;
	}

	/**
	 * Called by the runtime when an LLM call is made.
	 * This is the interface the runtime expects.
	 */
	logLlmCall(params: TrajectoryRuntimeLlmCallParams): void {
		if (!this.enabled) return;

		// Resolve trajectory synchronously from in-memory map (set by startStep).
		// Enter the write lock IMMEDIATELY so flushWriteQueue() in endAutonomousTick
		// can await it. The old fire-and-forget pattern caused a race: endTrajectory
		// could read the trajectory before logLlmCall's write completed.
		const trajectoryId = this.stepToTrajectory.get(params.stepId);
		if (!trajectoryId) {
			// Async resolution when stepId was not yet mapped (legacy paths).
			void (async () => {
				const resolved = await this.resolveTrajectoryId(params.stepId);
				if (!resolved) return;
				await this._persistLlmCall(resolved, params);
			})().catch((err) => {
				this.reportDetachedWriteFailure(
					"[trajectory-logger] Failed to persist LLM call (async step resolution)",
					{ stepId: params.stepId },
					err,
				);
			});
			return;
		}

		// Enter the write lock synchronously so flushWriteQueue sees this pending write
		void this._persistLlmCall(trajectoryId, params).catch((err) => {
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to persist LLM call",
				{ stepId: params.stepId },
				err,
			);
		});
	}

	private async _persistLlmCall(
		trajectoryId: string,
		params: TrajectoryRuntimeLlmCallParams,
	): Promise<void> {
		await this.withTrajectoryWriteLock(trajectoryId, async () => {
			const trajectory = await this.getTrajectoryById(trajectoryId);
			if (!trajectory) return;

			const step = await this.ensureStepExists(trajectory, params.stepId);
			const llmCall: LLMCall = {
				callId: uuidv4(),
				timestamp: Date.now(),
				model: params.model,
				modelVersion: params.modelVersion,
				modelType: params.modelType,
				provider: params.provider,
				systemPrompt: params.systemPrompt,
				userPrompt: params.userPrompt,
				prompt: params.prompt ?? params.userPrompt,
				messages: params.messages,
				tools: params.tools,
				toolChoice: params.toolChoice,
				responseSchema: params.responseSchema,
				providerOptions: params.providerOptions,
				response: params.response,
				toolCalls: params.toolCalls,
				finishReason: params.finishReason,
				providerMetadata: params.providerMetadata,
				reasoning: params.reasoning,
				temperature: params.temperature,
				maxTokens: params.maxTokens,
				purpose: this.normalizePurpose(params.purpose),
				actionType: params.actionType,
				promptTokens: params.promptTokens,
				completionTokens: params.completionTokens,
				cacheReadInputTokens: params.cacheReadInputTokens,
				cacheCreationInputTokens: params.cacheCreationInputTokens,
				latencyMs: params.latencyMs,
				modelSlot: params.modelSlot,
				runId: params.runId,
				roomId: params.roomId,
				messageId: params.messageId,
				executionTraceId: params.executionTraceId,
			};
			step.llmCalls.push(llmCall);

			// Targeted UPDATE: only write steps data and summary columns.
			// Do NOT touch status — a late logLlmCall arriving after endTrajectory
			// must not reset a "completed" trajectory back to "active".
			const totals = this.computeTotals(trajectory.steps);
			const updatedAtIso = new Date().toISOString();
			await this.executeRawSql(`
				UPDATE trajectories SET
					steps_json = ${sqlLiteral(trajectory.steps)},
					step_count = ${totals.stepCount},
					llm_call_count = ${totals.llmCallCount},
					provider_access_count = ${totals.providerAccessCount},
					total_prompt_tokens = ${totals.totalPromptTokens},
					total_completion_tokens = ${totals.totalCompletionTokens},
					updated_at = ${sqlLiteral(updatedAtIso)}
				WHERE id = ${sqlLiteral(trajectoryId)}
			`);
		});
	}

	// Legacy compatibility helper (old camel-casing + split args).
	logLLMCall(
		stepId: string,
		details: {
			model: string;
			modelVersion?: string;
			systemPrompt: string;
			userPrompt: string;
			response: string;
			reasoning?: string;
			temperature: number;
			maxTokens: number;
			purpose: string;
			actionType?: string;
			latencyMs?: number;
			promptTokens?: number;
			completionTokens?: number;
		},
	): void {
		this.logLlmCall({
			stepId,
			model: details.model,
			modelVersion: details.modelVersion,
			systemPrompt: details.systemPrompt,
			userPrompt: details.userPrompt,
			response: details.response,
			reasoning: details.reasoning,
			temperature: details.temperature,
			maxTokens: details.maxTokens,
			purpose: details.purpose,
			actionType: details.actionType ?? "",
			latencyMs: details.latencyMs ?? 0,
			promptTokens: details.promptTokens,
			completionTokens: details.completionTokens,
		});
	}

	/**
	 * Called by the runtime when a provider is accessed.
	 * Supports both runtime shape and legacy split args.
	 */
	logProviderAccess(params: {
		stepId: string;
		providerName: string;
		data: Record<string, unknown>;
		purpose: string;
		query?: Record<string, unknown>;
		runId?: string;
		roomId?: string;
		messageId?: string;
		executionTraceId?: string;
	}): void;
	logProviderAccess(
		stepId: string,
		params: {
			providerName: string;
			data: Record<string, unknown>;
			purpose: string;
			query?: Record<string, unknown>;
			runId?: string;
			roomId?: string;
			messageId?: string;
			executionTraceId?: string;
		},
	): void;
	logProviderAccess(
		arg1:
			| string
			| {
					stepId: string;
					providerName: string;
					data: Record<string, unknown>;
					purpose: string;
					query?: Record<string, unknown>;
					runId?: string;
					roomId?: string;
					messageId?: string;
					executionTraceId?: string;
			  },
		arg2?: {
			providerName: string;
			data: Record<string, unknown>;
			purpose: string;
			query?: Record<string, unknown>;
		},
	): void {
		if (!this.enabled) return;
		const params =
			typeof arg1 === "string"
				? {
						stepId: arg1,
						providerName: arg2?.providerName ?? "unknown",
						data: arg2?.data ?? {},
						purpose: arg2?.purpose ?? "other",
						query: arg2?.query,
					}
				: arg1;

		void (async () => {
			const trajectoryId = await this.resolveTrajectoryId(params.stepId);
			if (!trajectoryId) {
				logger.debug(
					{ stepId: params.stepId },
					"[trajectory-logger] No trajectory mapping for provider access",
				);
				return;
			}

			await this.withTrajectoryWriteLock(trajectoryId, async () => {
				const trajectory = await this.getTrajectoryById(trajectoryId);
				if (!trajectory) return;

				const step = await this.ensureStepExists(trajectory, params.stepId);
				const access: ProviderAccess = {
					providerId: uuidv4(),
					providerName: params.providerName,
					timestamp: Date.now(),
					data: params.data as Record<string, JsonValue>,
					query: params.query as Record<string, JsonValue> | undefined,
					purpose: params.purpose,
					runId: params.runId,
					roomId: params.roomId,
					messageId: params.messageId,
					executionTraceId: params.executionTraceId,
				};
				step.providerAccesses.push(access);

				// Targeted UPDATE: only write steps data and summary columns.
				// Do NOT touch status — same rationale as _persistLlmCall.
				const totals = this.computeTotals(trajectory.steps);
				const updatedAtIso = new Date().toISOString();
				await this.executeRawSql(`
					UPDATE trajectories SET
						steps_json = ${sqlLiteral(trajectory.steps)},
						step_count = ${totals.stepCount},
						llm_call_count = ${totals.llmCallCount},
						provider_access_count = ${totals.providerAccessCount},
						total_prompt_tokens = ${totals.totalPromptTokens},
						total_completion_tokens = ${totals.totalCompletionTokens},
						updated_at = ${sqlLiteral(updatedAtIso)}
					WHERE id = ${sqlLiteral(trajectoryId)}
				`);
			});
		})().catch((err) => {
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to persist provider access",
				{ stepId: params.stepId },
				err,
			);
		});
	}

	logProviderAccessByTrajectoryId(
		trajectoryId: string,
		access: {
			providerName: string;
			data: Record<string, unknown>;
			purpose: string;
			query?: Record<string, unknown>;
		},
	): void {
		const stepId = this.getCurrentStepId(trajectoryId);
		if (!stepId) {
			logger.debug(
				{ trajectoryId },
				"[trajectory-logger] No active step for provider access by trajectory",
			);
			return;
		}
		this.logProviderAccess(stepId, access);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Trajectory Lifecycle (for RL training / message handling)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Start a new trajectory. Supports both call styles:
	 *   1) startTrajectory(stepId, { agentId, ...legacyOptions })
	 *   2) startTrajectory(agentId, { ...optionsWithoutAgentId })
	 */
	async startTrajectory(
		stepIdOrAgentId: string,
		options: StartTrajectoryOptions = {},
	): Promise<string> {
		if (!this.enabled) return uuidv4();

		const legacyStepId =
			typeof options.agentId === "string" && options.agentId.length > 0
				? stepIdOrAgentId
				: null;
		const agentId =
			(typeof options.agentId === "string" && options.agentId.length > 0
				? options.agentId
				: stepIdOrAgentId) ?? stepIdOrAgentId;

		const trajectoryId = uuidv4();
		const now = Date.now();
		const timestampIso = new Date(now).toISOString();
		const metadata: Record<string, JsonValue> = {
			...(options.metadata ?? {}),
		};
		if (options.roomId) metadata.roomId = options.roomId;
		if (options.entityId) metadata.entityId = options.entityId;

		const trajectory: Trajectory = {
			trajectoryId:
				trajectoryId as `${string}-${string}-${string}-${string}-${string}`,
			agentId: agentId as `${string}-${string}-${string}-${string}-${string}`,
			startTime: now,
			endTime: now,
			durationMs: 0,
			scenarioId: options.scenarioId,
			episodeId: options.episodeId,
			batchId: options.batchId,
			groupIndex: options.groupIndex,
			steps: [],
			totalReward: 0,
			rewardComponents: { environmentReward: 0 },
			metrics: {
				episodeLength: 0,
				finalStatus: "completed",
			},
			metadata: {
				source: options.source ?? "chat",
				...metadata,
			},
		};

		let persistedStart = false;
		try {
			await this.executeRawSql(`
        INSERT INTO trajectories (
          id, agent_id, source, status, start_time, scenario_id, episode_id,
          batch_id, group_index, metadata_json, steps_json, reward_components_json, metrics_json,
          created_at, updated_at
        ) VALUES (
          ${sqlLiteral(trajectoryId)},
          ${sqlLiteral(agentId)},
          ${sqlLiteral(options.source ?? "chat")},
          'active',
          ${now},
          ${sqlLiteral(options.scenarioId ?? null)},
          ${sqlLiteral(options.episodeId ?? null)},
          ${sqlLiteral(options.batchId ?? null)},
          ${options.groupIndex ?? "NULL"},
          ${sqlLiteral(trajectory.metadata)},
          ${sqlLiteral([])},
          ${sqlLiteral(trajectory.rewardComponents)},
          ${sqlLiteral(trajectory.metrics)},
          ${sqlLiteral(timestampIso)},
          ${sqlLiteral(timestampIso)}
        )
      `);
			persistedStart = true;
		} catch (_err) {
			throw new Error(
				`[trajectory-logger] Failed to persist trajectory start for ${trajectoryId}`,
			);
		}

		if (persistedStart && legacyStepId) {
			this.stepToTrajectory.set(legacyStepId, trajectoryId);
			try {
				await this.setStepIndex(legacyStepId, trajectoryId, -1, false);
			} catch (indexErr) {
				logger.warn(
					{ err: indexErr, trajectoryId, stepId: legacyStepId },
					"[trajectory-logger] Failed to persist step index for trajectory start",
				);
			}
		}

		return trajectoryId;
	}

	/**
	 * Start a new step within a trajectory.
	 */
	startStep(trajectoryId: string, envState: EnvironmentState): string {
		if (!this.enabled) return uuidv4();

		const stepId = uuidv4();
		this.activeStepIds.set(trajectoryId, stepId);
		this.stepToTrajectory.set(stepId, trajectoryId);

		void this.withTrajectoryWriteLock(trajectoryId, async () => {
			const trajectory = await this.getTrajectoryById(trajectoryId);
			if (!trajectory) {
				logger.warn(
					{ trajectoryId },
					"[trajectory-logger] Trajectory not found for startStep",
				);
				return;
			}

			const step = this.createStep(stepId, trajectory.steps.length, envState);
			trajectory.steps.push(step);
			await this.markAllStepsInactive(trajectoryId);
			await this.setStepIndex(stepId, trajectoryId, step.stepNumber, true);
			await this.persistTrajectory(trajectoryId, trajectory, "active");
		}).catch((err) => {
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to persist startStep",
				{ trajectoryId, stepId },
				err,
			);
		});

		return stepId;
	}

	/**
	 * Complete a step with action results.
	 * Supports:
	 *   completeStep(trajectoryId, action, rewardInfo?)
	 *   completeStep(trajectoryId, stepId, action, rewardInfo?)
	 */
	completeStep(
		trajectoryId: string,
		action: Omit<ActionAttempt, "attemptId" | "timestamp">,
		rewardInfo?: CompleteStepRewardInfo,
	): void;
	completeStep(
		trajectoryId: string,
		stepId: string,
		action: Omit<ActionAttempt, "attemptId" | "timestamp">,
		rewardInfo?: CompleteStepRewardInfo,
	): void;
	completeStep(
		trajectoryId: string,
		actionOrStepId: string | Omit<ActionAttempt, "attemptId" | "timestamp">,
		actionOrReward?:
			| Omit<ActionAttempt, "attemptId" | "timestamp">
			| CompleteStepRewardInfo,
		maybeReward?: CompleteStepRewardInfo,
	): void {
		if (!this.enabled) return;

		const explicitStepId =
			typeof actionOrStepId === "string" ? actionOrStepId : null;
		const action = (
			typeof actionOrStepId === "string" ? actionOrReward : actionOrStepId
		) as Omit<ActionAttempt, "attemptId" | "timestamp"> | undefined;
		const rewardInfo = (
			typeof actionOrStepId === "string" ? maybeReward : actionOrReward
		) as CompleteStepRewardInfo | undefined;

		if (!action) return;

		void this.withTrajectoryWriteLock(trajectoryId, async () => {
			const trajectory = await this.getTrajectoryById(trajectoryId);
			if (!trajectory) return;

			const stepId =
				explicitStepId ??
				this.activeStepIds.get(trajectoryId) ??
				(await this.getCurrentStepIdFromDb(trajectoryId));
			if (!stepId) return;

			const step = await this.ensureStepExists(trajectory, stepId);
			step.action = {
				attemptId: uuidv4(),
				timestamp: Date.now(),
				...action,
			};
			step.done = true;

			if (rewardInfo?.reward !== undefined) {
				step.reward = rewardInfo.reward;
				trajectory.totalReward += rewardInfo.reward;
			}
			if (rewardInfo?.components) {
				trajectory.rewardComponents = {
					...trajectory.rewardComponents,
					...rewardInfo.components,
				};
			}

			await this.setStepIndex(stepId, trajectoryId, step.stepNumber, false);
			this.activeStepIds.delete(trajectoryId);

			// Targeted UPDATE: only write steps data, reward, and summary columns.
			// Do NOT touch status — same rationale as _persistLlmCall.
			const totals = this.computeTotals(trajectory.steps);
			const updatedAtIso = new Date().toISOString();
			await this.executeRawSql(`
				UPDATE trajectories SET
					steps_json = ${sqlLiteral(trajectory.steps)},
					step_count = ${totals.stepCount},
					llm_call_count = ${totals.llmCallCount},
					provider_access_count = ${totals.providerAccessCount},
					total_prompt_tokens = ${totals.totalPromptTokens},
					total_completion_tokens = ${totals.totalCompletionTokens},
					total_reward = ${trajectory.totalReward},
					reward_components_json = ${sqlLiteral(trajectory.rewardComponents)},
					updated_at = ${sqlLiteral(updatedAtIso)}
				WHERE id = ${sqlLiteral(trajectoryId)}
			`);
		}).catch((err) => {
			this.reportDetachedWriteFailure(
				"[trajectory-logger] Failed to complete step",
				{ trajectoryId },
				err,
			);
		});
	}

	/**
	 * End a trajectory and persist final state.
	 */
	async endTrajectory(
		stepIdOrTrajectoryId: string,
		status: "completed" | "error" | "timeout" | "terminated" = "completed",
		finalMetrics?: Record<string, JsonValue>,
	): Promise<void> {
		if (!this.enabled) return;

		const trajectoryId = await this.resolveTrajectoryId(stepIdOrTrajectoryId);
		if (!trajectoryId) {
			logger.debug(
				{ stepIdOrTrajectoryId },
				"[trajectory-logger] No trajectory to end",
			);
			return;
		}

		await this.withTrajectoryWriteLock(trajectoryId, async () => {
			const trajectory = await this.getTrajectoryById(trajectoryId);
			if (!trajectory) {
				logger.debug(
					{ trajectoryId },
					"[trajectory-logger] Trajectory not found while ending",
				);
				return;
			}

			const now = Date.now();
			trajectory.endTime = now;
			trajectory.durationMs = now - trajectory.startTime;
			trajectory.metrics = {
				...trajectory.metrics,
				finalStatus: status,
				episodeLength: trajectory.steps.length,
			};
			if (finalMetrics) {
				Object.assign(trajectory.metrics, finalMetrics);
			}

			await this.markAllStepsInactive(trajectoryId);
			this.activeStepIds.delete(trajectoryId);

			// persistTrajectory recomputes summary columns (llm_call_count,
			// step_count, etc.) from steps_json and calls ensureAtLeastOneLlmCall
			// for non-active statuses. The write lock serializes this with any
			// pending logLlmCall / completeStep writes so steps_json is stable.
			await this.persistTrajectory(trajectoryId, trajectory, status);
		});

		for (const [
			stepId,
			mappedTrajectoryId,
		] of this.stepToTrajectory.entries()) {
			if (mappedTrajectoryId === trajectoryId) {
				this.stepToTrajectory.delete(stepId);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Query Interface (for UI and export)
	// ─────────────────────────────────────────────────────────────────────────

	async listTrajectories(
		options: TrajectoryListOptions = {},
	): Promise<TrajectoryListResult> {
		const runtime = this.runtime as IAgentRuntime & {
			adapter?: { db?: unknown };
		};
		if (!runtime?.adapter) {
			return { trajectories: [], total: 0, offset: 0, limit: 50 };
		}
		const db = runtime.adapter.db as { execute?: unknown } | undefined;
		if (!db || typeof db.execute !== "function") {
			return { trajectories: [], total: 0, offset: 0, limit: 50 };
		}
		await this.ensureStorageReady();

		const offset = Math.max(0, options.offset ?? 0);
		const limit = Math.min(500, Math.max(1, options.limit ?? 50));

		const whereClauses: string[] = [];
		if (options.status) {
			whereClauses.push(`status = ${sqlLiteral(options.status)}`);
		}
		if (options.source) {
			whereClauses.push(`source = ${sqlLiteral(options.source)}`);
		}
		if (options.scenarioId) {
			whereClauses.push(`scenario_id = ${sqlLiteral(options.scenarioId)}`);
		}
		if (options.batchId) {
			whereClauses.push(`batch_id = ${sqlLiteral(options.batchId)}`);
		}
		if (options.isTrainingData !== undefined) {
			whereClauses.push(`is_training_data = ${options.isTrainingData}`);
		}
		if (options.startDate) {
			whereClauses.push(
				`created_at >= ${sqlLiteral(options.startDate)}::timestamptz`,
			);
		}
		if (options.endDate) {
			whereClauses.push(
				`created_at <= ${sqlLiteral(options.endDate)}::timestamptz`,
			);
		}
		if (options.search) {
			// Single-pass escape so LIKE-wildcard escapes do not introduce
			// unescaped backslashes (CodeQL js/incomplete-sanitization).
			const escaped = options.search.replace(/[\\'%_]/g, (ch) => {
				if (ch === "'") return "''";
				if (ch === "\\") return "\\\\";
				return `\\${ch}`;
			});
			whereClauses.push(`(
        id ILIKE '%${escaped}%' OR
        agent_id ILIKE '%${escaped}%' OR
        source ILIKE '%${escaped}%' OR
        scenario_id ILIKE '%${escaped}%'
      )`);
		}

		const whereClause =
			whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

		const countResult = await this.executeRawSql(
			`SELECT count(*)::int AS total FROM trajectories ${whereClause}`,
		);
		const total = asNumber(pickCell(countResult.rows[0] ?? {}, "total")) ?? 0;

		const rowsResult = await this.executeRawSql(`
      SELECT
        id, agent_id, source, status, start_time, end_time, duration_ms,
        step_count, llm_call_count, total_prompt_tokens, total_completion_tokens,
        total_reward, scenario_id, batch_id, created_at
      FROM trajectories
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

		const trajectories: TrajectoryListItem[] = rowsResult.rows.map((row) => {
			const status =
				(asString(pickCell(row, "status")) as TrajectoryListItem["status"]) ??
				"completed";
			const rawLlmCallCount = asNumber(pickCell(row, "llm_call_count")) ?? 0;
			const llmCallCount = rawLlmCallCount;

			return {
				id: asString(pickCell(row, "id")) ?? "",
				agentId: asString(pickCell(row, "agent_id")) ?? "",
				source: asString(pickCell(row, "source")) ?? "chat",
				status,
				startTime: asNumber(pickCell(row, "start_time")) ?? 0,
				endTime: asNumber(pickCell(row, "end_time")),
				durationMs: asNumber(pickCell(row, "duration_ms")),
				stepCount: asNumber(pickCell(row, "step_count")) ?? 0,
				llmCallCount,
				totalPromptTokens: asNumber(pickCell(row, "total_prompt_tokens")) ?? 0,
				totalCompletionTokens:
					asNumber(pickCell(row, "total_completion_tokens")) ?? 0,
				totalReward: asNumber(pickCell(row, "total_reward")) ?? 0,
				scenarioId: asString(pickCell(row, "scenario_id")),
				batchId: asString(pickCell(row, "batch_id")),
				createdAt: asIsoString(pickCell(row, "created_at")),
			};
		});

		return { trajectories, total, offset, limit };
	}

	async getTrajectoryDetail(trajectoryId: string): Promise<Trajectory | null> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime?.adapter) return null;
		await this.ensureStorageReady();

		const safeId = trajectoryId.replace(/'/g, "''");
		const result = await this.executeRawSql(
			`SELECT * FROM trajectories WHERE id = '${safeId}' LIMIT 1`,
		);

		if (result.rows.length === 0) return null;

		const row = result.rows[0];
		const trajectory = this.rowToTrajectory(row);
		return trajectory;
	}

	async getStats(): Promise<TrajectoryStats> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime?.adapter) {
			return {
				totalTrajectories: 0,
				totalSteps: 0,
				totalLlmCalls: 0,
				totalPromptTokens: 0,
				totalCompletionTokens: 0,
				averageDurationMs: 0,
				averageReward: 0,
				bySource: {},
				byStatus: {},
				byScenario: {},
			};
		}
		await this.ensureStorageReady();

		const statsResult = await this.executeRawSql(`
      SELECT
        count(*)::int AS total_trajectories,
        COALESCE(sum(step_count), 0)::int AS total_steps,
        COALESCE(sum(llm_call_count), 0)::int AS total_llm_calls,
        COALESCE(sum(total_prompt_tokens), 0)::int AS total_prompt_tokens,
        COALESCE(sum(total_completion_tokens), 0)::int AS total_completion_tokens,
        COALESCE(avg(duration_ms), 0)::int AS avg_duration_ms,
        COALESCE(avg(total_reward), 0)::real AS avg_reward
      FROM trajectories
    `);

		const sourceResult = await this.executeRawSql(`
      SELECT source, count(*)::int AS cnt
      FROM trajectories
      GROUP BY source
    `);

		const statusResult = await this.executeRawSql(`
      SELECT status, count(*)::int AS cnt
      FROM trajectories
      GROUP BY status
    `);

		const scenarioResult = await this.executeRawSql(`
      SELECT scenario_id, count(*)::int AS cnt
      FROM trajectories
      WHERE scenario_id IS NOT NULL
      GROUP BY scenario_id
    `);

		const stats = statsResult.rows[0] ?? {};
		const bySource: Record<string, number> = {};
		const byStatus: Record<string, number> = {};
		const byScenario: Record<string, number> = {};

		for (const row of sourceResult.rows) {
			const source = asString(pickCell(row, "source"));
			const cnt = asNumber(pickCell(row, "cnt"));
			if (source && cnt !== null) bySource[source] = cnt;
		}

		for (const row of statusResult.rows) {
			const status = asString(pickCell(row, "status"));
			const cnt = asNumber(pickCell(row, "cnt"));
			if (status && cnt !== null) byStatus[status] = cnt;
		}

		for (const row of scenarioResult.rows) {
			const scenario = asString(pickCell(row, "scenario_id"));
			const cnt = asNumber(pickCell(row, "cnt"));
			if (scenario && cnt !== null) byScenario[scenario] = cnt;
		}

		return {
			totalTrajectories: asNumber(pickCell(stats, "total_trajectories")) ?? 0,
			totalSteps: asNumber(pickCell(stats, "total_steps")) ?? 0,
			totalLlmCalls: asNumber(pickCell(stats, "total_llm_calls")) ?? 0,
			totalPromptTokens: asNumber(pickCell(stats, "total_prompt_tokens")) ?? 0,
			totalCompletionTokens:
				asNumber(pickCell(stats, "total_completion_tokens")) ?? 0,
			averageDurationMs: asNumber(pickCell(stats, "avg_duration_ms")) ?? 0,
			averageReward: asNumber(pickCell(stats, "avg_reward")) ?? 0,
			bySource,
			byStatus,
			byScenario,
		};
	}

	async deleteTrajectories(trajectoryIds: string[]): Promise<number> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime?.adapter) return 0;
		if (trajectoryIds.length === 0) return 0;
		await this.ensureStorageReady();

		const ids = trajectoryIds.map(sqlLiteral).join(", ");
		const result = await this.executeRawSql(
			`DELETE FROM trajectories WHERE id IN (${ids}) RETURNING id`,
		);
		return result.rows.length;
	}

	async clearAllTrajectories(): Promise<number> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime?.adapter) return 0;
		await this.ensureStorageReady();

		const countResult = await this.executeRawSql(
			`SELECT count(*)::int AS cnt FROM trajectories`,
		);
		const count = asNumber(pickCell(countResult.rows[0] ?? {}, "cnt")) ?? 0;

		await this.executeRawSql(`DELETE FROM trajectories`);
		return count;
	}

	private sanitizeZipFolderName(value: string): string {
		const trimmed = value.trim();
		const safe = trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed;
		const sanitized = safe
			.replace(/[^a-zA-Z0-9._-]+/g, "_")
			.replace(/^_+|_+$/g, "");
		return sanitized || "trajectory";
	}

	private redactTrajectoryPrompts(trajectory: Trajectory): Trajectory {
		return {
			...trajectory,
			steps: trajectory.steps.map((step) => ({
				...step,
				llmCalls: step.llmCalls.map((call) => ({
					...call,
					systemPrompt: "[redacted]",
					userPrompt: "[redacted]",
					response: "[redacted]",
				})),
			})),
		};
	}

	private buildZipSummary(trajectory: Trajectory): {
		id: string;
		agentId: string;
		roomId: string | null;
		entityId: string | null;
		conversationId: string | null;
		source: string;
		status: "active" | "completed" | "error";
		startTime: number;
		endTime: number | null;
		durationMs: number | null;
		llmCallCount: number;
		providerAccessCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
		metadata: Record<string, JsonValue | undefined>;
		createdAt: string;
		updatedAt: string;
	} {
		const finalStatus = trajectory.metrics?.finalStatus ?? "completed";
		const normalizedEndTime =
			typeof trajectory.endTime === "number" && trajectory.endTime > 0
				? trajectory.endTime
				: null;
		const status: "active" | "completed" | "error" =
			finalStatus === "timeout" ||
			finalStatus === "terminated" ||
			finalStatus === "error"
				? "error"
				: finalStatus === "completed"
					? "completed"
					: normalizedEndTime
						? "completed"
						: "active";

		let llmCallCount = 0;
		let providerAccessCount = 0;
		let totalPromptTokens = 0;
		let totalCompletionTokens = 0;

		for (const step of trajectory.steps) {
			providerAccessCount += step.providerAccesses.length;
			llmCallCount += step.llmCalls.length;
			for (const call of step.llmCalls) {
				totalPromptTokens += call.promptTokens ?? 0;
				totalCompletionTokens += call.completionTokens ?? 0;
			}
		}

		const metadata = trajectory.metadata ?? {};
		const asNullableString = (value: JsonValue | undefined): string | null =>
			typeof value === "string" ? value : null;
		const source =
			typeof metadata.source === "string" ? metadata.source : "chat";
		const normalizedDurationMs =
			status === "active"
				? null
				: typeof trajectory.durationMs === "number"
					? trajectory.durationMs
					: null;
		const updatedAtMs =
			normalizedEndTime ?? (trajectory.startTime || Date.now());

		return {
			id: trajectory.trajectoryId,
			agentId: trajectory.agentId,
			roomId: asNullableString(metadata.roomId),
			entityId: asNullableString(metadata.entityId),
			conversationId: asNullableString(metadata.conversationId),
			source,
			status,
			startTime: trajectory.startTime,
			endTime: normalizedEndTime,
			durationMs: normalizedDurationMs,
			llmCallCount,
			providerAccessCount,
			totalPromptTokens,
			totalCompletionTokens,
			metadata,
			createdAt: new Date(trajectory.startTime).toISOString(),
			updatedAt: new Date(updatedAtMs).toISOString(),
		};
	}

	async exportTrajectoriesZip(
		options: TrajectoryZipExportOptions = {},
	): Promise<TrajectoryZipExportResult> {
		let targetIds = Array.isArray(options.trajectoryIds)
			? options.trajectoryIds.filter(
					(id): id is string => typeof id === "string" && id.trim().length > 0,
				)
			: [];

		if (targetIds.length === 0) {
			const list = await this.listTrajectories({
				limit: 500,
				startDate: options.startDate,
				endDate: options.endDate,
				scenarioId: options.scenarioId,
				batchId: options.batchId,
			});
			targetIds = list.trajectories.map((trajectory) => trajectory.id);
		}

		const entries: TrajectoryZipEntry[] = [];
		const manifestRows: Array<{
			trajectoryId: string;
			folder: string;
			createdAt: string;
		}> = [];

		for (const trajectoryId of targetIds) {
			const detail = await this.getTrajectoryDetail(trajectoryId);
			if (!detail) continue;

			const exportTrajectory =
				options.includePrompts === false
					? this.redactTrajectoryPrompts(detail)
					: detail;
			const summary = this.buildZipSummary(exportTrajectory);
			const folderName = this.sanitizeZipFolderName(trajectoryId);

			entries.push({
				name: `${folderName}/trajectory.json`,
				data: JSON.stringify(exportTrajectory, null, 2),
			});
			entries.push({
				name: `${folderName}/summary.json`,
				data: JSON.stringify(summary, null, 2),
			});

			manifestRows.push({
				trajectoryId,
				folder: folderName,
				createdAt: summary.createdAt,
			});
		}

		entries.unshift({
			name: "manifest.json",
			data: JSON.stringify(
				{
					exportedAt: new Date().toISOString(),
					trajectories: manifestRows,
				},
				null,
				2,
			),
		});

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		return {
			filename: `trajectories-${timestamp}.zip`,
			entries,
		};
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Export (for RL training)
	// ─────────────────────────────────────────────────────────────────────────

	async exportTrajectories(
		options: CanonicalTrajectoryExportOptions,
	): Promise<TrajectoryExportResult> {
		const runtime = this.runtime as IAgentRuntime & { adapter?: unknown };
		if (!runtime?.adapter) {
			throw new Error("Database not available");
		}
		await this.ensureStorageReady();

		const whereClauses: string[] = [];
		if (options.trajectoryIds && options.trajectoryIds.length > 0) {
			const ids = options.trajectoryIds.map(sqlLiteral).join(", ");
			whereClauses.push(`id IN (${ids})`);
		}
		if (options.startDate) {
			whereClauses.push(
				`created_at >= ${sqlLiteral(options.startDate)}::timestamptz`,
			);
		}
		if (options.endDate) {
			whereClauses.push(
				`created_at <= ${sqlLiteral(options.endDate)}::timestamptz`,
			);
		}
		if (options.scenarioId) {
			whereClauses.push(`scenario_id = ${sqlLiteral(options.scenarioId)}`);
		}
		if (options.batchId) {
			whereClauses.push(`batch_id = ${sqlLiteral(options.batchId)}`);
		}

		const whereClause =
			whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

		const result = await this.executeRawSql(
			`SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC`,
		);

		const trajectories: TrajectoryDetailRecord[] = result.rows.map((row) => {
			const trajectory = this.rowToTrajectory(row);
			return {
				...trajectory,
				source:
					typeof trajectory.metadata?.source === "string"
						? trajectory.metadata.source
						: undefined,
			};
		});

		return serializeTrajectoryExport(trajectories, options);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Helpers
	// ─────────────────────────────────────────────────────────────────────────

	private rowToTrajectory(row: SqlRow): Trajectory {
		return {
			trajectoryId: (asString(pickCell(row, "id")) ??
				"") as `${string}-${string}-${string}-${string}-${string}`,
			agentId: (asString(pickCell(row, "agent_id")) ??
				"") as `${string}-${string}-${string}-${string}-${string}`,
			startTime: asNumber(pickCell(row, "start_time")) ?? 0,
			endTime: asNumber(pickCell(row, "end_time")) ?? 0,
			durationMs: asNumber(pickCell(row, "duration_ms")) ?? 0,
			scenarioId: asString(pickCell(row, "scenario_id")) ?? undefined,
			episodeId: asString(pickCell(row, "episode_id")) ?? undefined,
			batchId: asString(pickCell(row, "batch_id")) ?? undefined,
			groupIndex: asNumber(pickCell(row, "group_index")) ?? undefined,
			steps: parseTrajectorySteps(pickCell(row, "steps_json", "steps")),
			totalReward: asNumber(pickCell(row, "total_reward")) ?? 0,
			rewardComponents: parseRewardComponents(
				pickCell(row, "reward_components_json", "reward_components"),
			),
			metrics: parseTrajectoryMetrics(pickCell(row, "metrics_json", "metrics")),
			metadata: parseTrajectoryMetadata(
				pickCell(row, "metadata_json", "metadata"),
			),
		};
	}

	/**
	 * Get active trajectory for a step (for compatibility with existing code)
	 */
	getActiveTrajectory(trajectoryId: string): Trajectory | null {
		void trajectoryId;
		return null;
	}

	/**
	 * Get current step ID for a trajectory
	 */
	getCurrentStepId(trajectoryId: string): string | null {
		return this.activeStepIds.get(trajectoryId) || null;
	}

	/**
	 * Legacy compatibility: get in-memory provider access logs
	 */
	getProviderAccessLogs(): readonly ProviderAccess[] {
		return [];
	}

	/**
	 * Legacy compatibility: get in-memory LLM call logs
	 */
	getLlmCallLogs(): readonly LLMCall[] {
		return [];
	}
}
