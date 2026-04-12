import type { PromptKey, ScoreCardData, SlotKey } from "./prompt-optimization-trace.ts";

/**
 * Logical slot folder for provider observations when persisting to disk.
 */
export const TRAJECTORY_PROVIDER_SLOT = "PROVIDER_TRACE" as const;

/** Raw `useModel` fact row (`history.jsonl` union). */
export interface LlmObservationRecord {
	type: "llm_observation";
	observationVersion: number;
	createdAt: number;
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
	modelSlot?: SlotKey;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
}

/** Provider access during `composeState` (union log). */
export interface ProviderObservationRecord {
	type: "provider_observation";
	observationVersion: number;
	createdAt: number;
	stepId: string;
	providerName: string;
	purpose: string;
	data: Record<string, string | number | boolean | null>;
	query?: Record<string, string | number | boolean | null>;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
}

export interface SignalContextRecord {
	type: "signal_context";
	observationVersion: number;
	createdAt: number;
	executionTraceId: string;
	scoreCard: ScoreCardData;
	runId?: string;
	trajectoryStepId?: string;
	promptKey?: PromptKey;
	modelSlot?: SlotKey;
}
