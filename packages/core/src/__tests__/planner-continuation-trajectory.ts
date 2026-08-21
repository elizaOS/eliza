/**
 * Provides the causal persistence barrier used by planner-continuation
 * evidence after visible message delivery has completed.
 */

import { drainPostDeliveryTasks } from "../services/post-delivery-task-tracker.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

export interface PlannerContinuationTrajectoryDetail {
	metrics?: { finalStatus?: string };
}

interface PlannerContinuationTrajectoryService<
	TDetail extends PlannerContinuationTrajectoryDetail,
> {
	flushWriteQueue(trajectoryId: string): Promise<void>;
	getTrajectoryDetail(trajectoryId: string): Promise<TDetail | null>;
}

type PlannerContinuationRuntime = Pick<
	IAgentRuntime,
	"agentId" | "reportError"
> &
	Partial<Pick<IAgentRuntime, "roomHandlerQueue">>;

function requireTrajectoryService<
	TDetail extends PlannerContinuationTrajectoryDetail,
>(service: unknown): PlannerContinuationTrajectoryService<TDetail> {
	if (
		typeof service !== "object" ||
		service === null ||
		typeof (service as { flushWriteQueue?: unknown }).flushWriteQueue !==
			"function"
	) {
		throw new Error(
			"Planner continuation trajectory service requires flushWriteQueue(trajectoryId)",
		);
	}
	if (
		typeof (service as { getTrajectoryDetail?: unknown })
			.getTrajectoryDetail !== "function"
	) {
		throw new Error(
			"Planner continuation trajectory service requires getTrajectoryDetail(trajectoryId)",
		);
	}
	return service as PlannerContinuationTrajectoryService<TDetail>;
}

/** Drain terminal work, flush its queued write once, then read one terminal row. */
export async function readCompletedPlannerContinuationTrajectory<
	TDetail extends PlannerContinuationTrajectoryDetail,
>(
	runtime: PlannerContinuationRuntime,
	trajectoryId: string,
	service: unknown,
): Promise<TDetail> {
	if (typeof trajectoryId !== "string" || !trajectoryId.trim()) {
		throw new Error("Planner continuation trajectoryId must be non-empty");
	}
	const trajectoryService = requireTrajectoryService<TDetail>(service);

	await drainPostDeliveryTasks(runtime);
	await trajectoryService.flushWriteQueue(trajectoryId);
	const detail = await trajectoryService.getTrajectoryDetail(trajectoryId);
	if (!detail) {
		throw new Error(
			`Planner continuation trajectory "${trajectoryId}" was not persisted after post-delivery drain`,
		);
	}
	const finalStatus = detail.metrics?.finalStatus;
	if (finalStatus !== "completed") {
		throw new Error(
			`Planner continuation trajectory "${trajectoryId}" is not completed (observed: ${finalStatus ?? "missing"})`,
		);
	}
	return detail;
}
