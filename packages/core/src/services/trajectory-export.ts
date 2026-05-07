import { buildContextObjectTrajectoryExport } from "../trajectory-utils";
import type {
	TrajectoryCacheStatsRecord,
	TrajectoryDetailRecord,
	TrajectoryExportOptions,
	TrajectoryExportResult,
	TrajectoryFlattenedLlmCallRecord,
	TrajectoryHarnessExportRow,
	TrajectoryJsonShape,
	TrajectoryLlmCallRecord,
	TrajectoryStepRecord,
	TrajectoryTrainingMessageRecord,
	TrajectoryUsageTotalsRecord,
} from "./trajectory-types";

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

export function buildTrajectoryTrainingMessages(
	call: Pick<
		TrajectoryLlmCallRecord,
		"systemPrompt" | "userPrompt" | "response"
	>,
): TrajectoryTrainingMessageRecord[] | null {
	const systemPrompt = toOptionalString(call.systemPrompt);
	const userPrompt = toOptionalString(call.userPrompt);
	const response = toOptionalString(call.response);
	if (!systemPrompt || !userPrompt || !response) {
		return null;
	}
	return [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
		{ role: "model", content: response },
	];
}

export function buildTrajectoryHarnessRows(
	trajectories: readonly TrajectoryDetailRecord[],
	options: { includePrompts?: boolean } = {},
): TrajectoryHarnessExportRow[] {
	const includePrompts = options.includePrompts !== false;
	const out: TrajectoryHarnessExportRow[] = [];

	for (const trajectory of trajectories) {
		const trajectoryTotals =
			trajectory.totals ?? summarizeTrajectoryUsage(trajectory);
		const cacheStats = summarizeTrajectoryCache(trajectory);
		for (const call of iterateTrajectoryLlmCalls(trajectory)) {
			out.push({
				...call,
				format: "trajectory_harness_v1",
				systemPrompt: includePrompts ? call.systemPrompt : undefined,
				userPrompt: includePrompts ? call.userPrompt : undefined,
				response: includePrompts ? call.response : undefined,
				messages: includePrompts
					? (buildTrajectoryTrainingMessages(call) ?? [])
					: [],
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
	return format === "jsonl" ? "harness_v1" : "legacy";
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
		if (jsonShape === "harness_v1") {
			return {
				filename: `trajectories-${stamp}.harness.json`,
				data: JSON.stringify(
					buildTrajectoryHarnessRows(trajectories, {
						includePrompts: options.includePrompts,
					}),
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
			filename: `trajectories-${stamp}.harness.jsonl`,
			data: serializeJsonLines(
				buildTrajectoryHarnessRows(trajectories, {
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
