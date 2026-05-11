/**
 * Trajectory recorder — JSON-file backend for the v5 native-tool-calling
 * trajectory observability subsystem.
 *
 * Spec: PLAN.md §18.1 (`RecordedStage` / `RecordedTrajectory` schemas) and
 * §18.2 (`TrajectoryRecorder` interface).
 *
 * Output shape is read by `scripts/trajectory.ts` and `scripts/run-eliza-cerebras.ts`.
 *
 * Persistence model:
 * - One JSON file per trajectory at
 *   `${MILADY_TRAJECTORY_DIR ?? `${MILADY_STATE_DIR ?? `${ELIZA_STATE_DIR ?? ~/.milady`}/trajectories`}`}/<agentId>/<trajectoryId>.json`.
 * - Atomic writes: write to `<id>.json.tmp`, rename to `<id>.json`.
 * - Append-only stages: `recordStage` rewrites the whole file (small files,
 *   sub-100 KB typical).
 * - Failures must NOT crash the runtime — every I/O operation is wrapped in
 *   try/catch and routed through `runtime.logger.warn`.
 *
 * Toggle via `MILADY_TRAJECTORY_RECORDING=0`. Default on.
 */

import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	computeCallCostUsd,
	PRICE_TABLE_ID,
} from "../features/trajectories/pricing";
import type { EvaluationResult } from "../types/components";
import type { ChatMessage, ToolChoice } from "../types/model";

// ---------------------------------------------------------------------------
// Schema (mirrors PLAN.md §18.1)
// ---------------------------------------------------------------------------

export type RecordedStageKind =
	| "messageHandler"
	| "planner"
	| "tool"
	| "toolSearch"
	| "evaluation"
	| "subPlanner"
	| "compaction"
	| "factsAndRelationships";

export interface RecordedUsage {
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	totalTokens: number;
}

export interface RecordedToolCall {
	id?: string;
	name?: string;
	args?: Record<string, unknown>;
}

export interface RecordedModelCall {
	modelType: string;
	modelName?: string;
	provider: string;
	prompt?: string;
	messages?: ChatMessage[] | unknown[];
	tools?: unknown;
	toolChoice?: ToolChoice | unknown;
	providerOptions?: unknown;
	response: string;
	toolCalls?: RecordedToolCall[];
	usage?: RecordedUsage;
	finishReason?: string;
	/**
	 * USD cost of this LLM call computed from the price table identified by
	 * `priceTableId`. Local-inference providers (Ollama / LM Studio /
	 * llama.cpp) record a real `0` — not "missing". The recorder emits a
	 * warning log when a hosted-provider model has no price entry; the
	 * field defaults to `0` in that case so cost roll-ups stay numeric.
	 */
	costUsd?: number;
	/**
	 * Snapshot identifier of the price table used to compute `costUsd`.
	 * Closes M40 / W1-X1. Bumped whenever any rate in the canonical
	 * pricing table at `features/trajectories/pricing.ts` changes.
	 */
	priceTableId?: string;
}

/**
 * Marker emitted when one of `input`, `output`, or `error` exceeds the
 * configured byte cap. The original payload is replaced with a string
 * preview followed by an annotation; the metadata block here surfaces the
 * original size so reviewers and downstream training pipelines can decide
 * how to treat the truncation.
 */
export interface RecordedTruncationMarker {
	field: "input" | "output" | "error";
	originalBytes: number;
	capBytes: number;
}

export interface RecordedToolStage {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	success: boolean;
	durationMs: number;
	error?: string;
	/**
	 * Captured action-handler input (the resolved params passed into the
	 * action). Encoded as JSON when possible. Capped at
	 * `MILADY_TRAJECTORY_FIELD_CAP_BYTES` (default 64KB); oversize values
	 * are truncated and a marker is added to `truncated[]`.
	 */
	input?: string;
	/**
	 * Captured action-handler output (the full result the action returned,
	 * not just the planner-shaped summary). Same encoding and cap as
	 * `input`.
	 */
	output?: string;
	/**
	 * Captured action-handler error text. Same cap as `input`/`output`.
	 * Mirrors `error` for free-text reads; structured `error` above is kept
	 * for backwards compatibility with existing readers.
	 */
	errorText?: string;
	/**
	 * Per-field truncation markers. Present only when at least one of
	 * `input`, `output`, or `errorText` was truncated by the byte cap.
	 */
	truncated?: RecordedTruncationMarker[];
}

