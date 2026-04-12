export { TrajectoriesService } from "../features/trajectories/TrajectoriesService";

export type TrajectoryScalar = string | number | boolean | null;
export type TrajectoryData = Record<string, TrajectoryScalar>;

export type TrajectoryProviderAccess = {
	stepId: string;
	providerName: string;
	purpose: string;
	data: TrajectoryData;
	query?: TrajectoryData;
	timestamp: number;
};

export type TrajectoryLlmCall = {
	stepId: string;
	model: string;
	systemPrompt: string;
	userPrompt: string;
	response: string;
	temperature: number;
	maxTokens: number;
	purpose: string;
	actionType: string;
	latencyMs: number;
	timestamp: number;
};
