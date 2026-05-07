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
import type { EvaluationResult } from "../types/components";
import type { ChatMessage, ToolChoice } from "../types/model";
import { computeCallCostUsd } from "./cost-table";

// ---------------------------------------------------------------------------
// Schema (mirrors PLAN.md §18.1)
// ---------------------------------------------------------------------------

export type RecordedStageKind =
	| "messageHandler"
	| "planner"
	| "tool"
	| "evaluation"
	| "subPlanner"
	| "compaction";

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
	prompt: string;
	messages?: ChatMessage[] | unknown[];
	tools?: unknown;
	toolChoice?: ToolChoice | unknown;
	providerOptions?: unknown;
	response: string;
	toolCalls?: RecordedToolCall[];
	usage?: RecordedUsage;
	finishReason?: string;
	costUsd?: number;
}

export interface RecordedToolStage {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	success: boolean;
	durationMs: number;
}

export interface RecordedEvaluationStage extends EvaluationResult {
	[key: string]: unknown;
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
	parentStageId?: string;
	startedAt: number;
	endedAt: number;
	latencyMs: number;
	model?: RecordedModelCall;
	tool?: RecordedToolStage;
	evaluation?: RecordedEvaluationStage;
	cache?: RecordedCacheStage;
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
	evaluatorFailures: number;
	finalDecision?: "FINISH" | "CONTINUE" | "max_iterations" | "error";
}

export interface RecordedTrajectory {
	trajectoryId: string;
	agentId: string;
	roomId?: string;
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
			lines.push("");
			lines.push("### Prompt");
			lines.push("");
			lines.push(...markdownFence(stage.model.prompt));
			lines.push("");
			lines.push("### Response");
			lines.push("");
			lines.push(...markdownFence(stage.model.response));
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
	if (stage.kind === "evaluation" && stage.evaluation?.success === false) {
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

function cloneForRecord<T>(value: T): T {
	if (typeof structuredClone === "function") {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Annotate a stage with `costUsd` if the model has known pricing and the
 * stage didn't already set it. The `model.modelName` is the lookup key.
 *
 * Recorder hooks call `computeCallCostUsd` themselves when they have the
 * data; this function is a fallback for callers that hand off raw stages.
 */
export function annotateStageCost(stage: RecordedStage): void {
	if (!stage.model) return;
	if (typeof stage.model.costUsd === "number") return;
	const cost = computeCallCostUsd(stage.model.modelName, stage.model.usage);
	if (cost > 0) {
		stage.model.costUsd = cost;
	}
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
		annotateStageCost(recordedStage);
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
