/**
 * Fans the per-turn runtime recorder's decision stages out to the database
 * trajectory step so app-chat trajectories carry the same Stage-1/planner/
 * tool/evaluation semantics as the JSON file recorder (#17030). The message
 * service wraps its file recorder with this sink at the single construction
 * point; every existing `recordStage` emit site then lands in both stores
 * without a second stage vocabulary.
 *
 * The database side is addressed through the resolved "trajectories" service's
 * `logSemanticStage` hook, keyed by the turn's AsyncLocalStorage
 * `trajectoryStepId`. Fan-out failures are J7 diagnostics: they are warned and
 * reported through `runtime.reportError` and never propagate into the file
 * write or the user turn.
 */

import { getTrajectoryContext } from "../trajectory-context";
import type { RecordedStage, TrajectoryRecorder } from "./trajectory-recorder";

/** The database-side stage hook contributed by the trajectories service. */
export interface SemanticStageDatabaseLogger {
	logSemanticStage(params: { stepId: string; stage: RecordedStage }): void;
}

/** The minimal runtime surface the sink needs (service lookup + J7 reporting). */
export interface SemanticStageFanOutRuntime {
	getService(serviceType: string): unknown;
	reportError(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void;
	logger: {
		warn?: (context: Record<string, unknown>, message?: string) => void;
	};
}

function resolveDatabaseStageLogger(
	runtime: SemanticStageFanOutRuntime,
): SemanticStageDatabaseLogger | null {
	const service = runtime.getService("trajectories");
	if (!service || typeof service !== "object") return null;
	const candidate = service as Partial<SemanticStageDatabaseLogger>;
	return typeof candidate.logSemanticStage === "function"
		? (candidate as SemanticStageDatabaseLogger)
		: null;
}

/**
 * Wrap a trajectory recorder so every recorded stage is also mirrored into the
 * turn's database trajectory step. The inner (file) write always runs; the
 * database mirror is skipped when the turn has no ALS step id or no database
 * trajectories service is running.
 */
export function withSemanticStageFanOut(
	inner: TrajectoryRecorder,
	runtime: SemanticStageFanOutRuntime,
): TrajectoryRecorder {
	return {
		startTrajectory: (input) => inner.startTrajectory(input),
		endTrajectory: (trajectoryId, status) =>
			inner.endTrajectory(trajectoryId, status),
		load: (trajectoryId) => inner.load(trajectoryId),
		list: (opts) => inner.list(opts),
		recordStage: async (trajectoryId, stage) => {
			await inner.recordStage(trajectoryId, stage);
			try {
				const stepId = getTrajectoryContext()?.trajectoryStepId;
				if (!stepId) return;
				const dbLogger = resolveDatabaseStageLogger(runtime);
				if (!dbLogger) return;
				dbLogger.logSemanticStage({ stepId, stage });
			} catch (error) {
				// error-policy:J7 the database mirror is observability; its failure
				// is warned and reported, never allowed to break the turn or the
				// already-completed file write.
				runtime.logger.warn?.(
					{ error, trajectoryId, stageKind: stage.kind },
					"[TrajectoryRecorder] failed to mirror stage into database trajectory",
				);
				runtime.reportError("TrajectorySemanticStageSink.recordStage", error, {
					trajectoryId,
					stageKind: stage.kind,
					diagnosticOnly: true,
				});
			}
		},
	};
}
