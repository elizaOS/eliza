/**
 * Provides the causal persistence barrier used by planner-continuation
 * evidence after visible message delivery has completed, plus the serializer
 * that turns a completed live run into its reviewable artifact. A run whose
 * live harness never constructed still emits an artifact, marked unavailable,
 * so a stale file from an earlier run can never be mistaken for this run's
 * receipt.
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

export interface PlannerContinuationEvidenceHarness {
	providerName: string | null;
	providerConfig: {
		baseUrl?: string;
		smallModel?: string;
		largeModel?: string;
	} | null;
}

/**
 * Render the live evidence artifact. `harness` is absent when live setup threw
 * before the runtime existed; that run observed no provider attribution, so the
 * artifact says so explicitly rather than omitting the fields or leaving an
 * earlier run's file in place to be read as this run's receipt.
 */
export function serializePlannerContinuationEvidence(
	harness: PlannerContinuationEvidenceHarness | undefined,
	evidence: ReadonlyArray<Record<string, unknown>>,
): string {
	const body = harness
		? {
				status: "captured" as const,
				provider: harness.providerName,
				baseUrl: harness.providerConfig?.baseUrl,
				smallModel: harness.providerConfig?.smallModel,
				largeModel: harness.providerConfig?.largeModel,
				evidence,
			}
		: {
				status: "harness-unavailable" as const,
				reason:
					"live continuation harness did not initialize; no provider attribution was observed",
				evidence,
			};
	return `${JSON.stringify(body, null, 2)}\n`;
}