/**
 * Snapshot of the tool-search / action-retrieval phase. Logged once per
 * planner turn before the LLM call so reviewers can see which actions
 * were considered, the retrieval scores, and which tier each landed in.
 */
export interface RecordedToolSearchStage {
	query: {
		text: string;
		tokens?: string[];
		candidateActions?: string[];
		parentActionHints?: string[];
	};
	results: Array<{
		name: string;
		score: number;
		rank: number;
		rrfScore?: number;
		matchedBy?: string[];
		stageScores?: Record<string, number>;
	}>;
	tier: { tierA: string[]; tierB: string[]; omitted: number };
	durationMs: number;
	fallback?: string;
}

export interface RecordedEvaluationStage extends EvaluationResult {
	[key: string]: unknown;
}

/**
 * Snapshot of the facts/relationships extraction stage. Logged whenever
 * Stage 1 emits a non-empty `extract` and the dedup/persist pass runs in
 * parallel with the planner. Lets reviewers see (a) what the model thought
 * was worth keeping vs. dropping, and (b) what actually persisted.
 */
export interface RecordedFactsAndRelationshipsStage {
	candidates: {
		facts: string[];
		relationships: Array<{
			subject: string;
			predicate: string;
			object: string;
		}>;
	};
	kept: {
		facts: string[];
		relationships: Array<{
			subject: string;
			predicate: string;
			object: string;
		}>;
	};
	written: { facts: number; relationships: number };
	thought: string;
}

export interface RecordedCacheStage {
	segmentHashes: string[];
	prefixHash: string;
	diffFromPriorStage?: {
		added: number;
		unchanged: number;
		removed: number;
	};
}

export interface RecordedStage {
	stageId: string;
	kind: RecordedStageKind;
	iteration?: number;
	retryIdx?: number;
	parentStageId?: string;
	startedAt: number;
	endedAt: number;
	latencyMs: number;
	model?: RecordedModelCall;
	tool?: RecordedToolStage;
	toolSearch?: RecordedToolSearchStage;
	evaluation?: RecordedEvaluationStage;
	cache?: RecordedCacheStage;
	factsAndRelationships?: RecordedFactsAndRelationshipsStage;
}

export interface RecordedTrajectoryMetrics {
	totalLatencyMs: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	totalCostUsd: number;
	plannerIterations: number;
	toolCallsExecuted: number;
	toolCallFailures: number;
	toolSearchCount: number;
	evaluatorFailures: number;
	finalDecision?: "FINISH" | "CONTINUE" | "max_iterations" | "error";
}

export interface RecordedTrajectory {
	trajectoryId: string;
	agentId: string;
	roomId?: string;
	runId?: string;
	scenarioId?: string;
	rootMessage: { id: string; text: string; sender?: string };
	startedAt: number;
	endedAt?: number;
	status: "running" | "finished" | "errored";
	stages: RecordedStage[];
	metrics: RecordedTrajectoryMetrics;
}

// ---------------------------------------------------------------------------
// TrajectoryRecorder interface (PLAN.md §18.2)
// ---------------------------------------------------------------------------

export interface StartTrajectoryInput {
	agentId: string;
	roomId?: string;
	rootMessage: { id: string; text: string; sender?: string };
	// Optional run / scenario correlation for the lifeops aggregator. When set
	// (typically by the scenario CLI via env vars before each scenario), the
	// recorder includes them on the persisted trajectory so the aggregator can
	// group trajectories per scenario without inferring from filesystem layout.
	runId?: string;
	scenarioId?: string;
}

export interface ListTrajectoriesOptions {
	agentId?: string;
	since?: number;
	limit?: number;
}

