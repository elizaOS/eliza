/** Generic trajectory contracts and value projection. File persistence is assistant-owned. */
import { ElizaError } from "../errors";
import {
	projectCompleteToolArgsForModel,
	projectCompleteToolValueForModel,
	type ToolDiagnosticTextRedactor,
} from "../security/tool-diagnostics";
import type { EvaluationResult } from "../types/components";
import type { ChatMessage, ToolChoice } from "../types/model";
import { toWellFormedUnicode } from "../utils/well-formed";
import { resolveTrajectoryGate } from "./trajectory-gate";
import {
	canonicalPromptForModelCall,
	omitUnvalidatedProviderSpans,
	type TrajectoryProviderAttribution,
} from "./trajectory-provider-attribution";
import type { RecordedStageKind } from "./trajectory-stage-kind";

export {
	RECORDED_STAGE_KINDS,
	type RecordedStageKind,
} from "./trajectory-stage-kind";

// ---------------------------------------------------------------------------
// Schema (mirrors PLAN.md §18.1)
// ---------------------------------------------------------------------------

export interface RecordedUsage {
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
}

export interface RecordedToolCall {
	id?: string;
	name?: string;
	args?: Record<string, unknown>;
}

export interface RecordedModelCall {
	modelType: string;
	modelName?: string;
	provider?: string;
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
	 * warning log when a hosted-provider model has no price entry and omits the
	 * field so unknown spend cannot be mistaken for free inference.
	 */
	costUsd?: number;
	/**
	 * Snapshot identifier of the price table used to compute `costUsd`.
	 * Closes M40 / W1-X1. Bumped whenever any rate in the canonical
	 * pricing table at `features/trajectories/pricing.ts` changes.
	 */
	priceTableId?: string;
	/** Provider order selected for the composeState call that fed this model input. */
	providerOrder?: string[];
	/**
	 * Hash-first provider contributions. No provider text is duplicated: when
	 * `spanStart`/`spanEnd` are present they index into the flattened form of the
	 * persisted `messages` (`flattenTrajectoryMessages(messages)`), derived once
	 * at read time — consumers slice that to verify exact provenance rather than a
	 * second stored copy of the prompt.
	 */
	providerAttributions?: TrajectoryProviderAttribution[];
}

/** Legacy marker retained so historical trajectory rows remain readable. */
export interface RecordedTruncationMarker {
	field: "input" | "output" | "error" | "args" | "result";
	originalBytes: number;
	capBytes: number;
}

export interface RecordedToolStage {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	success: boolean;
	durationMs: number;
	/**
	 * The model-facing tool description the planner was shown for this action —
	 * i.e. the exposed `ToolDefinition.description`, which is the action's
	 * `routingHint` (its "use when / do NOT use when" guidance) prepended to the
	 * compressed description. Captured so a trajectory reviewer or training
	 * pipeline can see WHAT the action was for — and judge whether the planner
	 * had enough to disambiguate it — directly from the execution record, without
	 * cross-referencing the preceding planner stage's `model.tools`.
	 */
	description?: string;
	error?: string;
	/** Complete action-handler input, encoded as JSON when possible. */
	input?: string;
	/**
	 * Captured action-handler output (the full result the action returned,
	 * not just the planner-shaped summary).
	 */
	output?: string;
	/**
	 * Captured action-handler error text.
	 * Mirrors `error` for free-text reads; structured `error` above is kept
	 * for backwards compatibility with existing readers.
	 */
	errorText?: string;
	/**
	 * Legacy loss markers read from historical rows; new captures omit them.
	 */
	truncated?: RecordedTruncationMarker[];
}

/**
 * Per-stage retrieval entry captured when measurement mode is on. One
 * entry per (action, stage) pair, recorded BEFORE reciprocal-rank-fusion
 * so the funnel analyzer can see what each individual stage produced.
 */
export interface RecordedRetrievalStageEntry {
	actionName: string;
	score: number;
	rank: number;
}

/**
 * Per-stage retrieval scores captured under `ELIZA_RETRIEVAL_MEASUREMENT=1`.
 * Default `undefined` — no perf cost in production unless the env var is
 * explicitly enabled.
 */
