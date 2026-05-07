import { buildContextObjectTrajectoryExport } from "../trajectory-utils";
import type {
	ElizaNativeModelRequestRecord,
	ElizaNativeModelResponseRecord,
	ElizaNativeTrajectoryRow,
	TrajectoryCacheStatsRecord,
	TrajectoryDetailRecord,
	TrajectoryExportOptions,
	TrajectoryExportResult,
	TrajectoryFlattenedLlmCallRecord,
	TrajectoryJsonShape,
	TrajectoryLlmCallRecord,
	TrajectoryStepRecord,
	TrajectoryUsageTotalsRecord,
} from "./trajectory-types";
import { ELIZA_NATIVE_TRAJECTORY_FORMAT } from "./trajectory-types";

type TrajectoryArtMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

type TrajectoryArtRow = {
	messages: TrajectoryArtMessage[];
	metadata: Record<string, unknown>;
	metrics: Record<string, number>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return fallback;
}

function toOptionalFiniteNumber(value: unknown): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const parsed = toFiniteNumber(value, Number.NaN);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") {
			continue;
		}
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function csvEscape(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	const text = String(value);
	if (!/[",\n]/.test(text)) {
		return text;
	}
	return `"${text.replace(/"/g, '""')}"`;
}

function listTrajectorySteps(
	trajectory: TrajectoryDetailRecord,
): TrajectoryStepRecord[] {
	if (Array.isArray(trajectory.steps)) {
		return trajectory.steps;
	}
	if (
		typeof trajectory.stepsJson !== "string" ||
		trajectory.stepsJson.trim().length === 0
	) {
		return [];
	}
	try {
		const parsed = JSON.parse(trajectory.stepsJson) as unknown;
		return Array.isArray(parsed) ? (parsed as TrajectoryStepRecord[]) : [];
	} catch {
		return [];
	}
}

function listStepLlmCalls(
	step: TrajectoryStepRecord,
): TrajectoryLlmCallRecord[] {
	return Array.isArray(step.llmCalls) ? step.llmCalls : [];
}

export function summarizeTrajectoryUsage(
	trajectory: TrajectoryDetailRecord,
): TrajectoryUsageTotalsRecord {
	let llmCallCount = 0;
	let providerAccessCount = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	let cacheReadInputTokens = 0;
	let cacheCreationInputTokens = 0;

	for (const step of listTrajectorySteps(trajectory)) {
		providerAccessCount += Array.isArray(step.providerAccesses)
			? step.providerAccesses.length
			: 0;
		for (const call of listStepLlmCalls(step)) {
			llmCallCount += 1;
			promptTokens += toFiniteNumber(call.promptTokens);
			completionTokens += toFiniteNumber(call.completionTokens);
			cacheReadInputTokens += toFiniteNumber(call.cacheReadInputTokens);
			cacheCreationInputTokens += toFiniteNumber(call.cacheCreationInputTokens);
		}
	}

	return {
		stepCount: listTrajectorySteps(trajectory).length,
		llmCallCount,
		providerAccessCount,
		promptTokens,
		completionTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
	};
}

export function summarizeTrajectoryCache(
	trajectory: TrajectoryDetailRecord,
): TrajectoryCacheStatsRecord {
	const totals = summarizeTrajectoryUsage(trajectory);
	let cachedCallCount = 0;
	let cacheReadCallCount = 0;
	let cacheWriteCallCount = 0;
	let tokenUsageEstimatedCallCount = 0;

	for (const step of listTrajectorySteps(trajectory)) {
		for (const call of listStepLlmCalls(step)) {
			const cacheReadInputTokens = toFiniteNumber(call.cacheReadInputTokens);
			const cacheCreationInputTokens = toFiniteNumber(
				call.cacheCreationInputTokens,
			);
			if (cacheReadInputTokens > 0 || cacheCreationInputTokens > 0) {
				cachedCallCount += 1;
			}
			if (cacheReadInputTokens > 0) {
				cacheReadCallCount += 1;
			}
			if (cacheCreationInputTokens > 0) {
				cacheWriteCallCount += 1;
			}
			if (call.tokenUsageEstimated === true) {
				tokenUsageEstimatedCallCount += 1;
			}
		}
	}

	return {
		totalInputTokens: totals.promptTokens,
		promptTokens: totals.promptTokens,
		completionTokens: totals.completionTokens,
		cacheReadInputTokens: totals.cacheReadInputTokens,
		cacheCreationInputTokens: totals.cacheCreationInputTokens,
		cachedCallCount,
		cacheReadCallCount,
		cacheWriteCallCount,
		tokenUsageEstimatedCallCount,
	};
}

export function resolveTrajectoryStatus(
	trajectory: TrajectoryDetailRecord,
): NonNullable<TrajectoryDetailRecord["status"]> {
	if (trajectory.status) {
		return trajectory.status;
	}
	const finalStatus = trajectory.metrics?.finalStatus;
	if (finalStatus === "timeout") {
		return "timeout";
	}
	if (finalStatus === "error" || finalStatus === "terminated") {
		return "error";
	}
	if (finalStatus === "completed") {
		return "completed";
	}
	return typeof trajectory.endTime === "number" && trajectory.endTime > 0
		? "completed"
		: "active";
}

function resolveTrajectorySource(
	trajectory: TrajectoryDetailRecord,
): string | undefined {
	if (trajectory.source) {
		return trajectory.source;
	}
	return toOptionalString(asRecord(trajectory.metadata)?.source);
}

export function iterateTrajectoryLlmCalls(
	trajectory: TrajectoryDetailRecord,
): TrajectoryFlattenedLlmCallRecord[] {
	const out: TrajectoryFlattenedLlmCallRecord[] = [];
	const steps = listTrajectorySteps(trajectory);
	const trajectoryStatus = resolveTrajectoryStatus(trajectory);
	const trajectorySource = resolveTrajectorySource(trajectory);
	for (const [stepIndex, step] of steps.entries()) {
		const stepId =
			toOptionalString(step.stepId) ??
			`${trajectory.trajectoryId}:step:${stepIndex + 1}`;
		for (const [callIndex, call] of listStepLlmCalls(step).entries()) {
			const callId =
				toOptionalString(call.callId) ??
				`${trajectory.trajectoryId}:${stepId}:call:${callIndex + 1}`;
			out.push({
				...call,
				callId,
				trajectoryId: trajectory.trajectoryId,
				agentId: trajectory.agentId,
				source: trajectorySource,
				status: trajectoryStatus,
				startTime: trajectory.startTime,
				endTime: trajectory.endTime,
				durationMs: trajectory.durationMs,
				scenarioId: trajectory.scenarioId,
				batchId: trajectory.batchId,
				stepId,
				stepIndex,
				stepTimestamp: toFiniteNumber(step.timestamp),
				stepKind: step.kind,
				callIndex,
				timestamp:
					toFiniteNumber(call.timestamp, Number.NaN) ||
					toFiniteNumber(step.timestamp) ||
					trajectory.startTime,
				tags: normalizeTags(call.tags),
				promptTokens: toFiniteNumber(call.promptTokens),
				completionTokens: toFiniteNumber(call.completionTokens),
				cacheReadInputTokens: toFiniteNumber(call.cacheReadInputTokens),
				cacheCreationInputTokens: toFiniteNumber(call.cacheCreationInputTokens),
				tokenUsageEstimated: call.tokenUsageEstimated === true,
			});
		}
	}
	return out;
}

function inferNativeTaskType(call: TrajectoryFlattenedLlmCallRecord): string {
	const tokens = [
		call.purpose,
		call.stepType,
		call.actionType,
		call.modelSlot,
		...(Array.isArray(call.tags) ? call.tags : []),
	]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9:_-]+/g, "_");

	if (tokens.includes("context_routing")) return "context_routing";
	if (
		tokens.includes("should_respond") ||
		tokens.includes("response_handler") ||
		tokens.includes("message_handler")
	) {
		return "should_respond";
	}
	if (
		tokens.includes("action_planner") ||
		tokens.includes("planner") ||
		tokens.includes("runtime_use_model")
	) {
		return "action_planner";
	}
	if (
		tokens.includes("media_description") ||
		tokens.includes("image_description") ||
		tokens.includes("describe_image")
	) {
		return "media_description";
	}
	if (tokens.includes("reply")) return "reply";
	return "response";
}