export interface TrajectoryRecorder {
	startTrajectory(input: StartTrajectoryInput): string;
	recordStage(trajectoryId: string, stage: RecordedStage): Promise<void>;
	endTrajectory(
		trajectoryId: string,
		status: "finished" | "errored",
	): Promise<void>;
	load(trajectoryId: string): Promise<RecordedTrajectory | null>;
	list(opts?: ListTrajectoriesOptions): Promise<RecordedTrajectory[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecorderLogger {
	warn?: (context: unknown, message?: string) => void;
	debug?: (context: unknown, message?: string) => void;
	error?: (context: unknown, message?: string) => void;
}

function envFlagEnabled(key: string, defaultValue = false): boolean {
	const raw = process.env[key];
	if (raw === undefined) return defaultValue;
	const normalized = raw.trim().toLowerCase();
	if (
		normalized === "0" ||
		normalized === "false" ||
		normalized === "no" ||
		normalized === "off"
	) {
		return false;
	}
	return normalized.length > 0;
}

/**
 * Resolve the on-disk trajectory directory. Precedence per PLAN.md §18.1:
 *   MILADY_TRAJECTORY_DIR
 *   MILADY_STATE_DIR/trajectories
 *   ELIZA_STATE_DIR/trajectories
 *   ~/.milady/trajectories
 */
export function resolveTrajectoryDir(): string {
	const explicit = process.env.MILADY_TRAJECTORY_DIR?.trim();
	if (explicit) return explicit;

	const miladyState = process.env.MILADY_STATE_DIR?.trim();
	if (miladyState) return path.join(miladyState, "trajectories");

	const elizaState = process.env.ELIZA_STATE_DIR?.trim();
	if (elizaState) return path.join(elizaState, "trajectories");

	return path.join(homedir(), ".milady", "trajectories");
}

/**
 * Whether the recorder is enabled. Off when MILADY_TRAJECTORY_RECORDING=0.
 */
export function isTrajectoryRecordingEnabled(): boolean {
	return envFlagEnabled("MILADY_TRAJECTORY_RECORDING", true);
}

/**
 * Review mode writes a human-readable markdown sibling for every JSON
 * trajectory. It is opt-in so default runtime writes stay unchanged.
 */
export function isTrajectoryMarkdownReviewEnabled(): boolean {
	return (
		envFlagEnabled("MILADY_TRAJECTORY_REVIEW_MODE") ||
		envFlagEnabled("MILADY_TRAJECTORY_MARKDOWN") ||
		Boolean(process.env.MILADY_TRAJECTORY_MARKDOWN_DIR?.trim())
	);
}

function resolveTrajectoryMarkdownDir(rootDir: string): string {
	return process.env.MILADY_TRAJECTORY_MARKDOWN_DIR?.trim() || rootDir;
}

function safeRandomId(prefix: string): string {
	// Avoid pulling in node:crypto for hot-path id generation; the recorder
	// id space is small per agent.
	const rand = Math.random().toString(16).slice(2, 10);
	const ts = Date.now().toString(16).slice(-6);
	return `${prefix}-${ts}${rand}`;
}

function trajectoryFileName(id: string): string {
	return `${id}.json`;
}

function atomicTempPath(filePath: string): string {
	const rand = Math.random().toString(16).slice(2);
	return `${filePath}.${process.pid}.${Date.now().toString(36)}.${rand}.tmp`;
}

async function atomicWriteJson(
	filePath: string,
	value: unknown,
	logger?: RecorderLogger,
): Promise<void> {
	const dir = path.dirname(filePath);
	const tmp = atomicTempPath(filePath);
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
		await fs.rename(tmp, filePath);
	} catch (err) {
		logger?.warn?.(
			{ err: (err as Error).message, filePath },
			"[TrajectoryRecorder] atomic write failed",
		);
		try {
			await fs.unlink(tmp).catch(() => undefined);
		} catch {
			// ignore — best effort cleanup of the tmp file
		}
	}
}

async function atomicWriteText(
	filePath: string,
	value: string,
	logger?: RecorderLogger,
): Promise<void> {
	const dir = path.dirname(filePath);
	const tmp = atomicTempPath(filePath);
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(tmp, value, "utf8");
		await fs.rename(tmp, filePath);
	} catch (err) {
		logger?.warn?.(
			{ err: (err as Error).message, filePath },
			"[TrajectoryRecorder] markdown write failed",
		);
		try {
			await fs.unlink(tmp).catch(() => undefined);
		} catch {
			// ignore - best effort cleanup of the tmp file
		}
	}
}

function formatTimestamp(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "-";
	return new Date(ms).toISOString();
}