export interface RecordedRetrievalPerStageScores {
	exact: RecordedRetrievalStageEntry[];
	regex: RecordedRetrievalStageEntry[];
	keyword: RecordedRetrievalStageEntry[];
	bm25: RecordedRetrievalStageEntry[];
	embedding: RecordedRetrievalStageEntry[];
	contextMatch: RecordedRetrievalStageEntry[];
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
	/**
	 * Per-stage retrieval funnel. Populated only when the retrieval call
	 * ran with measurement mode on (`ELIZA_RETRIEVAL_MEASUREMENT=1`).
	 */
	perStageScores?: RecordedRetrievalPerStageScores;
	/**
	 * Top-K fused (RRF) results. Mirrors `results` but exposes the raw
	 * `rrfScore` field directly so downstream analyzers don't need to
	 * unify the two shapes. Populated only under measurement mode.
	 */
	fusedTopK?: Array<{ actionName: string; rrfScore: number; rank: number }>;
	/**
	 * Actions the planner ultimately invoked this turn. Recorded by the
	 * caller after the planner loop resolves — the retrieval call itself
	 * does not know which results were selected.
	 */
	selectedActions?: string[];
	/**
	 * Ground-truth actions for this scenario, when available. Sourced from
	 * the scenario manifest by the benchmark harness; never inferred from
	 * the trajectory.
	 */
	correctActions?: string[];
}

export interface RecordedEvaluationStage extends EvaluationResult {
	protocolFailure?: true;
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
	/** Mirrors the gated evaluation stage: a deterministic gate answered without a model call. */
	llmCallSkipped?: boolean;
	reason?: string;
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
	totalReasoningTokens?: number;
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
	// Correlation header (#13775) joining this file trajectory to the DB row and
	// any orchestrator task. `traceId` is minted at the root turn or inherited
	// from a spawning parent; the rest are set when the recorder runs inside a
	// sub-agent. Optional because pre-rollout trajectories carry none.
	traceId?: string;
	taskId?: string;
	sessionId?: string;
	parentStepId?: string;
	codingActionProfile?: {
		kind: "pi";
		includeWorktree: boolean;
	};
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
	// Correlation header (#13775). `traceId` is passed from the root turn
	// (message.ts); when absent the recorder falls back to env, then mints one.
	// The rest are inherited from a spawning parent's env when this recorder
	// runs inside a sub-agent.
	traceId?: string;
	taskId?: string;
	sessionId?: string;
	parentStepId?: string;
	/** Normalized trusted coding policy selected for this recorded turn. */
	codingActionProfile?: {
		kind: "pi";
		includeWorktree: boolean;
	};
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

export interface RecorderLogger {
	warn?: (context: unknown, message?: string) => void;
	debug?: (context: unknown, message?: string) => void;
	error?: (context: unknown, message?: string) => void;
}

/**
 * Whether the file recorder is enabled. Delegates to the single gate resolver
 * (trajectory-gate.ts) so the file recorder and the DB logger can no longer
 * disagree (#13775). Prod is now opt-in and test is off — the prior
 * always-on-unless-`=0` default is retired in favor of the SOC2 O-5 policy.
 */
export function isTrajectoryRecordingEnabled(): boolean {
	return resolveTrajectoryGate().enabled;
}

const RECORD_SANITIZE_MAX_DEPTH = 40;

function normalizeRecordString(value: string): string {
	return toWellFormedUnicode(value);
}

function sanitizeForRecord(
	value: unknown,
	seen = new WeakSet<object>(),
	depth = 0,
): unknown {
	if (depth > RECORD_SANITIZE_MAX_DEPTH) {
		return "[MaxDepth]";
	}
	if (value === null) return null;
	if (typeof value === "string") return normalizeRecordString(value);
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value === undefined) {
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
	if (value instanceof RegExp) {
		return value.toString();
	}
	if (value instanceof ArrayBuffer) {
		return { type: "ArrayBuffer", byteLength: value.byteLength };
	}
	if (ArrayBuffer.isView(value)) {
		return {
			type: value.constructor.name || "ArrayBufferView",
			byteLength: value.byteLength,
		};
	}
	if (value instanceof Map) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const output: Record<string, unknown> = {};
		for (const [key, entry] of value.entries()) {
			const sanitized = sanitizeForRecord(entry, seen, depth + 1);
			if (sanitized !== undefined) {
				output[String(key)] = sanitized;
			}
		}
		seen.delete(value);
		return output;
	}
	if (value instanceof Set) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const output: unknown[] = [];
		for (const entry of value.values()) {
			output.push(sanitizeForRecord(entry, seen, depth + 1) ?? null);
		}
		seen.delete(value);
		return output;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const output: unknown[] = [];
		const length = value.length;
		for (let i = 0; i < length; i++) {
			output.push(sanitizeForRecord(value[i], seen, depth + 1) ?? null);
		}
		seen.delete(value);
		return output;
	}
	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			seen.delete(value);
			const prototype = Object.getPrototypeOf(value);
			if (prototype === Object.prototype || prototype === null) {
				// Plain empty objects must round-trip as {}, not "[object Object]".
				// Keep URL-like/custom empty-entry objects on the string fallback
				// path so useful toString() values are not erased.
				return {};
			}
			return String(value);
		}
		const output: Record<string, unknown> = {};
		for (const [key, entry] of entries) {
			const sanitized = sanitizeForRecord(entry, seen, depth + 1);
			if (sanitized !== undefined) {
				output[key] = sanitized;
			}
		}
		seen.delete(value);
		return output;
	}
	return String(value);
}

