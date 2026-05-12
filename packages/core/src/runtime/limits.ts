export interface ChainingLoopConfig {
	/** Maximum tool calls executed during one planner loop. */
	maxToolCalls: number;
	/** Maximum repeated failures for the same tool/error signature. */
	maxRepeatedFailures: number;
	/** Maximum planner misses when Stage 1 requires a tool before failing fast. */
	maxRequiredToolMisses: number;
	/** Maximum terminal-only planner turns that still evaluate to CONTINUE. */
	maxTerminalOnlyContinuations: number;
	/** Estimated model context window for compaction decisions. */
	contextWindowTokens: number;
	/**
	 * Optional model id used to resolve the *actual* per-model context
	 * window (and a 20%-of-window reserve floor) at compaction-budget time
	 * via `lookupModelContextWindow`. When set and the lookup hits, this
	 * wins over `contextWindowTokens` — letting tight-context models
	 * (Cerebras llama3.1-8b at 32k, qwen at 64k, gpt-oss-120b at 131k) get
	 * a budget sized to their real ceiling instead of the 128k default.
	 *
	 * Optional and additive: when unset, the existing
	 * `contextWindowTokens` + `compactionReserveTokens` pair is used as
	 * before.
	 */
	contextWindowModelName?: string;
	/** Token reserve kept free for model output and provider overhead. */
	compactionReserveTokens: number;
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
	 * Default: undefined (no cap — exact pre-PR behavior). Recommended
	 * for tight-context models: ~8000 (one tool result still gets
	 * roughly two pages of head + a half page of tail context).
	 */
	compactionMaxKeptStepChars?: number;
}

export const DEFAULT_CHAINING_LOOP_CONFIG: ChainingLoopConfig = {
	maxToolCalls: 16,
	maxRepeatedFailures: 2,
	maxRequiredToolMisses: 3,
	maxTerminalOnlyContinuations: 2,
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
	| "terminal_only_continuations"
	| "trajectory_token_budget";

export class TrajectoryLimitExceeded extends Error {
	readonly kind: TrajectoryLimitKind;
	readonly max: number;
	readonly observed: number;

	constructor(params: {
		kind: TrajectoryLimitKind;
		max: number;
		observed: number;
		message?: string;
	}) {
		super(
			params.message ??
				`Trajectory limit exceeded: ${params.kind} (${params.observed}/${params.max})`,
		);
		this.name = "TrajectoryLimitExceeded";
		this.kind = params.kind;
		this.max = params.max;
		this.observed = params.observed;
	}
}

export function mergeChainingLoopConfig(
	config?: Partial<ChainingLoopConfig>,
): ChainingLoopConfig {
	return {
		...DEFAULT_CHAINING_LOOP_CONFIG,
		...config,
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
	const normalizedError = rawError.trim().replace(/\s+/g, " ").slice(0, 240);
	return `${toolName}:${normalizedError}`;
}

export function countRepeatedFailures(
	failures: readonly FailureLike[],
	latestFailure: FailureLike,
): number {
	const latestSignature = getFailureSignature(latestFailure);
	if (!latestSignature) {
		return 0;
	}

	let count = 0;
	for (const failure of failures) {
		if (getFailureSignature(failure) === latestSignature) {
			count += 1;
		}
	}
	return count;
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
		});
	}
}