function formatDuration(ms: number | undefined): string {
	if (!ms || !Number.isFinite(ms)) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function safeStringifyForMarkdown(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function redactMarkdownSecrets(text: string): string {
	if (!envFlagEnabled("MILADY_TRAJECTORY_MARKDOWN_REDACT", true)) {
		return text;
	}
	const explicitSecrets = [
		process.env.CEREBRAS_API_KEY,
		process.env.OPENAI_API_KEY,
		process.env.ANTHROPIC_API_KEY,
		process.env.GROQ_API_KEY,
	].filter((value): value is string => Boolean(value?.trim()));
	let out = text;
	for (const secret of explicitSecrets) {
		out = out.split(secret).join("[REDACTED_SECRET]");
	}
	return out
		.replace(/\bcsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_CEREBRAS_KEY]")
		.replace(/\bsk-(?!test-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
		.replace(
			/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
			"Bearer [REDACTED_TOKEN]",
		);
}

function markdownFence(value: string, language = ""): string[] {
	const fence = value.includes("```") ? "````" : "```";
	return [language ? `${fence}${language}` : fence, value, fence];
}

function summarizeEmbeddingResponse(response: string): string | null {
	const trimmed = response.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (
			!Array.isArray(parsed) ||
			!parsed.every((value) => typeof value === "number")
		) {
			return null;
		}
		const preview = parsed
			.slice(0, 8)
			.map((value) => Number(value).toFixed(4))
			.join(", ");
		return `Embedding vector (${parsed.length} dimensions). Preview: [${preview}${parsed.length > 8 ? ", ..." : ""}]`;
	} catch {
		return null;
	}
}

function modelResponseForMarkdown(model: RecordedModelCall): string {
	if (model.modelType === "TEXT_EMBEDDING") {
		const summary = summarizeEmbeddingResponse(model.response);
		if (summary) return summary;
	}
	return model.response;
}

function renderTrajectoryMarkdown(trajectory: RecordedTrajectory): string {
	const lines: string[] = [];
	const metrics = trajectory.metrics;
	lines.push(`# Trajectory ${trajectory.trajectoryId}`);
	lines.push("");
	lines.push(`- agent: \`${trajectory.agentId}\``);
	lines.push(`- room: \`${trajectory.roomId ?? "-"}\``);
	lines.push(`- status: ${trajectory.status}`);
	lines.push(`- started: ${formatTimestamp(trajectory.startedAt)}`);
	lines.push(`- ended: ${formatTimestamp(trajectory.endedAt)}`);
	lines.push(
		`- total: ${formatDuration(metrics.totalLatencyMs)} · $${metrics.totalCostUsd.toFixed(6)}`,
	);
	lines.push(
		`- tokens: ${metrics.totalPromptTokens} input · ${metrics.totalCompletionTokens} output · ${metrics.totalCacheReadTokens} cache-read · ${metrics.totalCacheCreationTokens} cache-created`,
	);
	lines.push(`- root message id: \`${trajectory.rootMessage.id}\``);
	if (trajectory.rootMessage.text) {
		lines.push("");
		lines.push("## Root Message");
		lines.push("");
		lines.push(...markdownFence(trajectory.rootMessage.text));
	}
	lines.push("");

	for (const [index, stage] of trajectory.stages.entries()) {
		lines.push(
			`## Stage ${index + 1}: ${stage.kind}${stage.iteration ? ` iter ${stage.iteration}` : ""} (${stage.stageId})`,
		);
		lines.push("");
		lines.push(`- latency: ${formatDuration(stage.latencyMs)}`);
		lines.push(`- started: ${formatTimestamp(stage.startedAt)}`);
		lines.push(`- ended: ${formatTimestamp(stage.endedAt)}`);
		if (stage.parentStageId) {
			lines.push(`- parent: \`${stage.parentStageId}\``);
		}
		if (stage.model) {
			lines.push(
				`- model: \`${stage.model.modelName ?? stage.model.modelType}\` (${stage.model.provider})`,
			);
			if (stage.model.usage) {
				lines.push(
					`- usage: ${stage.model.usage.promptTokens} input · ${stage.model.usage.completionTokens} output · ${stage.model.usage.cacheReadInputTokens ?? 0} cache-read · ${stage.model.usage.cacheCreationInputTokens ?? 0} cache-created`,
				);
			}
			if (typeof stage.model.costUsd === "number") {
				lines.push(`- cost: $${stage.model.costUsd.toFixed(6)}`);
			}
			if (typeof stage.model.prompt === "string") {
				const prompt = stage.model.prompt;
				lines.push("");
				lines.push("### Prompt");
				lines.push("");
				lines.push(...markdownFence(prompt));
			}
			lines.push("");
			lines.push("### Response");
			lines.push("");
			lines.push(...markdownFence(modelResponseForMarkdown(stage.model)));
			if (stage.model.messages !== undefined) {
				lines.push("");
				lines.push("### Messages");
				lines.push("");
				lines.push(
					...markdownFence(
						safeStringifyForMarkdown(stage.model.messages),
						"json",
					),
				);
			}
			if (stage.model.tools !== undefined) {
				lines.push("");
				lines.push("### Tools");
				lines.push("");
				lines.push(
					...markdownFence(safeStringifyForMarkdown(stage.model.tools), "json"),
				);
			}
			if (stage.model.toolCalls !== undefined) {
				lines.push("");
				lines.push("### Tool Calls");
				lines.push("");
				lines.push(
					...markdownFence(
						safeStringifyForMarkdown(stage.model.toolCalls),
						"json",
					),
				);
			}
			if (stage.model.providerOptions !== undefined) {
				lines.push("");
				lines.push("### Provider Options");
				lines.push("");
				lines.push(
					...markdownFence(
						safeStringifyForMarkdown(stage.model.providerOptions),
						"json",
					),
				);
			}
		}
		if (stage.tool) {
			lines.push("");
			lines.push("### Tool Result");
			lines.push("");
			lines.push(
				`- tool: \`${stage.tool.name}\` ${stage.tool.success ? "ok" : "failed"}`,
			);
			lines.push(`- duration: ${formatDuration(stage.tool.durationMs)}`);
			lines.push(
				...markdownFence(
					safeStringifyForMarkdown({
						args: stage.tool.args,
						result: stage.tool.result,
					}),
					"json",
				),
			);
		}
		if (stage.evaluation) {
			lines.push("");
			lines.push("### Evaluation");
			lines.push("");
			lines.push(
				...markdownFence(safeStringifyForMarkdown(stage.evaluation), "json"),
			);
		}
		if (stage.cache) {
			lines.push("");
			lines.push("### Cache");
			lines.push("");
			lines.push(
				...markdownFence(safeStringifyForMarkdown(stage.cache), "json"),
			);
		}
		lines.push("");
	}

	return `${redactMarkdownSecrets(lines.join("\n")).trimEnd()}\n`;
}

function applyMetricsForStage(
	metrics: RecordedTrajectoryMetrics,
	stage: RecordedStage,
): void {
	metrics.totalLatencyMs += Number.isFinite(stage.latencyMs)
		? stage.latencyMs
		: 0;

	if (stage.model?.usage) {
		metrics.totalPromptTokens += stage.model.usage.promptTokens ?? 0;
		metrics.totalCompletionTokens += stage.model.usage.completionTokens ?? 0;
		metrics.totalCacheReadTokens += stage.model.usage.cacheReadInputTokens ?? 0;
		metrics.totalCacheCreationTokens +=
			stage.model.usage.cacheCreationInputTokens ?? 0;
	}
	if (typeof stage.model?.costUsd === "number") {
		metrics.totalCostUsd += stage.model.costUsd;
	}

	if (stage.kind === "planner") metrics.plannerIterations += 1;
	if (stage.kind === "tool") {
		metrics.toolCallsExecuted += 1;
		if (stage.tool && !stage.tool.success) metrics.toolCallFailures += 1;
	}
	if (stage.kind === "toolSearch") metrics.toolSearchCount += 1;
	if (
		stage.kind === "evaluation" &&
		typeof stage.evaluation?.parseError === "string" &&
		stage.evaluation.parseError.trim().length > 0
	) {
		metrics.evaluatorFailures += 1;
	}

	const decision = stage.evaluation?.decision;
	if (decision === "FINISH") {
		metrics.finalDecision = "FINISH";
	} else if (decision) {
		// Track that we're still going. `endTrajectory` will overwrite on error.
		metrics.finalDecision = "CONTINUE";
	}
}

function sanitizeForRecord(
	value: unknown,
	seen = new WeakSet<object>(),
	depth = 0,
): unknown {
	if (depth > 40) {
		return "[MaxDepth]";
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "undefined") {
		return undefined;
	}
	if (typeof value === "function") {
		const fnName = (value as { name?: string }).name;
		return `[Function ${typeof fnName === "string" && fnName.length > 0 ? fnName : "anonymous"}]`;
	}
	if (typeof value === "symbol") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		return value.map((entry) => sanitizeForRecord(entry, seen, depth + 1));
	}
	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			const sanitized = sanitizeForRecord(entry, seen, depth + 1);
			if (sanitized !== undefined) {
				output[key] = sanitized;
			}
		}
		return output;
	}
	return String(value);
}

