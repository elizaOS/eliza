/**
 * Renders agent/PTY activity events and trajectory records into short,
 * human-readable plaintext summaries for surfaces that show an activity feed.
 * Pure formatting over loosely-typed event payloads — every field access is
 * guarded (`isRecord` / `readString` / `readFiniteNumber`), so malformed input
 * yields `null` rather than throwing; there is no runtime or IO dependency.
 *
 * `activityEventToPlaintext` dispatches on the event's `stream` for agent
 * events (assistant, lifecycle, action, tool, evaluator, provider, message,
 * memory, error, notification) and falls back to PTY task events.
 * `trajectoryToPlaintext` summarizes a trajectory summary/detail record with
 * its LLM calls, provider accesses, and events.
 */

import type {
	TrajectoryDetailRecord,
	TrajectoryLlmCallRecord,
	TrajectoryProviderAccessRecord,
	TrajectoryStepRecord,
	TrajectorySummaryRecord,
} from "./services/trajectory-types";

export interface ActivityPlaintextSummary {
	eventType: string;
	plaintext: string;
	stream?: string;
	source?: string;
	sessionId?: string;
}

export interface ActivityPlaintextOptions {
	maxLength?: number;
	includeUnknownAssistantText?: boolean;
}

export interface TrajectoryPlaintextOptions {
	maxItems?: number;
	maxFieldLength?: number;
}

