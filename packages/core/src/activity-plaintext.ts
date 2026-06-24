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

function summarizeAgentEvent(
	event: Record<string, unknown>,
	maxLength: number,
	options: ActivityPlaintextOptions,
): ActivityPlaintextSummary | null {
	const stream = readString(event.stream) ?? "";
	const payload = nestedRecord(event, "payload") ?? nestedRecord(event, "data");

	if (stream === "assistant") {
		const source = readString(payload?.source) ?? "";
		const text = firstString(payload, ["text", "summary", "message"]);
		const eventType =
			assistantSourceToEventType(source) ??
			(options.includeUnknownAssistantText && source ? source : null);
		if (!eventType || !text) return null;
		return activityResult({
			eventType,
			plaintext: text,
			maxLength,
			stream,
			source,
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
			title && body && title !== body
				? `${title} - ${body}`
				: (title ?? body ?? "");
		const priority = readString(notification?.priority);
		return activityResult({
			eventType:
				priority === "urgent" || priority === "high" ? "approval" : "message",
			plaintext: text,
			maxLength,
			stream,
		});
	}

	return null;
}

function summarizePtyEvent(
	event: Record<string, unknown>,
	maxLength: number,
): ActivityPlaintextSummary | null {
	const eventType = readString(event.eventType) ?? readString(event.type) ?? "";
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
			plaintext = `Running ${
				firstString(data, ["description", "toolName", "name"]) ?? "tool"
			}`;
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

function collectLlmCalls(
	input: TrajectoryPlaintextInput | TrajectoryDetailRecord,
): TrajectoryLlmCallRecord[] {
	const direct =
		isRecord(input) && Array.isArray(input.llmCalls) ? input.llmCalls : [];
	const steps =
		isRecord(input) && Array.isArray(input.steps) ? input.steps : [];
	return [
		...(direct as TrajectoryLlmCallRecord[]),
		...(steps as TrajectoryStepRecord[]).flatMap((step) => step.llmCalls ?? []),
	];
}

function collectProviderAccesses(
	input: TrajectoryPlaintextInput | TrajectoryDetailRecord,
): TrajectoryProviderAccessRecord[] {
	const direct =
		isRecord(input) && Array.isArray(input.providerAccesses)
			? input.providerAccesses
			: [];
	const steps =
		isRecord(input) && Array.isArray(input.steps) ? input.steps : [];
	return [
		...(direct as TrajectoryProviderAccessRecord[]),
		...(steps as TrajectoryStepRecord[]).flatMap(
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
		const added = readFiniteNumber(event.added) ?? 0;
		const removed = readFiniteNumber(event.removed) ?? 0;
		const changed = readFiniteNumber(event.changed) ?? 0;
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
			const label =
				readString(call.purpose) ??
				readString(call.actionType) ??
				readString(call.stepType) ??
				"llm";
			const model = [call.provider, call.model].filter(Boolean).join("/");
			const preview = safeJsonPreview(
				call.response ?? call.userPrompt ?? call.prompt,
				maxFieldLength,
			);
			lines.push(
				`- ${label}${model ? ` ${model}` : ""}${preview ? `: ${preview}` : ""}`,
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