function cloneForRecord<T>(value: T): T {
	if (typeof structuredClone === "function") {
		try {
			return structuredClone(value);
		} catch {
			return sanitizeForRecord(value) as T;
		}
	}
	return sanitizeForRecord(value) as T;
}

// ---------------------------------------------------------------------------
// Field cap / truncation (M12 — action exec input/output/error capture)
// ---------------------------------------------------------------------------

const DEFAULT_FIELD_CAP_BYTES = 64 * 1024;
const TRUNCATION_SUFFIX = "...[truncated]";

/**
 * Resolve the per-field byte cap for `input` / `output` / `errorText`. The
 * recorder uses this for action-step capture (M12). Override with
 * `MILADY_TRAJECTORY_FIELD_CAP_BYTES`; values below 1KB or non-integer are
 * rejected as invalid and the default is used.
 */
export function resolveTrajectoryFieldCapBytes(): number {
	const raw = process.env.MILADY_TRAJECTORY_FIELD_CAP_BYTES?.trim();
	if (!raw) return DEFAULT_FIELD_CAP_BYTES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1024) {
		return DEFAULT_FIELD_CAP_BYTES;
	}
	return parsed;
}

/**
 * Encode an arbitrary value to a JSON string for trajectory persistence.
 * Strings pass through unchanged; everything else is sanitized (handles
 * Error, Date, bigint, circular refs) and serialized.
 */
export function encodeTrajectoryFieldValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(sanitizeForRecord(value));
	} catch {
		return String(value);
	}
}

/**
 * Truncate `value` to at most `capBytes` UTF-8 bytes. Returns the original
 * string and `null` marker when no truncation is needed, or the truncated
 * preview plus a structured marker when the cap was exceeded.
 *
 * The marker is the caller's responsibility to attach to the stage (see
 * `captureToolStageIO`).
 */
export function applyTrajectoryFieldCap(
	field: RecordedTruncationMarker["field"],
	value: string,
	capBytes: number,
): { value: string; marker: RecordedTruncationMarker | null } {
	const byteLength = Buffer.byteLength(value, "utf8");
	if (byteLength <= capBytes) {
		return { value, marker: null };
	}
	const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
	const sliceBudget = Math.max(0, capBytes - suffixBytes);
	const buffer = Buffer.from(value, "utf8");
	let preview = buffer.subarray(0, sliceBudget).toString("utf8");
	// `toString("utf8")` discards trailing partial code points, but the
	// resulting string can still encode to slightly more bytes than the
	// slice budget after concatenation. Trim defensively until it fits.
	while (
		Buffer.byteLength(preview, "utf8") + suffixBytes > capBytes &&
		preview.length > 0
	) {
		preview = preview.slice(0, -1);
	}
	return {
		value: `${preview}${TRUNCATION_SUFFIX}`,
		marker: {
			field,
			originalBytes: byteLength,
			capBytes,
		},
	};
}

export interface ToolStageIOInput {
	input?: unknown;
	output?: unknown;
	error?: unknown;
	capBytes?: number;
}

export interface ToolStageIOCapture {
	input?: string;
	output?: string;
	errorText?: string;
	truncated?: RecordedTruncationMarker[];
}

/**
 * Encode + cap action input/output/error for a tool stage. The result is
 * suitable for assignment into a `RecordedToolStage`. Fields that are
 * `undefined` after encoding are omitted so the on-disk schema stays
 * minimal for steps that have nothing to capture.
 */
export function captureToolStageIO(args: ToolStageIOInput): ToolStageIOCapture {
	const cap = args.capBytes ?? resolveTrajectoryFieldCapBytes();
	const out: ToolStageIOCapture = {};
	const markers: RecordedTruncationMarker[] = [];

	if (args.input !== undefined) {
		const encoded = encodeTrajectoryFieldValue(args.input);
		const { value, marker } = applyTrajectoryFieldCap("input", encoded, cap);
		out.input = value;
		if (marker) markers.push(marker);
	}
	if (args.output !== undefined) {
		const encoded = encodeTrajectoryFieldValue(args.output);
		const { value, marker } = applyTrajectoryFieldCap("output", encoded, cap);
		out.output = value;
		if (marker) markers.push(marker);
	}
	if (args.error !== undefined) {
		const encoded = encodeTrajectoryFieldValue(args.error);
		const { value, marker } = applyTrajectoryFieldCap("error", encoded, cap);
		out.errorText = value;
		if (marker) markers.push(marker);
	}

	if (markers.length > 0) {
		out.truncated = markers;
	}
	return out;
}

/**
 * Annotate a stage with `costUsd` and `priceTableId` if the model has
 * known pricing and the stage didn't already set it. The `model.modelName`
 * is the lookup key; `model.provider` is used to suppress the
 * missing-model warning for local-tier inference (Ollama, LM Studio,
 * llama.cpp).
 *
 * Recorder hooks call `computeCallCostUsd` themselves when they have the
 * data; this function is the fallback for callers that hand off raw
 * stages. Passing a logger lets the canonical pricing module emit a
 * structured warning when a hosted-provider model has no price entry.
 */