export interface TrajectoryPlaintextEvent {
	id?: string;
	type?: string;
	stage?: string;
	status?: string;
	name?: string;
	actionName?: string;
	toolName?: string;
	evaluatorName?: string;
	providerName?: string;
	purpose?: string;
	decision?: string;
	thought?: string;
	error?: string;
	success?: boolean;
	hit?: boolean;
	key?: string;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface TrajectoryPlaintextInput {
	trajectory?:
		| Partial<TrajectorySummaryRecord>
		| Partial<TrajectoryDetailRecord>
		| null;
	llmCalls?: readonly TrajectoryLlmCallRecord[];
	providerAccesses?: readonly TrajectoryProviderAccessRecord[];
	events?: readonly TrajectoryPlaintextEvent[];
	steps?: readonly TrajectoryStepRecord[];
}

const DEFAULT_ACTIVITY_MAX_LENGTH = 120;
const DEFAULT_TRAJECTORY_MAX_ITEMS = 6;
const DEFAULT_TRAJECTORY_FIELD_LENGTH = 180;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
	value: unknown,
	options: { trim?: boolean } = { trim: true },
): string | undefined {
	if (typeof value !== "string") return undefined;
	return options.trim === false ? value : value.trim();
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function formatFiniteCount(value: unknown): string {
	const count = readFiniteNumber(value);
	return count === undefined ? "0" : String(count);
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizePlaintext(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength
		? normalized.slice(0, Math.max(0, maxLength)).trimEnd()
		: normalized;
}

function firstString(
	record: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = readString(record[key]);
		if (value) return value;
	}
	return undefined;
}

function nestedRecord(
	record: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

function summarizeToolRunning(
	data: Record<string, unknown> | undefined,
): string {
	const direct = firstString(data, ["description", "toolName", "name"]);
	if (direct) return direct;

	const toolCall = data ? nestedRecord(data, "toolCall") : undefined;
	const rawInput = toolCall ? nestedRecord(toolCall, "rawInput") : undefined;
	const title = firstString(toolCall, ["title", "kind", "name"]);
	const richInput = firstString(rawInput, [
		"command",
		"cmd",
		"file_path",
		"path",
		"pattern",
		"query",
	]);

	if (title && richInput) {
		return `${title}: ${richInput}`;
	}
	return title ?? richInput ?? "tool";
}

function activityResult(params: {
	eventType: string;
	plaintext: string;
	maxLength: number;
	stream?: string;
	source?: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const plaintext = normalizePlaintext(params.plaintext, params.maxLength);
	if (!params.eventType || !plaintext) return null;
	return {
		eventType: params.eventType,
		plaintext,
		...(params.stream ? { stream: params.stream } : {}),
		...(params.source ? { source: params.source } : {}),
		...(params.sessionId ? { sessionId: params.sessionId } : {}),
	};
}

function assistantSourceToEventType(source: string): string | null {
	switch (source) {
		case "reminder":
			return "reminder";
		case "workflow":
			return "workflow";
		case "proactive-gm":
		case "proactive-gn":
		case "proactive-goal-check-in":
			return "check-in";
		case "proactive-nudge":
		case "proactive-social-overuse":
			return "nudge";
		default:
			return null;
	}
}

function agentEventSessionId(
	event: Record<string, unknown>,
	payload: Record<string, unknown> | undefined,
): string | undefined {
	return (
		readString(event.sessionKey) ??
		readString(event.sessionId) ??
		readString(payload?.sessionKey)
	);
}

function durationSuffix(payload: Record<string, unknown>): string {
	const duration = formatDuration(payload.duration ?? payload.durationMs);
	return duration ? ` (${duration})` : "";
}

function previewFrom(
	payload: Record<string, unknown>,
	keys: readonly string[],
	maxLength: number,
): string | null {
	for (const key of keys) {
		const value = payload[key];
		const preview = safeJsonPreview(value, Math.min(maxLength, 80));
		if (preview) return preview;
	}
	return null;
}

function suffixDetail(base: string, detail: string | null | undefined): string {
	return detail ? `${base}: ${detail}` : base;
}

function summarizeAssistantStream(params: {
	payload: Record<string, unknown> | undefined;
	maxLength: number;
	stream: string;
	sessionId?: string;
	options: ActivityPlaintextOptions;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId, options } = params;
	const source = readString(payload?.source);
	const text = firstString(payload, ["text", "summary", "message", "content"]);
	const eventType =
		source === undefined
			? null
			: (assistantSourceToEventType(source) ??
				(options.includeUnknownAssistantText ? source : null));
	if (source) {
		if (!eventType || !text) return null;
		return activityResult({
			eventType,
			plaintext: text,
			maxLength,
			stream,
			source,
			sessionId,
		});
	}

	const assistantType = readString(payload?.type);
	if (!assistantType || !text) return null;
	const label =
		assistantType === "message"
			? "Assistant message"
			: assistantType === "thought"
				? "Assistant thought"
				: assistantType === "plan"
					? "Assistant plan"
					: assistantType === "reflection"
						? "Assistant reflection"
						: "Assistant activity";
	return activityResult({
		eventType:
			assistantType === "message" ? "message" : `assistant_${assistantType}`,
		plaintext: `${label}: ${text}`,
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeLifecycleStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) ?? "event";
	const stepName = firstString(payload, ["stepName", "name"]);
	const actionName = firstString(payload, ["actionName", "name"]);
	const success = readBoolean(payload.success);
	const error = firstString(payload, ["error", "message"]);
	let eventType = type;
	let plaintext: string;

	switch (type) {
		case "run_start":
			plaintext = "Run started";
			break;
		case "run_end":
			eventType = success === false ? "error" : "run_end";
			plaintext =
				success === false
					? suffixDetail("Run failed", error)
					: `Run completed${durationSuffix(payload)}`;
			break;
		case "step_start":
			plaintext = `Step started: ${stepName ?? "step"}`;
			break;
		case "step_end":
			eventType = success === false ? "error" : "step_end";
			plaintext =
				success === false
					? suffixDetail(`Step failed: ${stepName ?? "step"}`, error)
					: `Step completed: ${stepName ?? "step"}${durationSuffix(payload)}`;
			break;
		case "context_loaded":
			plaintext = "Context loaded";
			break;
		case "action_start":
			eventType = "action_start";
			plaintext = `Action started: ${actionName ?? "action"}`;
			break;
		case "action_end":
			eventType = success === false ? "action_error" : "action_complete";
			plaintext =
				success === false
					? suffixDetail(`Action failed: ${actionName ?? "action"}`, error)
					: `Action completed: ${actionName ?? "action"}${durationSuffix(payload)}`;
			break;
		default:
			plaintext = type.replace(/_/g, " ");
			break;
	}

	return activityResult({
		eventType,
		plaintext,
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeActionStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) ?? "event";
	const actionName = firstString(payload, ["actionName", "handler", "name"]);
	const detail =
		firstString(payload, ["error"]) ??
		previewFrom(payload, ["output", "input"], maxLength);
	const eventType =
		type === "error" || readBoolean(payload.success) === false
			? "action_error"
			: type === "complete"
				? "action_complete"
				: type === "skipped"
					? "action_skipped"
					: "action_start";
	const verb =
		eventType === "action_error"
			? "failed"
			: eventType === "action_complete"
				? "completed"
				: eventType === "action_skipped"
					? "skipped"
					: "started";
	const duration =
		verb === "completed" || verb === "failed" ? durationSuffix(payload) : "";
	return activityResult({
		eventType,
		plaintext: suffixDetail(
			`Action ${verb}: ${actionName ?? "action"}${duration}`,
			detail,
		),
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeToolStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) ?? "tool_call";
	const toolName = firstString(payload, ["toolName", "name"]) ?? "tool";
	const detail =
		firstString(payload, ["error"]) ??
		previewFrom(payload, ["output", "input"], maxLength);
	const eventType =
		type === "tool_error"
			? "tool_error"
			: type === "tool_result"
				? "tool_result"
				: "tool_call";
	const verb =
		eventType === "tool_error"
			? "failed"
			: eventType === "tool_result"
				? "completed"
				: "called";
	const duration =
		verb === "completed" || verb === "failed" ? durationSuffix(payload) : "";
	return activityResult({
		eventType,
		plaintext: suffixDetail(`Tool ${verb}: ${toolName}${duration}`, detail),
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeEvaluatorStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) ?? "event";
	const evaluatorName = firstString(payload, ["evaluatorName", "name"]);
	const detail =
		firstString(payload, ["error"]) ??
		previewFrom(payload, ["result"], maxLength);
	const eventType =
		type === "error"
			? "evaluator_error"
			: type === "complete"
				? "evaluator_complete"
				: type === "skipped"
					? "evaluator_skipped"
					: "evaluator_start";
	const verb =
		eventType === "evaluator_error"
			? "failed"
			: eventType === "evaluator_complete"
				? readBoolean(payload.validated) === false
					? "completed without validation"
					: "completed"
				: eventType === "evaluator_skipped"
					? "skipped"
					: "started";
	const duration =
		eventType === "evaluator_complete" || eventType === "evaluator_error"
			? durationSuffix(payload)
			: "";
	return activityResult({
		eventType,
		plaintext: suffixDetail(
			`Evaluator ${verb}: ${evaluatorName ?? "evaluator"}${duration}`,
			detail,
		),
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeProviderStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) ?? "event";
	const providerName = firstString(payload, ["providerName", "name"]);
	const detail =
		firstString(payload, ["error"]) ??
		previewFrom(payload, ["data"], maxLength);
	const eventType =
		type === "error"
			? "provider_error"
			: type === "cached" || readBoolean(payload.fromCache) === true
				? "provider_cached"
				: type === "complete"
					? "provider_complete"
					: "provider_start";
	const verb =
		eventType === "provider_error"
			? "failed"
			: eventType === "provider_cached"
				? "served from cache"
				: eventType === "provider_complete"
					? "completed"
					: "started";
	const duration =
		eventType === "provider_complete" || eventType === "provider_error"
			? durationSuffix(payload)
			: "";
	return activityResult({
		eventType,
		plaintext: suffixDetail(
			`Provider ${verb}: ${providerName ?? "provider"}${duration}`,
			detail,
		),
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeMessageStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) ?? "received";
	const channel = firstString(payload, ["channel", "source"]);
	const content = firstString(payload, ["content", "text", "message"]);
	const attachmentText =
		readBoolean(payload.hasAttachments) === true ? " with attachments" : "";
	const eventType = `message_${type}`;
	const verb =
		type === "sent"
			? "sent"
			: type === "queued"
				? "queued"
				: type === "failed"
					? "failed"
					: "received";
	const base = `Message ${verb}${channel ? ` on ${channel}` : ""}${attachmentText}`;
	const detail = type === "failed" ? firstString(payload, ["error"]) : content;
	return activityResult({
		eventType,
		plaintext: suffixDetail(base, detail),
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeMemoryStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) ?? "event";
	const tableName = firstString(payload, ["tableName", "collection"]);
	const preview = firstString(payload, ["error", "preview"]);
	const count = readFiniteNumber(payload.count);
	const location = tableName ? ` in ${tableName}` : "";
	const eventType = `memory_${type}`;
	let plaintext: string;
	switch (type) {
		case "create":
			plaintext = `Memory created${location}`;
			break;
		case "update":
			plaintext = `Memory updated${location}`;
			break;
		case "delete":
			plaintext = `Memory deleted${location}`;
			break;
		case "search":
			plaintext = `Memory searched${location}${
				count !== undefined ? ` (${count} result${count === 1 ? "" : "s"})` : ""
			}${durationSuffix(payload)}`;
			break;
		case "retrieved":
			plaintext = `Memory retrieved${location}${
				count !== undefined ? ` (${count} item${count === 1 ? "" : "s"})` : ""
			}`;
			break;
		default:
			plaintext = `Memory ${type.replace(/_/g, " ")}${location}`;
			break;
	}
	return activityResult({
		eventType,
		plaintext: suffixDetail(plaintext, preview ?? null),
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeErrorStream(params: {
	payload: Record<string, unknown>;
	maxLength: number;
	stream: string;
	sessionId?: string;
}): ActivityPlaintextSummary | null {
	const { payload, maxLength, stream, sessionId } = params;
	const type = readString(payload.type) === "warning" ? "warning" : "error";
	const code = firstString(payload, ["code"]);
	const message = firstString(payload, ["message", "error"]) ?? "Unknown error";
	return activityResult({
		eventType: type,
		plaintext: `${type === "warning" ? "Warning" : "Error"}${
			code ? ` ${code}` : ""
		}: ${message}`,
		maxLength,
		stream,
		sessionId,
	});
}

function summarizeAgentEvent(
	event: Record<string, unknown>,
	maxLength: number,
	options: ActivityPlaintextOptions,
): ActivityPlaintextSummary | null {
	const stream = readString(event.stream);
	const payload = nestedRecord(event, "payload") ?? nestedRecord(event, "data");
	const sessionId = agentEventSessionId(event, payload);
	if (!stream) return null;

	if (stream === "assistant") {
		return summarizeAssistantStream({
			payload,
			maxLength,
			stream,
			sessionId,
			options,
		});
	}

	if (stream === "notification") {
		const notification =
			payload && isRecord(payload.notification)
				? (payload.notification as Record<string, unknown>)
				: payload;
		const title = firstString(notification, [
			"title",
			"summary",
			"message",
			"text",
		]);
		const body = firstString(notification, ["body", "description"]);
		const text =
			title && body && title !== body ? `${title} - ${body}` : (title ?? body);
		if (!text) return null;
		const priority = readString(notification?.priority);
		return activityResult({
			eventType:
				priority === "urgent" || priority === "high" ? "approval" : "message",
			plaintext: text,
			maxLength,
			stream,
			sessionId,
		});
	}

	if (!payload) return null;

	switch (stream) {
		case "lifecycle":
			return summarizeLifecycleStream({
				payload,
				maxLength,
				stream,
				sessionId,
			});
		case "action":
			return summarizeActionStream({ payload, maxLength, stream, sessionId });
		case "tool":
			return summarizeToolStream({ payload, maxLength, stream, sessionId });
		case "evaluator":
			return summarizeEvaluatorStream({
				payload,
				maxLength,
				stream,
				sessionId,
			});
		case "provider":
			return summarizeProviderStream({ payload, maxLength, stream, sessionId });
		case "message":
			return summarizeMessageStream({ payload, maxLength, stream, sessionId });
		case "memory":
			return summarizeMemoryStream({ payload, maxLength, stream, sessionId });
		case "error":
			return summarizeErrorStream({ payload, maxLength, stream, sessionId });
		default:
			return null;
	}
}

function summarizePtyEvent(
	event: Record<string, unknown>,
	maxLength: number,
): ActivityPlaintextSummary | null {
	const eventType = readString(event.eventType) ?? readString(event.type);
	if (!eventType || eventType === "agent_event") return null;
	const sessionId = readString(event.sessionId);
	const data = nestedRecord(event, "data");

	let plaintext = eventType;
	switch (eventType) {
		case "task_registered":
			plaintext = `Task started: ${
				firstString(data, ["label", "title", "name"]) ?? sessionId ?? "unknown"
			}`;
			break;
		case "task_complete":
			plaintext = "Task completed";
			break;
		case "stopped":
			plaintext = "Task stopped";
			break;
		case "tool_running":
			plaintext = `Running ${summarizeToolRunning(data)}`;
			break;
		case "blocked":
			plaintext = "Waiting for input";
			break;
		case "blocked_auto_resolved":
			plaintext = "Decision auto-approved";
			break;
		case "escalation":
			plaintext = "Escalated - needs attention";
			break;
		case "error":
			plaintext = firstString(data, ["message", "error"]) ?? "Error occurred";
			break;
		case "proactive-message": {
			const message = nestedRecord(event, "message");
			plaintext =
				firstString(message, ["text", "content"]) ??
				firstString(event, ["text", "message"]) ??
				"Proactive message";
			break;
		}
		default:
			break;
	}

	return activityResult({
		eventType,
		plaintext,
		maxLength,
		sessionId,
	});
}

export function activityEventToPlaintext(
	event: unknown,
	options: ActivityPlaintextOptions = {},
): ActivityPlaintextSummary | null {
	if (!isRecord(event)) return null;
	const maxLength = options.maxLength ?? DEFAULT_ACTIVITY_MAX_LENGTH;
	if (event.type === "agent_event" || typeof event.stream === "string") {
		const agentSummary = summarizeAgentEvent(event, maxLength, options);
		if (agentSummary) return agentSummary;
	}
	return summarizePtyEvent(event, maxLength);
}

function formatDuration(ms: unknown): string | null {
	const value = readFiniteNumber(ms);
	if (value === undefined) return null;
	if (value < 1000) return `${Math.round(value)}ms`;
	const seconds = value / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds % 60);
	return `${minutes}m ${remainder}s`;
}

function safeJsonPreview(value: unknown, maxLength: number): string | null {
	if (value == null) return null;
	if (typeof value === "string") {
		const text = normalizePlaintext(value, maxLength);
		return text || null;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	try {
		return normalizePlaintext(JSON.stringify(value), maxLength) || null;
	} catch {
		return normalizePlaintext(String(value), maxLength) || null;
	}
}

function trajectoryRecordFromInput(
	input:
		| TrajectoryPlaintextInput
		| TrajectorySummaryRecord
		| TrajectoryDetailRecord,
): Record<string, unknown> {
	const record = input as Record<string, unknown>;
	return isRecord(record.trajectory)
		? (record.trajectory as Record<string, unknown>)
		: record;
}

function parseTrajectoryStepsJson(value: unknown): TrajectoryStepRecord[] {
	if (typeof value !== "string" || value.trim().length === 0) {
		return [];
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? (parsed as TrajectoryStepRecord[]) : [];
	} catch {
		return [];
	}
}

function collectTrajectorySteps(
	input: TrajectoryPlaintextInput | TrajectoryDetailRecord,
): TrajectoryStepRecord[] {
	const record = trajectoryRecordFromInput(input);
	const directSteps =
		isRecord(input) && Array.isArray(input.steps)
			? (input.steps as TrajectoryStepRecord[])
			: [];
	const nestedSteps =
		record !== input && Array.isArray(record.steps)
			? (record.steps as TrajectoryStepRecord[])
			: [];
	const jsonSteps = parseTrajectoryStepsJson(record.stepsJson);
	return [...directSteps, ...nestedSteps, ...jsonSteps];
}

function collectLlmCalls(
	input: TrajectoryPlaintextInput | TrajectoryDetailRecord,
): TrajectoryLlmCallRecord[] {
	const direct =
		isRecord(input) && Array.isArray(input.llmCalls) ? input.llmCalls : [];
	return [
		...(direct as TrajectoryLlmCallRecord[]),
		...collectTrajectorySteps(input).flatMap((step) => step.llmCalls ?? []),
	];
}

function collectProviderAccesses(
	input: TrajectoryPlaintextInput | TrajectoryDetailRecord,
): TrajectoryProviderAccessRecord[] {
	const direct =
		isRecord(input) && Array.isArray(input.providerAccesses)
			? input.providerAccesses
			: [];
	return [
		...(direct as TrajectoryProviderAccessRecord[]),
		...collectTrajectorySteps(input).flatMap(
			(step) => step.providerAccesses ?? [],
		),
	];
}

function collectTrajectoryEvents(
	input: TrajectoryPlaintextInput,
): TrajectoryPlaintextEvent[] {
	return isRecord(input) && Array.isArray(input.events)
		? (input.events as TrajectoryPlaintextEvent[])
		: [];
}

export function trajectoryEventToPlaintext(
	event: TrajectoryPlaintextEvent,
	options: TrajectoryPlaintextOptions = {},
): string {
	const maxFieldLength =
		options.maxFieldLength ?? DEFAULT_TRAJECTORY_FIELD_LENGTH;
	const type = readString(event.type) ?? "event";
	const label =
		firstString(event, [
			"actionName",
			"toolName",
			"evaluatorName",
			"providerName",
			"name",
			"label",
		]) ?? type.replace(/_/g, " ");

	if (type === "tool_call" || type === "tool_result" || type === "tool_error") {
		const status =
			event.success === false || type === "tool_error"
				? "failed"
				: (readString(event.status) ?? "completed");
		const detail =
			firstString(event, ["error"]) ??
			safeJsonPreview(
				event.result ?? event.output ?? event.args ?? event.input,
				maxFieldLength,
			);
		return detail ? `${label} ${status}: ${detail}` : `${label} ${status}`;
	}

	if (type === "evaluation" || type === "evaluator") {
		const detail =
			firstString(event, ["thought", "decision", "error"]) ??
			safeJsonPreview(event.result, maxFieldLength);
		return detail ? `${label}: ${detail}` : label;
	}

	if (type === "cache_observation" || type === "cache") {
		const cacheName = firstString(event, ["cacheName", "scope"]) ?? label;
		const hit = event.hit === true ? "hit" : "miss";
		const key = readString(event.key);
		return key ? `${cacheName} ${hit}: ${key}` : `${cacheName} ${hit}`;
	}

	if (type === "context_diff") {
		const added = formatFiniteCount(event.added);
		const removed = formatFiniteCount(event.removed);
		const changed = formatFiniteCount(event.changed);
		return `${label}: ${added} added, ${removed} removed, ${changed} changed`;
	}

	return label;
}

export function trajectoryToPlaintext(
	input:
		| TrajectoryPlaintextInput
		| TrajectorySummaryRecord
		| TrajectoryDetailRecord
		| null
		| undefined,
	options: TrajectoryPlaintextOptions = {},
): string {
	if (!isRecord(input)) return "Trajectory unavailable";

	const maxItems = options.maxItems ?? DEFAULT_TRAJECTORY_MAX_ITEMS;
	const maxFieldLength =
		options.maxFieldLength ?? DEFAULT_TRAJECTORY_FIELD_LENGTH;
	const trajectory = trajectoryRecordFromInput(input);
	const id =
		readString(trajectory.id) ??
		readString(trajectory.trajectoryId) ??
		"unknown";
	const status = readString(trajectory.status) ?? "unknown";
	const source = readString(trajectory.source);
	const duration =
		formatDuration(trajectory.durationMs) ??
		formatDuration(
			readFiniteNumber(trajectory.endTime) !== undefined &&
				readFiniteNumber(trajectory.startTime) !== undefined
				? (trajectory.endTime as number) - (trajectory.startTime as number)
				: undefined,
		);

	const llmCalls = collectLlmCalls(input as TrajectoryPlaintextInput);
	const providerAccesses = collectProviderAccesses(
		input as TrajectoryPlaintextInput,
	);
	const events = collectTrajectoryEvents(input as TrajectoryPlaintextInput);
	const llmCallCount =
		readFiniteNumber(trajectory.llmCallCount) ?? llmCalls.length;
	const providerAccessCount =
		readFiniteNumber(trajectory.providerAccessCount) ?? providerAccesses.length;
	const promptTokens = readFiniteNumber(trajectory.totalPromptTokens);
	const completionTokens = readFiniteNumber(trajectory.totalCompletionTokens);

	const lines = [`Trajectory ${id} (${status})`];
	const meta: string[] = [];
	if (source) meta.push(`source: ${source}`);
	if (duration) meta.push(`duration: ${duration}`);
	meta.push(`llm calls: ${llmCallCount}`);
	meta.push(`provider accesses: ${providerAccessCount}`);
	if (promptTokens !== undefined || completionTokens !== undefined) {
		meta.push(
			`tokens: ${promptTokens ?? 0} prompt / ${completionTokens ?? 0} completion`,
		);
	}
	lines.push(meta.join("; "));

	const selectedCalls = llmCalls.slice(0, maxItems);
	if (selectedCalls.length > 0) {
		lines.push("LLM calls:");
		for (const call of selectedCalls) {
			const callId = readString(call.callId);
			const label =
				readString(call.purpose) ??
				readString(call.actionType) ??
				readString(call.stepType) ??
				"llm";
			const labelWithId = callId ? `LLM call ${callId}: ${label}` : label;
			const model = [call.provider, call.model].filter(Boolean).join("/");
			const preview = safeJsonPreview(
				call.response ?? call.userPrompt ?? call.prompt,
				maxFieldLength,
			);
			lines.push(
				`- ${labelWithId}${model ? ` ${model}` : ""}${preview ? `: ${preview}` : ""}`,
			);
		}
		if (llmCalls.length > selectedCalls.length) {
			lines.push(
				`- ${llmCalls.length - selectedCalls.length} more LLM call(s)`,
			);
		}
	}

	const selectedProviders = providerAccesses.slice(0, maxItems);
	if (selectedProviders.length > 0) {
		lines.push("Provider accesses:");
		for (const access of selectedProviders) {
			const label = readString(access.providerName) ?? "provider";
			const purpose = readString(access.purpose);
			const preview = safeJsonPreview(
				access.query ?? access.data,
				maxFieldLength,
			);
			lines.push(
				`- ${label}${purpose ? ` ${purpose}` : ""}${preview ? `: ${preview}` : ""}`,
			);
		}
		if (providerAccesses.length > selectedProviders.length) {
			lines.push(
				`- ${providerAccesses.length - selectedProviders.length} more provider access(es)`,
			);
		}
	}

	const selectedEvents = events.slice(0, maxItems);
	if (selectedEvents.length > 0) {
		lines.push("Events:");
		for (const event of selectedEvents) {
			lines.push(`- ${trajectoryEventToPlaintext(event, options)}`);
		}
		if (events.length > selectedEvents.length) {
			lines.push(`- ${events.length - selectedEvents.length} more event(s)`);
		}
	}

	return lines.join("\n");
}
