/**
 * Services-layer barrel for the trajectory subsystem: re-exports the
 * TrajectoriesService, its read routes, and the export/type modules, and
 * defines the public `TrajectoryProviderAccess`/`TrajectoryLlmCall` shapes —
 * the recorder records widened with their resolved step/run identifiers — that
 * external consumers depend on instead of reaching into runtime/.
 */
export { tryHandleTrajectoryReadRoutes } from "../features/trajectories/read-routes";
export { TrajectoriesService } from "../features/trajectories/TrajectoriesService";
export * from "./trajectory-export";
export * from "./trajectory-types";

import type {
	TrajectoryData as SharedTrajectoryData,
	TrajectoryScalar as SharedTrajectoryScalar,
	TrajectoryLlmCallRecord,
	TrajectoryProviderAccessRecord,
} from "./trajectory-types";

export type TrajectoryScalar = SharedTrajectoryScalar;
export type TrajectoryData = SharedTrajectoryData;

export type TrajectoryProviderAccess = TrajectoryProviderAccessRecord & {
	stepId: string;
	providerName: string;
	purpose: string;
	data: TrajectoryData;
	query?: TrajectoryData;
	timestamp: number;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
};

export type TrajectoryLlmCall = TrajectoryLlmCallRecord & {
	stepId: string;
	model: string;
	systemPrompt: string;
	userPrompt: string;
	response: string;
	temperature: number;
	maxTokens: number;
	maxTokensOmitted?: boolean;
	purpose: string;
	actionType: string;
	latencyMs: number;
	timestamp: number;
	modelSlot?: string;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
};
