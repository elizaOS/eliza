/**
 * Aggregates recorded token and cost evidence per trace. Missing evidence remains distinct
 * from measured zero.
 */

import type {
	RecordedTrajectory,
	RecordedTrajectoryMetrics,
} from "./trajectory-recorder";

/** The token/cost totals for one trajectory, or a group of them. */
export interface TrajectoryUsageTotals {
	promptTokens: number;
	completionTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/** Sum of per-trajectory reasoning tokens (thinking/chain-of-thought spend),
	 * mirroring `cacheCreationTokens`. Reported separately from
	 * `totalTokens` because reasoning tokens are billed independently and
	 * must be attributable. */
	reasoningTokens: number;
	/** prompt + completion (cache tokens reported separately, mirroring the
	 * orchestrator's `TaskUsageSummary.totalTokens` convention). */
	totalTokens: number;
	costUsd: number;
	/** How many trajectory files contributed to these totals. */
	trajectoryCount: number;
}

/**
 * Per-trace buckets and grand totals. Records without traceId form their own trajectory
 * bucket.
 */
export interface TrajectoryUsageRollup extends TrajectoryUsageTotals {
	byTrace: Array<{ traceId: string } & TrajectoryUsageTotals>;
}

function emptyTotals(): TrajectoryUsageTotals {
	return {
		promptTokens: 0,
		completionTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		trajectoryCount: 0,
	};
}

/** A truncated or hand-edited trajectory file may carry a NaN/undefined
 * metric, which must not poison the roll-up into NaN. */
function finiteOrZero(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Accumulate one trajectory's metrics into a totals bucket, in place. */
function addMetrics(
	into: TrajectoryUsageTotals,
	metrics: RecordedTrajectoryMetrics,
): void {
	const promptTokens = finiteOrZero(metrics.totalPromptTokens);
	const completionTokens = finiteOrZero(metrics.totalCompletionTokens);
	into.promptTokens += promptTokens;
	into.completionTokens += completionTokens;
	into.cacheReadTokens += finiteOrZero(metrics.totalCacheReadTokens);
	into.cacheCreationTokens += finiteOrZero(metrics.totalCacheCreationTokens);
	into.reasoningTokens += finiteOrZero(metrics.totalReasoningTokens);
	into.costUsd += finiteOrZero(metrics.totalCostUsd);
	into.totalTokens += promptTokens + completionTokens;
	into.trajectoryCount += 1;
}

/**
 * Sum a set of recorded trajectories into a per-trace roll-up plus a grand
 * total. Trajectories are grouped by `traceId` (empty string when unset) so a
 * caller can attribute spend to a single logical run that fanned out across
 * parent + sub-agents. Additive and null-safe: a missing `metrics` block is
 * treated as zero, so a `running`/errored trajectory contributes nothing but
 * its presence.
 */
export function rollUpTrajectoryUsage(
	trajectories: readonly RecordedTrajectory[],
): TrajectoryUsageRollup {
	const buckets = new Map<string, TrajectoryUsageTotals>();
	const grand = emptyTotals();
	for (const trajectory of trajectories) {
		const metrics = trajectory.metrics;
		if (!metrics) continue;
		const key = trajectory.traceId ?? "";
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = emptyTotals();
			buckets.set(key, bucket);
		}
		addMetrics(bucket, metrics);
		addMetrics(grand, metrics);
	}
	// Sort named traces first and records without correlation last.
	const byTrace = [...buckets.entries()]
		.map(([traceId, totals]) => ({ traceId, ...totals }))
		.sort((a, b) => {
			if (a.traceId === "" && b.traceId !== "") return 1;
			if (b.traceId === "" && a.traceId !== "") return -1;
			return a.traceId.localeCompare(b.traceId);
		});
	return { ...grand, byTrace };
}
