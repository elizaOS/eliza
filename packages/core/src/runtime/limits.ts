/**
 * Bounds and guard functions for the planner chaining loop: the
 * `ChainingLoopConfig` limit contract (max tool calls, repeated-failure and
 * cumulative-token budgets, compaction thresholds), the typed
 * `TrajectoryLimitExceeded` error, and the assert/count helpers that stop a
 * runaway or stuck planner from burning a turn.
 */
import type { ActionFailureProvenance } from "../types/action-failure";
import { toWellFormedUnicode, truncateWellFormed } from "../utils/well-formed";

export interface ChainingLoopConfig {
	/** Maximum tool calls executed during one planner loop. */
	maxToolCalls: number;
	/** Maximum repeated failures for the same tool/error signature. */
	maxRepeatedFailures: number;
	/** Maximum planner misses when Stage 1 requires a tool before failing fast. */
	maxRequiredToolMisses: number;
	/** Maximum planner retries after it calls only tools unavailable this turn. */
	maxUnavailableToolCallRetries: number;
	/** Maximum terminal-only planner turns that still evaluate to CONTINUE. */
	maxTerminalOnlyContinuations: number;
	/**
	 * Maximum planner iterations whose only non-terminal tool calls exactly
	 * repeat a call that already SUCCEEDED this turn (same tool name + args).
	 * Re-running an identical successful call cannot yield new information; a
	 * model that keeps doing so is stuck (observed live: gpt-5.5 re-issuing the
	 * same WEB_FETCH 17× until `maxTrajectoryPromptTokens` aborted the turn with
	 * a generic apology). Once exceeded, the loop stops re-executing and forces
	 * one terminal synthesis call so the user gets the answer already gathered.
	 * This is the success-side analog of `maxRepeatedFailures`.
	 */
	maxRepeatedToolCalls: number;
	/**
	 * Maximum successful memory/knowledge-recall search rounds per turn
	 * (MEMORY_SEARCH-family: `*_SEARCH` recall tools, SEARCH_KNOWLEDGE, and the
	 * MEMORY umbrella with a search op). The existing redundant-call breaker
	 * only catches byte-identical repeats; a model reformulating the SAME recall
	 * ("alexis gym signup" → "gym signup alexis" → "alexis gym") slips past it
	 * and every extra round costs a full planner prompt (live sol-dev
	 * 2026-08-17: 3-5 MEMORY_SEARCH rounds per turn drove 30-117s tails). Once
	 * the budget is spent, further search-class calls are skipped with an
	 * instruction to answer from the results already gathered — the results ARE
	 * in the trajectory, so no information is lost. Near-duplicate queries
	 * (same tool, same normalized query tokens) are additionally skipped
	 * regardless of remaining budget. Failed calls remain governed by the
	 * repeated-failure guard so this budget does not suppress a corrected retry.
	 */
	maxMemorySearchRounds: number;
	/** Estimated model context window for compaction decisions. */
	contextWindowTokens: number;
	/**
	 * Optional model id used to resolve the *actual* per-model context
	 * window (and a 20%-of-window reserve floor) at compaction-budget time
	 * via `lookupModelContextWindow`. When set and the lookup hits, this
	 * wins over `contextWindowTokens` — letting tight-context models
	 * (Cerebras llama3.1-8b at 32k, compact local tiers at 64k, gemma-4-31b at 131k) get
	 * a budget sized to their real ceiling instead of the 128k default.
	 *
	 * Optional and additive: when unset, the existing
	 * `contextWindowTokens` + `compactionReserveTokens` pair is used as
	 * before.
	 */
	contextWindowModelName?: string;
	/** Token reserve kept free for model output and provider overhead. */
	compactionReserveTokens: number;
	/**
	 * @internal Tracks whether `compactionReserveTokens` came from the caller
	 * rather than `DEFAULT_CHAINING_LOOP_CONFIG`. This lets the planner apply
	 * the per-model derived reserve when only `contextWindowModelName` is set,
	 * while still preserving explicit reserve overrides.
	 */
	compactionReserveTokensExplicit?: boolean;
	/** Whether the planner may summarize old trajectory steps before replanning. */
	compactionEnabled: boolean;
	/** Number of newest completed tool steps kept verbatim after compaction. */
	compactionKeepSteps: number;
	/**
	 * Maximum cumulative prompt tokens summed across every planner-stage
	 * model call within a single user turn. Once exceeded the loop aborts
	 * with `TrajectoryLimitExceeded({kind:"trajectory_token_budget"})`,
	 * bounding the worst-case cost of a runaway replan.
	 *
	 * The count tracks **gross prompt tokens** (cached + non-cached + cache
	 * write) — the same number the provider would meter you on; cache reads
	 * count too because they still consume context and walltime even if the
	 * dollar cost is discounted.
	 *
	 * Set to `Number.POSITIVE_INFINITY` to disable the guard. The default
	 * of 1.5M tokens is calibrated against observed trajectories:
	 *   - well-formed single-turn answers: 50k–250k cumulative tokens.
	 *   - normal multi-step tool chains: 400k–800k cumulative.
	 *   - the runaway replan that motivated this guard: 2.2M cumulative
	 *     (13 planner iterations growing monotonically until the model's
	 *     per-call window overflowed).
	 *
	 * 1.5M sits comfortably above legitimate traffic and well below the
	 * runaway level — a turn that exceeds it is almost certainly stuck.
	 */
	maxTrajectoryPromptTokens: number;
	/**
	 * When set, caps each tool-result string rendered into the planner
	 * input to this many characters (head + `[N chars truncated]` marker
	 * + tail). The trajectory itself is unchanged — only the wire-shape
	 * messages are truncated.
	 *
	 * Why this exists: the compactor keeps the four newest steps
	 * verbatim by default (`compactionKeepSteps: 4`). A single
	 * pathologically-large tool result inside the kept window — a 30 KB
	 * shell dump, a multi-thousand-line file read, a full grep — can
	 * blow the model's per-call context budget single-handedly, even
	 * after compaction has done its job. This cap protects against that
	 * single-step pathology without touching the trajectory's
	 * archival/replay fidelity.
	 *
	 * Default: undefined (no cap) — the planner path is unchanged. The
	 * evaluator applies `DEFAULT_MAX_KEPT_STEP_CHARS` directly (see
	 * evaluator.ts) so the fix stays out of the planner loop. Recommended
	 * for tight-context models: ~8000 (one tool result still gets
	 * roughly two pages of head + a half page of tail context).
	 */
	compactionMaxKeptStepChars?: number;
}