export function annotateStageCost(
	stage: RecordedStage,
	logger?: RecorderLogger,
): void {
	if (!stage.model) return;
	if (typeof stage.model.costUsd === "number") {
		// Caller already attached a cost — only tag the table id so consumers
		// know which snapshot it was computed against.
		if (!stage.model.priceTableId) {
			stage.model.priceTableId = PRICE_TABLE_ID;
		}
		return;
	}
	const cost = computeCallCostUsd(stage.model.modelName, stage.model.usage, {
		provider: stage.model.provider,
		logger,
	});
	stage.model.costUsd = cost;
	stage.model.priceTableId = PRICE_TABLE_ID;
}

// ---------------------------------------------------------------------------
// JsonFileTrajectoryRecorder
// ---------------------------------------------------------------------------

export interface CreateJsonFileRecorderOptions {
	rootDir?: string;
	logger?: RecorderLogger;
	enabled?: boolean;
}

interface MutableTrajectory extends RecordedTrajectory {}

class JsonFileTrajectoryRecorder implements TrajectoryRecorder {
	private readonly rootDir: string;
	private readonly markdownDir: string;
	private readonly logger?: RecorderLogger;
	private readonly enabled: boolean;
	private readonly markdownEnabled: boolean;
	private readonly active = new Map<string, MutableTrajectory>();

	constructor(opts: CreateJsonFileRecorderOptions = {}) {
		this.rootDir = opts.rootDir ?? resolveTrajectoryDir();
		this.markdownDir = resolveTrajectoryMarkdownDir(this.rootDir);
		this.logger = opts.logger;
		this.enabled =
			opts.enabled !== undefined
				? opts.enabled
				: isTrajectoryRecordingEnabled();
		this.markdownEnabled = this.enabled && isTrajectoryMarkdownReviewEnabled();
	}

	startTrajectory(input: StartTrajectoryInput): string {
		const id = safeRandomId("tj");
		if (!this.enabled) {
			return id;
		}

		const trajectory: MutableTrajectory = {
			trajectoryId: id,
			agentId: input.agentId,
			roomId: input.roomId,
			runId: input.runId ?? process.env.MILADY_LIFEOPS_RUN_ID,
			scenarioId: input.scenarioId ?? process.env.MILADY_LIFEOPS_SCENARIO_ID,
			rootMessage: input.rootMessage,
			startedAt: Date.now(),
			status: "running",
			stages: [],
			metrics: {
				totalLatencyMs: 0,
				totalPromptTokens: 0,
				totalCompletionTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheCreationTokens: 0,
				totalCostUsd: 0,
				plannerIterations: 0,
				toolCallsExecuted: 0,
				toolCallFailures: 0,
				toolSearchCount: 0,
				evaluatorFailures: 0,
			},
		};
		this.active.set(id, trajectory);

		// Best-effort initial flush so the file exists even if the run crashes
		// before any stage lands. Errors are logged and swallowed.
		void this.flushTrajectory(trajectory).catch((err) => {
			this.logger?.warn?.(
				{ err: (err as Error).message, trajectoryId: id },
				"[TrajectoryRecorder] initial flush failed",
			);
		});
		return id;
	}

	async recordStage(trajectoryId: string, stage: RecordedStage): Promise<void> {
		if (!this.enabled) return;
		const trajectory = this.active.get(trajectoryId);
		if (!trajectory) {
			this.logger?.warn?.(
				{ trajectoryId },
				"[TrajectoryRecorder] recordStage: trajectory not found (was startTrajectory called?)",
			);
			return;
		}

		const recordedStage = cloneForRecord(stage);
		annotateStageCost(recordedStage, this.logger);
		trajectory.stages.push(recordedStage);
		applyMetricsForStage(trajectory.metrics, recordedStage);

		await this.flushTrajectory(trajectory);
	}

	async endTrajectory(
		trajectoryId: string,
		status: "finished" | "errored",
	): Promise<void> {
		if (!this.enabled) return;
		const trajectory = this.active.get(trajectoryId);
		if (!trajectory) {
			this.logger?.warn?.(
				{ trajectoryId },
				"[TrajectoryRecorder] endTrajectory: trajectory not found",
			);
			return;
		}

		trajectory.status = status;
		trajectory.endedAt = Date.now();
		if (status === "errored" && !trajectory.metrics.finalDecision) {
			trajectory.metrics.finalDecision = "error";
		}

		await this.flushTrajectory(trajectory);
		this.active.delete(trajectoryId);
	}

