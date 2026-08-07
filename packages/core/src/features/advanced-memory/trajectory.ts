/**
 * Bridges the advanced-memory providers to the trajectory recorder: forwards a
 * provider-access telemetry record (name, purpose, data, query) to the
 * "trajectories" service so a captured run shows what context each memory
 * provider injected. Resolves the trajectory step id from the message metadata
 * or the ambient trajectory context and no-ops when neither is present.
 */

import { getTrajectoryContext } from "../../trajectory-context.ts";
import type { TrajectoryProviderAccessLogger } from "../../trajectory-utils.ts";
import type { IAgentRuntime, Memory } from "../../types/index.ts";

type TrajectoryLogger = Partial<TrajectoryProviderAccessLogger>;

function resolveTrajectoryStepId(message?: Memory): string | null {
	const metadata = message?.metadata as
		| { trajectoryStepId?: unknown }
		| undefined;
	if (
		typeof metadata?.trajectoryStepId === "string" &&
		metadata.trajectoryStepId.trim()
	) {
		return metadata.trajectoryStepId.trim();
	}

	const stepId = getTrajectoryContext()?.trajectoryStepId;
	return typeof stepId === "string" && stepId.trim() ? stepId.trim() : null;
}

export function logAdvancedMemoryTrajectory(params: {
	runtime: IAgentRuntime;
	message?: Memory;
	providerName: string;
	purpose: string;
	data: Record<string, string | number | boolean | null>;
	query?: Record<string, string | number | boolean | null>;
}): void {
	const stepId = resolveTrajectoryStepId(params.message);
	if (!stepId) {
		return;
	}

	const trajectoryLogger = params.runtime.getService(
		"trajectories",
	) as TrajectoryLogger | null;
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.logProviderAccess !== "function"
	) {
		return;
	}

	try {
		trajectoryLogger.logProviderAccess({
			stepId,
			providerName: params.providerName,
			purpose: params.purpose,
			data: params.data,
			query: params.query,
		});
	} catch (error) {
		// error-policy:J7 Trajectory telemetry must not interrupt the message path,
		// but its failure remains observable through runtime diagnostics.
		params.runtime.reportError(
			"AdvancedMemory.trajectoryProviderAccess",
			error,
			{
				providerName: params.providerName,
			},
		);
	}
}