function buildNativeMessages(
	call: TrajectoryFlattenedLlmCallRecord,
): unknown[] | undefined {
	if (Array.isArray(call.messages) && call.messages.length > 0) {
		return call.messages;
	}

	const messages: Array<{ role: "system" | "user"; content: string }> = [];
	const systemPrompt = toOptionalString(call.systemPrompt);
	const userPrompt = toOptionalString(call.userPrompt ?? call.prompt);
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}
	if (userPrompt) {
		messages.push({ role: "user", content: userPrompt });
	}
	return messages.length > 0 ? messages : undefined;
}

function buildNativeRequest(
	call: TrajectoryFlattenedLlmCallRecord,
): ElizaNativeModelRequestRecord {
	const request: ElizaNativeModelRequestRecord = {};
	const prompt = toOptionalString(call.prompt ?? call.userPrompt);
	const messages = buildNativeMessages(call);
	if (prompt) request.prompt = prompt;
	if (messages) request.messages = messages;
	if (call.tools !== undefined) request.tools = call.tools;
	if (call.toolChoice !== undefined) request.toolChoice = call.toolChoice;
	if (call.responseSchema !== undefined) {
		request.responseSchema = call.responseSchema;
	}
	if (call.providerOptions !== undefined) {
		request.providerOptions = call.providerOptions;
	}

	const settings: NonNullable<ElizaNativeModelRequestRecord["settings"]> = {};
	if (typeof call.temperature === "number")
		settings.temperature = call.temperature;
	if (typeof call.maxTokens === "number") settings.maxTokens = call.maxTokens;
	if (typeof call.topP === "number") settings.topP = call.topP;
	if (Object.keys(settings).length > 0) request.settings = settings;
	return request;
}

