/**
 * Per-trace token/cost roll-up across recorded trajectories (#13775 item 5).
 *
 * The orchestrator's existing `TaskUsageSummary` sums only the ACP terminal
 * `OrchestratorTaskUsage` frames — the spend the sub-agent's ACP surface
 * reported for the whole session. For an eliza-backend sub-agent those frames
 * are often absent or coarse: the ground-truth inner model prompts/responses
 * (and their per-call cost/tokens) live only in the child's own
 * {@link RecordedTrajectory} files, which #13775 item 2 now attaches to the
 * task as `trajectory` artifacts.
 *
 * This module folds those file-recorder metrics into one roll-up keyed by the
 * shared `traceId` (the correlation envelope minted at the root turn), so a
 * task can finally answer "how much did this whole logical run cost, parent +
 * every sub-agent" from a single number. It is deliberately a SEPARATE surface
 * from `TaskUsageSummary` — the two count different things (ACP-reported
 * session spend vs. file-recorded inner-call spend) and must not be conflated
 * into one double-summed total.
 *
 * Pure and I/O-free: callers read the trajectory JSON (from the artifact
 * `path`) and hand parsed objects in, so this stays unit-testable and reusable
 * off the orchestrator.
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
	/** prompt + completion (cache tokens reported separately, mirroring the
	 * orchestrator's `TaskUsageSummary.totalTokens` convention). */
	totalTokens: number;
	costUsd: number;
	/** How many trajectory files contributed to these totals. */
	trajectoryCount: number;
}

/** Per-trace roll-up: one bucket per `traceId`, plus the grand total. A
 * trajectory with no `traceId` (pre-rollout, or a backend that self-records
 * without inheriting the envelope) is bucketed under the empty-string key so
 * its spend is never silently dropped from the grand total. */
export interface TrajectoryUsageRollup extends TrajectoryUsageTotals {
	byTrace: Array<{ traceId: string } & TrajectoryUsageTotals>;
}

function emptyTotals(): TrajectoryUsageTotals {
	return {
		promptTokens: 0,
		completionTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		trajectoryCount: 0,
	};
}

/** Accumulate one trajectory's metrics into a totals bucket, in place. */
function addMetrics(
	into: TrajectoryUsageTotals,
	metrics: RecordedTrajectoryMetrics,
): void {
	// Guard every field: a truncated or hand-edited trajectory file may carry a
	// NaN/undefined metric, which must not poison the roll-up into NaN.
	const n = (value: number | undefined): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	into.promptTokens += n(metrics.totalPromptTokens);
	into.completionTokens += n(metrics.totalCompletionTokens);
	into.cacheReadTokens += n(metrics.totalCacheReadTokens);
	into.cacheCreationTokens += n(metrics.totalCacheCreationTokens);
	into.costUsd += n(metrics.totalCostUsd);
	into.totalTokens +=
		n(metrics.totalPromptTokens) + n(metrics.totalCompletionTokens);
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
		const bucket = buckets.get(key) ?? emptyTotals();
		addMetrics(bucket, metrics);
		buckets.set(key, bucket);
		addMetrics(grand, metrics);
	}
	// Stable order: named traces first (sorted), the unkeyed bucket last, so the
	// UI renders deterministically and the pre-rollout residue is visually last.
	const byTrace = [...buckets.entries()]
		.map(([traceId, totals]) => ({ traceId, ...totals }))
		.sort((a, b) => {
			if (a.traceId === "" && b.traceId !== "") return 1;
			if (b.traceId === "" && a.traceId !== "") return -1;
			return a.traceId.localeCompare(b.traceId);
		});
	return { ...grand, byTrace };
}
