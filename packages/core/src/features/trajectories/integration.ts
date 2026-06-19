/**
 * Manual Instrumentation Helpers
 *
 * Advanced manual control for trajectory logging.
 */

import { logger } from "../../logger";
import type { TrajectoriesService } from "./TrajectoriesService";
import type { EnvironmentState, JsonValue } from "./types";

export interface TrajectoryMetadata {
	[key: string]: JsonValue;
}

export type FinalMetrics = Record<string, JsonValue> & {
	totalReward?: number;
	stepCount?: number;
	successRate?: number;
};

export interface ProviderAccessData {
	[key: string]: JsonValue;
}

export type WrappedFunctionArgs = JsonValue[];

export async function startAutonomousTick(
	trajectoryLogger: TrajectoriesService,
	context: {
		agentId: string;
		source?: string;
		scenarioId?: string;
		episodeId?: string;
		batchId?: string;
		metadata?: TrajectoryMetadata;
	},
): Promise<string> {
	const trajectoryId = await trajectoryLogger.startTrajectory(context.agentId, {
		source: context.source,
		scenarioId: context.scenarioId,
		episodeId: context.episodeId,
		batchId: context.batchId,
		metadata: context.metadata,
	});

	const envState: EnvironmentState = {
		timestamp: Date.now(),
		agentBalance: 0,
		agentPoints: 0,
		agentPnL: 0,
		openPositions: 0,
	};

	trajectoryLogger.startStep(trajectoryId, envState);

	logger.info(
		{ trajectoryId, agentId: context.agentId },
		"Started autonomous tick trajectory",
	);

	return trajectoryId;
}

export async function endAutonomousTick(
	trajectoryLogger: TrajectoriesService,
	trajectoryId: string,
	status: "completed" | "terminated" | "error" | "timeout" = "completed",
	finalMetrics?: FinalMetrics,
): Promise<void> {
	// Flush pending fire-and-forget writes (logLLMCall, completeStep) before
	// endTrajectory reads the trajectory so recorded LLM calls are persisted.
	await trajectoryLogger.flushWriteQueue(trajectoryId);

	await trajectoryLogger.endTrajectory(trajectoryId, status, finalMetrics);

	logger.info({ trajectoryId, status }, "Ended autonomous tick trajectory");
}

export async function loggedLLMCall(
	trajectoryLogger: TrajectoriesService,
	trajectoryId: string,
	options: {
		model: string;
		modelVersion?: string;
		systemPrompt: string;
		userPrompt: string;
		temperature?: number;
		maxTokens?: number;
		purpose?: string;
		actionType?: string;
	},
	llmCallFn: () => Promise<{
		text: string;
		reasoning?: string;
		tokens?: { prompt?: number; completion?: number };
		latencyMs?: number;
	}>,
): Promise<string> {
	const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
	if (!stepId) {
		logger.warn({ trajectoryId }, "No active step for LLM call");
		const result = await llmCallFn();
		return result.text;
	}

	const startTime = Date.now();
	const result = await llmCallFn();
	const latencyMs = Date.now() - startTime;

	trajectoryLogger.logLLMCall(stepId, {
		model: options.model,
		modelVersion: options.modelVersion,
		systemPrompt: options.systemPrompt,
		userPrompt: options.userPrompt,
		response: result.text,
		reasoning: result.reasoning,
		temperature: options.temperature || 0.7,
		maxTokens: options.maxTokens || 8192,
		purpose: options.purpose || "action",
		actionType: options.actionType,
		promptTokens: result.tokens?.prompt,
		completionTokens: result.tokens?.completion,
		latencyMs: result.latencyMs || latencyMs,
	});

	return result.text;
}

export function logProviderAccess(
	trajectoryLogger: TrajectoriesService,
	trajectoryId: string,
	access: {
		providerName: string;
		data: ProviderAccessData;
		purpose: string;
		query?: ProviderAccessData;
	},
): void {
	trajectoryLogger.logProviderAccessByTrajectoryId(trajectoryId, access);
}

type AsyncFunction<TArgs extends JsonValue[], TResult extends JsonValue> = (
	...args: TArgs
) => Promise<TResult>;

export function withTrajectoryLogging<
	TArgs extends JsonValue[],
	TResult extends JsonValue,
>(
	fn: AsyncFunction<TArgs, TResult>,
	trajectoryLogger: TrajectoriesService,
	trajectoryId: string,
	context: {
		actionType?: string;
		purpose?: string;
	} = {},
): AsyncFunction<TArgs, TResult> {
	return async (...args: TArgs): Promise<TResult> => {
		const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
		if (!stepId) {
			return fn(...args);
		}

		const result = await fn(...args);

		trajectoryLogger.completeStep(
			trajectoryId,
			stepId,
			{
				actionType: context.actionType || "function_call",
				actionName: fn.name || "anonymous",
				parameters: { args: args as JsonValue[] },
				success: true,
				result: result !== undefined ? { result } : { result: null },
			},
			{ reward: 0.05 },
		);

		return result;
	};
}