/** Default per-tool-result render cap (chars). ~8.6k tokens at 3.5 chars/token:
 * large enough to keep head+tail structure of any real result, small enough that
 * no single step can approach the 128k default window (live incident: one 5MB
 * grep result rendered verbatim = 2.28M tokens vs cerebras's 131,072 limit). */
export const DEFAULT_MAX_KEPT_STEP_CHARS = 30_000;

export const DEFAULT_CHAINING_LOOP_CONFIG: ChainingLoopConfig = {
	maxToolCalls: 16,
	maxRepeatedFailures: 2,
	maxRequiredToolMisses: 3,
	maxUnavailableToolCallRetries: 3,
	maxTerminalOnlyContinuations: 2,
	maxRepeatedToolCalls: 2,
	maxMemorySearchRounds: 2,
	contextWindowTokens: 128_000,
	compactionReserveTokens: 10_000,
	compactionEnabled: true,
	compactionKeepSteps: 4,
	maxTrajectoryPromptTokens: 1_500_000,
};

export type TrajectoryLimitKind =
	| "tool_calls"
	| "repeated_failures"
	| "required_tool_misses"
	| "unavailable_tool_calls"
	| "terminal_only_continuations"
	| "trajectory_token_budget";

export class TrajectoryLimitExceeded extends Error {
	readonly kind: TrajectoryLimitKind;
	readonly max: number;
	readonly observed: number;
	/**
	 * Present only for `repeated_failures`, where the underlying tool failure
	 * has a structured cause worth surfacing. Consumed by
	 * `classifyStructuredFailureCause` in `services/message/fallback-reply.ts`.
	 */
	readonly failureProvenance?: ActionFailureProvenance;