	async load(trajectoryId: string): Promise<RecordedTrajectory | null> {
		const inMem = this.active.get(trajectoryId);
		if (inMem) return inMem;

		try {
			const files = await this.collectAllFiles();
			const match = files.find((f) => f.id === trajectoryId);
			if (!match) return null;
			const raw = await fs.readFile(match.filePath, "utf8");
			return JSON.parse(raw) as RecordedTrajectory;
		} catch (err) {
			this.logger?.warn?.(
				{ err: (err as Error).message, trajectoryId },
				"[TrajectoryRecorder] load failed",
			);
			return null;
		}
	}

	async list(
		opts: ListTrajectoriesOptions = {},
	): Promise<RecordedTrajectory[]> {
		try {
			const files = await this.collectAllFiles();
			const out: RecordedTrajectory[] = [];
			for (const file of files) {
				try {
					const raw = await fs.readFile(file.filePath, "utf8");
					const trajectory = JSON.parse(raw) as RecordedTrajectory;
					if (opts.agentId && trajectory.agentId !== opts.agentId) continue;
					if (opts.since && trajectory.startedAt < opts.since) continue;
					out.push(trajectory);
				} catch (err) {
					this.logger?.warn?.(
						{ err: (err as Error).message, filePath: file.filePath },
						"[TrajectoryRecorder] list: skipping unreadable trajectory file",
					);
				}
			}
			out.sort((a, b) => b.startedAt - a.startedAt);
			if (opts.limit && out.length > opts.limit) {
				return out.slice(0, opts.limit);
			}
			return out;
		} catch (err) {
			this.logger?.warn?.(
				{ err: (err as Error).message },
				"[TrajectoryRecorder] list failed",
			);
			return [];
		}
	}

	private async flushTrajectory(trajectory: MutableTrajectory): Promise<void> {
		const filePath = path.join(
			this.rootDir,
			trajectory.agentId,
			trajectoryFileName(trajectory.trajectoryId),
		);
		await atomicWriteJson(filePath, trajectory, this.logger);
		if (!this.markdownEnabled) return;
		const markdownPath = path.join(
			this.markdownDir,
			trajectory.agentId,
			`${trajectory.trajectoryId}.md`,
		);
		await atomicWriteText(
			markdownPath,
			renderTrajectoryMarkdown(trajectory),
			this.logger,
		);
	}

	private async collectAllFiles(): Promise<
		Array<{ id: string; filePath: string }>
	> {
		const out: Array<{ id: string; filePath: string }> = [];
		const stack: string[] = [this.rootDir];
		try {
			await fs.access(this.rootDir);
		} catch {
			return out;
		}

		while (stack.length > 0) {
			const dir = stack.pop();
			if (!dir) continue;
			let entries: import("node:fs").Dirent[];
			try {
				entries = (await fs.readdir(dir, {
					withFileTypes: true,
				})) as import("node:fs").Dirent[];
			} catch {
				continue;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(full);
					continue;
				}
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				out.push({
					id: entry.name.replace(/\.json$/, ""),
					filePath: full,
				});
			}
		}

		return out;
	}
}

/**
 * Construct a JSON-file backed `TrajectoryRecorder`. The default rootDir is
 * resolved from `MILADY_TRAJECTORY_DIR` → `MILADY_STATE_DIR/trajectories` →
 * `ELIZA_STATE_DIR/trajectories` → `~/.milady/trajectories`.
 *
 * Pass `enabled: false` to short-circuit every method to a no-op (test
 * fixtures, opt-out at construction time).
 */
export function createJsonFileTrajectoryRecorder(
	opts: CreateJsonFileRecorderOptions = {},
): TrajectoryRecorder {
	return new JsonFileTrajectoryRecorder(opts);
}

// ---------------------------------------------------------------------------
// No-op recorder (used when recording is disabled or no recorder was passed
// into a sub-runtime call). This lets every hook be unconditional.
// ---------------------------------------------------------------------------

const NOOP_RECORDER: TrajectoryRecorder = {
	startTrajectory: () => safeRandomId("tj-noop"),
	recordStage: async () => undefined,
	endTrajectory: async () => undefined,
	load: async () => null,
	list: async () => [],
};

/**
 * Get a no-op recorder. Useful when wiring a runtime path that may or may
 * not have a recorder attached.
 */
export function getNoopTrajectoryRecorder(): TrajectoryRecorder {
	return NOOP_RECORDER;
}
