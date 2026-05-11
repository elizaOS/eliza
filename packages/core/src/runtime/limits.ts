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
	/** Token reserve kept free for model output and provider overhead. */
	compactionReserveTokens: number;
	/** Whether the planner may summarize old trajectory steps before replanning. */
	compactionEnabled: boolean;
	/** Number of newest completed tool steps kept verbatim after compaction. */
	compactionKeepSteps: number;
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
};

export type TrajectoryLimitKind =
	| "tool_calls"
	| "repeated_failures"
	| "required_tool_misses"
	| "terminal_only_continuations";

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
