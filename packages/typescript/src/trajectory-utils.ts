import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "./trajectory-context";
import type { IAgentRuntime } from "./types/runtime";

export type TrajectoryFinalStatus =
	| "completed"
	| "error"
	| "timeout"
	| "terminated";

export type TrajectoryLlmCallDetails = {
	model: string;
	modelVersion?: string;
	systemPrompt: string;
	userPrompt: string;
	response: string;
	reasoning?: string;
	temperature: number;
	maxTokens: number;
	purpose: string;
	actionType: string;
	latencyMs: number;
	promptTokens?: number;
	completionTokens?: number;
};

type TrajectoryStartOptions = {
	source?: string;
	metadata?: Record<string, unknown>;
};

type TrajectoryStepState = {
	timestamp: number;
	agentBalance: number;
	agentPoints: number;
	agentPnL: number;
	openPositions: number;
};

type TrajectoryStepKindLike = "llm" | "action" | "executeCode";

export type TrajectoryAnnotateParams = {
	stepId: string;
	kind?: TrajectoryStepKindLike;
	script?: string;
	childSteps?: string[];
	appendChildSteps?: string[];
	usedSkills?: string[];
};

type TrajectoryLoggerLike = {
	isEnabled?: () => boolean;
	startTrajectory?: (
		agentId: string,
		options?: TrajectoryStartOptions,
	) => Promise<string> | string;
	startStep?: (trajectoryId: string, state: TrajectoryStepState) => string;
	endTrajectory?: (
		stepIdOrTrajectoryId: string,
		status?: TrajectoryFinalStatus,
		finalMetrics?: Record<string, unknown>,
	) => Promise<void> | void;
	flushWriteQueue?: (trajectoryId: string) => Promise<void> | void;
	logLlmCall?: (params: { stepId: string } & TrajectoryLlmCallDetails) => void;
	/**
	 * Optional. When implemented (DatabaseTrajectoryLogger does), lets a caller
	 * extend an existing step row with the new schema fields (kind, script,
	 * childSteps, usedSkills). The plugin-executecode action uses this to
	 * record its parent step + collected child step IDs without depending
	 * directly on @elizaos/agent.
	 */
	annotateStep?: (params: TrajectoryAnnotateParams) => Promise<void> | void;
};

type StandaloneTrajectoryOptions = {
	source: string;
	metadata?: Record<string, unknown>;
	successStatus?: TrajectoryFinalStatus;
	errorStatus?: Exclude<TrajectoryFinalStatus, "completed">;
};

function isTrajectoryLoggerCandidate(
	value: unknown,
): value is TrajectoryLoggerLike {
	return !!value && typeof value === "object";
}

export function resolveTrajectoryLogger(
	runtime: IAgentRuntime,
): TrajectoryLoggerLike | null {
	const candidates: TrajectoryLoggerLike[] = [];
	const seen = new Set<unknown>();
	const push = (candidate: unknown): void => {
		if (!isTrajectoryLoggerCandidate(candidate) || seen.has(candidate)) {
			return;
		}
		seen.add(candidate);
		candidates.push(candidate);
	};

	push(runtime.getService("trajectories"));
	for (const candidate of runtime.getServicesByType("trajectories")) {
		push(candidate);
	}

	let best: TrajectoryLoggerLike | null = null;
	let bestScore = -1;
	for (const candidate of candidates) {
		let score = 0;
		if (typeof candidate.startTrajectory === "function") score += 100;
		if (typeof candidate.startStep === "function") score += 10;
		if (typeof candidate.endTrajectory === "function") score += 10;
		if (typeof candidate.logLlmCall === "function") score += 10;
		if (typeof candidate.flushWriteQueue === "function") score += 2;
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}

	return bestScore > 0 ? best : null;
}

export async function withStandaloneTrajectory<T>(
	runtime: IAgentRuntime | null | undefined,
	options: StandaloneTrajectoryOptions,
	callback: () => Promise<T> | T,
): Promise<T> {
	const activeStepId = getTrajectoryContext()?.trajectoryStepId;
	if (
		!runtime ||
		(typeof activeStepId === "string" && activeStepId.trim() !== "")
	) {
		return await callback();
	}

	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.startTrajectory !== "function" ||
		typeof trajectoryLogger.endTrajectory !== "function" ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return await callback();
	}

	const trajectoryId = String(
		await trajectoryLogger.startTrajectory(runtime.agentId, {
			source: options.source,
			metadata: options.metadata,
		}),
	).trim();
	if (!trajectoryId) {
		return await callback();
	}

	const stepId =
		typeof trajectoryLogger.startStep === "function"
			? String(
					trajectoryLogger.startStep(trajectoryId, {
						timestamp: Date.now(),
						agentBalance: 0,
						agentPoints: 0,
						agentPnL: 0,
						openPositions: 0,
					}),
				).trim() || trajectoryId
			: trajectoryId;

	let completed = false;
	try {
		const result = await runWithTrajectoryContext(
			{ trajectoryStepId: stepId },
			() => callback(),
		);
		completed = true;
		return result;
	} finally {
		if (typeof trajectoryLogger.flushWriteQueue === "function") {
			await trajectoryLogger.flushWriteQueue(trajectoryId);
		}
		await trajectoryLogger.endTrajectory(
			trajectoryId,
			completed
				? (options.successStatus ?? "completed")
				: (options.errorStatus ?? "error"),
		);
	}
}

/**
 * Annotate a trajectory step via whichever trajectory logger service is
 * registered on the runtime. Returns true when an annotate-capable service
 * was found and called; false when no compatible service exists or it is
 * disabled. Errors from the underlying service are propagated.
 */
export async function annotateActiveTrajectoryStep(
	runtime: IAgentRuntime | null | undefined,
	params: TrajectoryAnnotateParams,
): Promise<boolean> {
	if (!runtime) return false;
	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.annotateStep !== "function" ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return false;
	}
	await trajectoryLogger.annotateStep(params);
	return true;
}

export function logActiveTrajectoryLlmCall(
	runtime: IAgentRuntime | null | undefined,
	details: TrajectoryLlmCallDetails,
): boolean {
	if (!runtime) {
		return false;
	}

	const stepId = getTrajectoryContext()?.trajectoryStepId;
	if (!(typeof stepId === "string" && stepId.trim() !== "")) {
		return false;
	}

	const trajectoryLogger = resolveTrajectoryLogger(runtime);
	if (
		!trajectoryLogger ||
		typeof trajectoryLogger.logLlmCall !== "function" ||
		(typeof trajectoryLogger.isEnabled === "function" &&
			!trajectoryLogger.isEnabled())
	) {
		return false;
	}

	trajectoryLogger.logLlmCall({
		stepId: stepId.trim(),
		...details,
	});
	return true;
}