	constructor(params: {
		kind: TrajectoryLimitKind;
		max: number;
		observed: number;
		message?: string;
		failureProvenance?: ActionFailureProvenance;
	}) {
		super(
			params.message ??
				`Trajectory limit exceeded: ${params.kind} (${params.observed}/${params.max})`,
		);
		this.name = "TrajectoryLimitExceeded";
		this.kind = params.kind;
		this.max = params.max;
		this.observed = params.observed;
		if (params.failureProvenance !== undefined) {
			this.failureProvenance = params.failureProvenance;
		}
	}
}

export function mergeChainingLoopConfig(
	config?: Partial<ChainingLoopConfig>,
): ChainingLoopConfig {
	return {
		...DEFAULT_CHAINING_LOOP_CONFIG,
		...config,
		compactionReserveTokensExplicit:
			config?.compactionReserveTokens !== undefined ||
			config?.compactionReserveTokensExplicit === true,
	};
}

export function assertTrajectoryLimit(params: {
	kind: TrajectoryLimitKind;
	max: number;
	observed: number;
}): void {
	if (params.observed > params.max) {
		throw new TrajectoryLimitExceeded(params);
	}
}

export interface FailureLike {
	toolName?: string;
	error?: unknown;
	success?: boolean;
	repeatKey?: string;
	/**
	 * Structured cause carried up from the settled `ActionResult`. When a
	 * repeated-failure abort is raised, this is what lets the fallback reply
	 * say *why* the tool kept failing (a dead datastore, say) rather than
	 * reporting generic planner exhaustion.
	 */
	failureProvenance?: ActionFailureProvenance;
}

export function getFailureSignature(failure: FailureLike): string | null {
	if (failure.success !== false && failure.error == null) {
		return null;
	}

	const toolName = failure.toolName?.trim() || "unknown_tool";
	const rawError =
		failure.error instanceof Error
			? failure.error.message
			: typeof failure.error === "string"
				? failure.error
				: failure.error == null
					? "failed"
					: JSON.stringify(failure.error);
	// Normalize before truncating: toWellFormedUnicode repairs lone surrogates
	// already present in the raw provider error, and truncateWellFormed keeps
	// the 240-char cut off a pair boundary. Truncation alone fixes only the cut.
	const normalizedError = truncateWellFormed(
		toWellFormedUnicode(rawError.trim().replace(/\s+/g, " ")),
		240,
	);
	return `${toolName}:${normalizedError}`;
}

export function countRepeatedFailures(
	failures: readonly FailureLike[],
	latestFailure: FailureLike,
): number {
	const latestSignature = getFailureComparisonKey(latestFailure);
	if (!latestSignature) {
		return 0;
	}

	let count = 0;
	for (const failure of failures) {
		if (getFailureComparisonKey(failure) === latestSignature) {
			count += 1;
		}
	}
	return count;
}

function getFailureComparisonKey(failure: FailureLike): string | null {
	const signature = getFailureSignature(failure);
	if (!signature) return null;
	const repeatKey = failure.repeatKey?.trim();
	return repeatKey
		? `${signature}:${truncateWellFormed(toWellFormedUnicode(repeatKey), 240)}`
		: signature;
}

export function assertRepeatedFailureLimit(params: {
	failures: readonly FailureLike[];
	latestFailure: FailureLike;
	maxRepeatedFailures: number;
}): void {
	const observed = countRepeatedFailures(params.failures, params.latestFailure);
	if (observed > params.maxRepeatedFailures) {
		throw new TrajectoryLimitExceeded({
			kind: "repeated_failures",
			max: params.maxRepeatedFailures,
			observed,
			message: `Repeated tool failure limit exceeded for ${getFailureSignature(
				params.latestFailure,
			)}`,
			failureProvenance: params.latestFailure.failureProvenance,
		});
	}
}