function buildNativeResponse(
	call: TrajectoryFlattenedLlmCallRecord,
): ElizaNativeModelResponseRecord {
	const promptTokens = toOptionalFiniteNumber(call.promptTokens);
	const completionTokens = toOptionalFiniteNumber(call.completionTokens);
	const cacheReadInputTokens = toOptionalFiniteNumber(
		call.cacheReadInputTokens,
	);
	const cacheCreationInputTokens = toOptionalFiniteNumber(
		call.cacheCreationInputTokens,
	);
	const usage: NonNullable<ElizaNativeModelResponseRecord["usage"]> = {};
	if (promptTokens !== undefined) usage.promptTokens = promptTokens;
	if (completionTokens !== undefined) usage.completionTokens = completionTokens;
	if (promptTokens !== undefined || completionTokens !== undefined) {
		usage.totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
	}
	if (cacheReadInputTokens !== undefined) {
		usage.cacheReadInputTokens = cacheReadInputTokens;
	}
	if (cacheCreationInputTokens !== undefined) {
		usage.cacheCreationInputTokens = cacheCreationInputTokens;
	}

	const response: ElizaNativeModelResponseRecord = {
		text: typeof call.response === "string" ? call.response : "",
	};
	if (Array.isArray(call.toolCalls)) response.toolCalls = call.toolCalls;
	if (typeof call.finishReason === "string") {
		response.finishReason = call.finishReason;
	}
	if (Object.keys(usage).length > 0) response.usage = usage;
	if (call.providerMetadata !== undefined) {
		response.providerMetadata = call.providerMetadata;
	}
	return response;
}

export function buildElizaNativeTrajectoryRows(
	trajectories: readonly TrajectoryDetailRecord[],
	options: { includePrompts?: boolean } = {},
): ElizaNativeTrajectoryRow[] {
	const includePrompts = options.includePrompts !== false;
	const out: ElizaNativeTrajectoryRow[] = [];

	for (const trajectory of trajectories) {
		const trajectoryTotals =
			trajectory.totals ?? summarizeTrajectoryUsage(trajectory);
		const cacheStats = summarizeTrajectoryCache(trajectory);
		for (const call of iterateTrajectoryLlmCalls(trajectory)) {
			const taskType = inferNativeTaskType(call);
			out.push({
				format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
				schemaVersion: 1,
				boundary: "vercel_ai_sdk.generateText",
				trajectoryId: call.trajectoryId,
				agentId: call.agentId,
				source: call.source,
				status: call.status,
				scenarioId: call.scenarioId,
				batchId: call.batchId,
				stepId: call.stepId,
				callId: call.callId,
				stepIndex: call.stepIndex,
				callIndex: call.callIndex,
				timestamp: call.timestamp,
				purpose: call.purpose,
				actionType: call.actionType,
				stepType: call.stepType,
				tags: call.tags,
				model: call.model,
				modelVersion: call.modelVersion,
				modelType: call.modelType ?? call.modelSlot,
				provider: call.provider,
				request: includePrompts ? buildNativeRequest(call) : {},
				response: includePrompts ? buildNativeResponse(call) : { text: "" },
				metadata: {
					task_type: taskType,
					source_dataset: "runtime_trajectory_boundary",
					trajectory_id: call.trajectoryId,
					step_id: call.stepId,
					call_id: call.callId,
					agent_id: call.agentId,
					trajectory_source: call.source,
					source_call_purpose: call.purpose,
					source_action_type: call.actionType,
					source_step_type: call.stepType,
					source_model: call.model,
					source_model_type: call.modelType ?? call.modelSlot,
					source_provider: call.provider,
				},
				trajectoryTotals,
				cacheStats,
			});
		}
	}

	return out;
}

