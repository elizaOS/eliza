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
	} catch {
		// Trajectory logging must never interrupt the message path.
	}
}
