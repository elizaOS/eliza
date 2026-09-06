/** Persists inference timing diagnostics and retires expired timing log rows independently of message content. */

import type { InferenceTurnSummary } from "../../inference-timing";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";

export const INFERENCE_TIMING_LOG_TYPE = "inference_timing";

export const INFERENCE_TIMING_LOG_RETENTION = 4_096;

export const INFERENCE_TIMING_LOG_SWEEP_INTERVAL = 64;

export const inferenceTimingWritesSinceSweep = new WeakMap<
	IAgentRuntime,
	number
>();

export async function persistInferenceTimingSummary(
	runtime: IAgentRuntime,
	message: Memory,
	summary: InferenceTurnSummary,
): Promise<void> {
	await runtime.createLogs([
		{
			body: {
				runId: summary.turnId,
				messageId: message.id,
				roomId: message.roomId,
				entityId: runtime.agentId,
				source: INFERENCE_TIMING_LOG_TYPE,
				startTime: summary.t0EpochMs,
				endTime: summary.closedAtEpochMs ?? undefined,
				duration: summary.totalMs ?? undefined,
				metadata: {
					label: summary.label,
					traceId: summary.traceId,
					modelProvider: summary.modelProvider,
					timeToFirstTokenMs: summary.timeToFirstTokenMs,
					timeToFirstVisibleMs: summary.timeToFirstVisibleMs,
					timeToReplyMs: summary.timeToReplyMs,
					timeToResponseFinalizedMs: summary.timeToResponseFinalizedMs,
					spans: summary.spans.map((span) => ({
						name: span.name,
						startMs: span.startMs,
						endMs: span.endMs,
						durationMs: span.durationMs,
						...(span.meta ? { meta: span.meta } : {}),
					})),
					marks: summary.marks.map((mark) => ({
						name: mark.name,
						tMs: mark.tMs,
					})),
					byName: summary.byName,
					anomalies: summary.anomalies,
				},
			},
			entityId: runtime.agentId,
			roomId: message.roomId,
			type: INFERENCE_TIMING_LOG_TYPE,
		},
	]);

	const priorWritesSinceSweep = inferenceTimingWritesSinceSweep.get(runtime);
	const writesSinceSweep =
		(priorWritesSinceSweep === undefined ? 0 : priorWritesSinceSweep) + 1;
	if (writesSinceSweep < INFERENCE_TIMING_LOG_SWEEP_INTERVAL) {
		inferenceTimingWritesSinceSweep.set(runtime, writesSinceSweep);
		return;
	}
	inferenceTimingWritesSinceSweep.set(runtime, 0);
	const rows = await runtime.getLogs({
		type: INFERENCE_TIMING_LOG_TYPE,
		limit: INFERENCE_TIMING_LOG_RETENTION + 1_024,
	});
	const expiredIds = rows
		.slice(INFERENCE_TIMING_LOG_RETENTION)
		.map((row) => row.id)
		.filter((id): id is UUID => typeof id === "string");
	if (expiredIds.length > 0) {
		await runtime.deleteLogs(expiredIds);
	}
}