function filterNumericMetrics(
	trajectory: TrajectoryDetailRecord,
): Record<string, number> {
	const metrics = asRecord(trajectory.metrics);
	if (!metrics) {
		return {};
	}
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(metrics)) {
		const numeric = toOptionalFiniteNumber(value);
		if (numeric !== undefined) {
			out[key] = numeric;
		}
	}
	return out;
}

function buildTrajectoryArtRows(
	trajectories: readonly TrajectoryDetailRecord[],
	options: { includePrompts?: boolean } = {},
): TrajectoryArtRow[] {
	const includePrompts = options.includePrompts !== false;
	return trajectories.map((trajectory) => {
		const messages: TrajectoryArtMessage[] = [];
		let previousSystemPrompt: string | undefined;
		for (const call of iterateTrajectoryLlmCalls(trajectory)) {
			const systemPrompt = includePrompts
				? toOptionalString(call.systemPrompt)
				: undefined;
			if (systemPrompt && systemPrompt !== previousSystemPrompt) {
				messages.push({ role: "system", content: systemPrompt });
				previousSystemPrompt = systemPrompt;
			}
			const userPrompt = includePrompts
				? toOptionalString(call.userPrompt)
				: undefined;
			if (userPrompt) {
				messages.push({ role: "user", content: userPrompt });
			}
			const response = includePrompts
				? toOptionalString(call.response)
				: undefined;
			if (response) {
				messages.push({ role: "assistant", content: response });
			}
		}

		return {
			messages,
			metadata: {
				trajectoryId: trajectory.trajectoryId,
				agentId: trajectory.agentId,
				source: resolveTrajectorySource(trajectory),
				status: resolveTrajectoryStatus(trajectory),
				scenarioId: trajectory.scenarioId,
				batchId: trajectory.batchId,
				trajectoryTotals:
					trajectory.totals ?? summarizeTrajectoryUsage(trajectory),
				cacheStats: summarizeTrajectoryCache(trajectory),
				metadata: trajectory.metadata ?? {},
			},
			metrics: filterNumericMetrics(trajectory),
		};
	});
}

export function resolveJsonShape(
	format: TrajectoryExportOptions["format"],
	jsonShape: TrajectoryJsonShape | undefined,
): TrajectoryJsonShape {
	if (jsonShape) {
		return jsonShape;
	}
	return format === "json" || format === "jsonl"
		? ELIZA_NATIVE_TRAJECTORY_FORMAT
		: "legacy";
}

function serializeLegacyJson(
	trajectories: readonly TrajectoryDetailRecord[],
	options: { includePrompts?: boolean } = {},
): string {
	if (options.includePrompts === false) {
		return JSON.stringify(
			trajectories.map((trajectory) => ({
				...trajectory,
				steps: listTrajectorySteps(trajectory).map((step) => ({
					...step,
					llmCalls: listStepLlmCalls(step).map((call) => ({
						...call,
						systemPrompt: undefined,
						userPrompt: undefined,
						response: undefined,
						reasoning: undefined,
					})),
				})),
			})),
			null,
			2,
		);
	}
	return JSON.stringify(trajectories, null, 2);
}