export function cloneTrajectoryValue<T>(value: T): T {
	return sanitizeForRecord(value) as T;
}

/**
 * Encode an arbitrary value to a JSON string for trajectory persistence.
 * Strings pass through unchanged; everything else is sanitized (handles
 * Error, Date, bigint, circular refs) and serialized.
 */
export function encodeTrajectoryFieldValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	const serialized = JSON.stringify(sanitizeForRecord(value));
	if (serialized === undefined) {
		throw new ElizaError("Trajectory field is not JSON-serializable", {
			code: "TRAJECTORY_FIELD_INVALID",
		});
	}
	return serialized;
}

export interface ToolStageIOInput {
	input?: unknown;
	output?: unknown;
	error?: unknown;
}

export interface ToolStageIOCapture {
	input?: string;
	output?: string;
	errorText?: string;
}

/**
 * Encode complete action input/output/error for a tool stage. The result is
 * suitable for assignment into a `RecordedToolStage`. Fields that are
 * `undefined` after encoding are omitted so the on-disk schema stays
 * minimal for steps that have nothing to capture.
 */
export function captureToolStageIO(args: ToolStageIOInput): ToolStageIOCapture {
	const out: ToolStageIOCapture = {};

	if (args.input !== undefined) {
		out.input = toWellFormedUnicode(encodeTrajectoryFieldValue(args.input));
	}
	if (args.output !== undefined) {
		out.output = toWellFormedUnicode(encodeTrajectoryFieldValue(args.output));
	}
	if (args.error !== undefined) {
		out.errorText = toWellFormedUnicode(encodeTrajectoryFieldValue(args.error));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Skill invocation I/O capture (W1-T5 / M13)
//
// Mirrors `captureToolStageIO` at the skill (USE_SKILL) seam.
// ---------------------------------------------------------------------------

export interface SkillInvocationIOInput {
	args?: unknown;
	result?: unknown;
}

export interface SkillInvocationIOCapture {
	args?: string;
	result?: string;
}

/**
 * Encode complete skill invocation args/result for a per-skill trajectory
 * record. Fields that are `undefined` after encoding are omitted so the
 * persisted shape stays minimal.
 */
export function captureSkillInvocationIO(
	input: SkillInvocationIOInput,
): SkillInvocationIOCapture {
	const out: SkillInvocationIOCapture = {};

	if (input.args !== undefined) {
		out.args = toWellFormedUnicode(encodeTrajectoryFieldValue(input.args));
	}
	if (input.result !== undefined) {
		out.result = toWellFormedUnicode(encodeTrajectoryFieldValue(input.result));
	}
	return out;
}

/**
 * Final-persistence projection of tool-call diagnostics for one recorded
 * stage. Every recordStage caller (planner, sub-planner, evaluator, message
 * handler, and any future generic caller) is protected here rather than at
 * its own call site: tool arguments, tool result/error, captured tool I/O,
 * and model-stage tool-call arguments are projected through the composed
 * redaction before the stage reaches disk. Mutates the (already cloned) stage
 * in place. Model prompt/message text is projected as well; when message bytes
 * change, provider-attribution offsets are dropped through the canonical
 * fallback so they never index text different from the persisted messages.
 */
export function projectRecordedStageToolDiagnostics(
	stage: RecordedStage,
	redactText: ToolDiagnosticTextRedactor,
): void {
	if (stage.tool) {
		stage.tool.args =
			projectCompleteToolArgsForModel(stage.tool.args, redactText) ?? {};
		stage.tool.result = projectCompleteToolValueForModel(
			stage.tool.result,
			redactText,
		);
		if (typeof stage.tool.error === "string") {
			stage.tool.error = redactText(stage.tool.error);
		}
		if (stage.tool.input !== undefined) {
			stage.tool.input = redactText(stage.tool.input);
		}
		if (stage.tool.output !== undefined) {
			stage.tool.output = redactText(stage.tool.output);
		}
		if (stage.tool.errorText !== undefined) {
			stage.tool.errorText = redactText(stage.tool.errorText);
		}
	}
	if (stage.model) {
		const attributionInputBefore = canonicalPromptForModelCall({
			messages: stage.model.messages,
			prompt: stage.model.prompt,
		});
		if (stage.model.toolCalls?.length) {
			stage.model.toolCalls = stage.model.toolCalls.map((toolCall) => ({
				...toolCall,
				...(toolCall.args !== undefined
					? { args: projectCompleteToolArgsForModel(toolCall.args, redactText) }
					: {}),
			}));
		}
		// Prompt/messages/response carry rendered tool-call arguments and tool
		// output (assistant tool-call turns, tool-result turns, evaluator
		// trajectory renderings), so the persisted copies are projected too.
		// When the messages text changes, provider-attribution span offsets are
		// no longer provable against the persisted prompt — drop the offsets via
		// the canonical fallback and keep contribution identity.
		if (typeof stage.model.prompt === "string") {
			const projectedPrompt = redactText(stage.model.prompt);
			if (projectedPrompt !== stage.model.prompt) {
				stage.model.prompt = projectedPrompt;
			}
		}
		stage.model.response = redactText(stage.model.response);
		if (Array.isArray(stage.model.messages)) {
			const projectedMessages = projectCompleteToolValueForModel(
				stage.model.messages,
				redactText,
			) as RecordedModelCall["messages"];
			if (projectedMessages !== stage.model.messages) {
				stage.model.messages = projectedMessages;
			}
		}
		const attributionInputAfter = canonicalPromptForModelCall({
			messages: stage.model.messages,
			prompt: stage.model.prompt,
		});
		if (
			attributionInputAfter !== attributionInputBefore &&
			stage.model.providerAttributions?.length
		) {
			stage.model.providerAttributions = omitUnvalidatedProviderSpans(
				stage.model.providerAttributions,
			);
		}
	}
	if (stage.evaluation) {
		stage.evaluation = projectCompleteToolValueForModel(
			stage.evaluation,
			redactText,
		) as RecordedEvaluationStage;
	}
}

// ---------------------------------------------------------------------------
// Trajectory finalization guard
// ---------------------------------------------------------------------------

export interface FinalizeTrajectoryRecordingOptions {
	recorder: TrajectoryRecorder;
	trajectoryId: string;
	status: "finished" | "errored";
	logger?: RecorderLogger;
	reportError?: (
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	) => void;
}

/**
 * Lifecycle guard: every started trajectory must reach a terminal status.
 *
 * Writes the terminal status without depending on optional background work.
 * Callers record already-settled stages before entering this boundary; a
 * diagnostic task may never keep a completed turn visibly `running`.
 */
export async function finalizeTrajectoryRecording(
	opts: FinalizeTrajectoryRecordingOptions,
): Promise<void> {
	try {
		await opts.recorder.endTrajectory(opts.trajectoryId, opts.status);
	} catch (err) {
		// error-policy:J7 Finalization is diagnostic and cannot replace the turn;
		// it must still surface the trajectory left unterminated.
		opts.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: opts.trajectoryId },
			"[TrajectoryRecorder] endTrajectory failed",
		);
		opts.reportError?.("TrajectoryRecorder.finalize", err, {
			trajectoryId: opts.trajectoryId,
			status: opts.status,
		});
	}
}