function serializeJsonLines(rows: readonly unknown[]): string {
	if (rows.length === 0) {
		return "";
	}
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function buildCsvRows(trajectories: readonly TrajectoryDetailRecord[]): string {
	const rows = [
		[
			"trajectoryId",
			"agentId",
			"source",
			"status",
			"startTime",
			"endTime",
			"durationMs",
			"scenarioId",
			"batchId",
			"stepCount",
			"llmCallCount",
			"providerAccessCount",
			"promptTokens",
			"completionTokens",
			"cacheReadInputTokens",
			"cacheCreationInputTokens",
		].join(","),
	];

	for (const trajectory of trajectories) {
		const totals = trajectory.totals ?? summarizeTrajectoryUsage(trajectory);
		rows.push(
			[
				csvEscape(trajectory.trajectoryId),
				csvEscape(trajectory.agentId),
				csvEscape(trajectory.source ?? ""),
				csvEscape(trajectory.status ?? trajectory.metrics?.finalStatus ?? ""),
				csvEscape(trajectory.startTime),
				csvEscape(trajectory.endTime ?? ""),
				csvEscape(trajectory.durationMs ?? ""),
				csvEscape(trajectory.scenarioId ?? ""),
				csvEscape(trajectory.batchId ?? ""),
				csvEscape(totals.stepCount),
				csvEscape(totals.llmCallCount),
				csvEscape(totals.providerAccessCount),
				csvEscape(totals.promptTokens),
				csvEscape(totals.completionTokens),
				csvEscape(totals.cacheReadInputTokens),
				csvEscape(totals.cacheCreationInputTokens),
			].join(","),
		);
	}

	return rows.join("\n");
}

export function serializeTrajectoryExport(
	trajectories: readonly TrajectoryDetailRecord[],
	options: TrajectoryExportOptions,
): TrajectoryExportResult {
	const stamp = Date.now();
	const jsonShape = resolveJsonShape(options.format, options.jsonShape);

	if (options.format === "json") {
		if (jsonShape === ELIZA_NATIVE_TRAJECTORY_FORMAT) {
			return {
				filename: `trajectories-${stamp}.eliza-native.json`,
				data: JSON.stringify(
					buildElizaNativeTrajectoryRows(trajectories, {
						includePrompts: options.includePrompts,
					}),
					null,
					2,
				),
				mimeType: "application/json",
			};
		}
		if (jsonShape === "context_object_events_v5") {
			return {
				filename: `trajectories-${stamp}.json`,
				data: JSON.stringify(
					trajectories.map((trajectory) =>
						buildContextObjectTrajectoryExport({ trajectory }),
					),
					null,
					2,
				),
				mimeType: "application/json",
			};
		}
		return {
			filename: `trajectories-${stamp}.json`,
			data: serializeLegacyJson(trajectories, {
				includePrompts: options.includePrompts,
			}),
			mimeType: "application/json",
		};
	}

	if (options.format === "jsonl") {
		if (jsonShape === ELIZA_NATIVE_TRAJECTORY_FORMAT) {
			return {
				filename: `trajectories-${stamp}.eliza-native.jsonl`,
				data: serializeJsonLines(
					buildElizaNativeTrajectoryRows(trajectories, {
						includePrompts: options.includePrompts,
					}),
				),
				mimeType: "application/x-ndjson",
			};
		}
		if (jsonShape === "context_object_events_v5") {
			return {
				filename: `trajectories-${stamp}.context-object.jsonl`,
				data: serializeJsonLines(
					trajectories.map((trajectory) =>
						buildContextObjectTrajectoryExport({ trajectory }),
					),
				),
				mimeType: "application/x-ndjson",
			};
		}
		if (jsonShape === "legacy") {
			return {
				filename: `trajectories-${stamp}.jsonl`,
				data: serializeJsonLines(
					(options.includePrompts === false
						? trajectories.map((trajectory) => ({
								...trajectory,
								steps: listTrajectorySteps(trajectory).map((step) => ({
									...step,
									llmCalls: listStepLlmCalls(step).map((call) => ({
										...call,
										systemPrompt: undefined,
										userPrompt: undefined,
										response: undefined,
										reasoning: undefined,
									})),
								})),
							}))
						: trajectories) as readonly unknown[],
				),
				mimeType: "application/x-ndjson",
			};
		}
		return {
			filename: `trajectories-${stamp}.eliza-native.jsonl`,
			data: serializeJsonLines(
				buildElizaNativeTrajectoryRows(trajectories, {
					includePrompts: options.includePrompts,
				}),
			),
			mimeType: "application/x-ndjson",
		};
	}

	if (options.format === "csv") {
		return {
			filename: `trajectories-${stamp}.csv`,
			data: buildCsvRows(trajectories),
			mimeType: "text/csv",
		};
	}

	if (options.format === "art") {
		return {
			filename: `trajectories-${stamp}.art.jsonl`,
			data: serializeJsonLines(
				buildTrajectoryArtRows(trajectories, {
					includePrompts: options.includePrompts,
				}),
			),
			mimeType: "application/x-ndjson",
		};
	}

	return {
		filename: `trajectories-${stamp}.json`,
		data: serializeLegacyJson(trajectories, {
			includePrompts: options.includePrompts,
		}),
		mimeType: "application/json",
	};
}
