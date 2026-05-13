import type { JsonObject, JsonValue } from "../types/primitives";

export type RLMOperation =
	| "peek"
	| "grep"
	| "partition"
	| "map_subcall"
	| "summarize"
	| "stitch"
	| "final";

export interface RLMBudget {
	maxIterations: number;
	maxDepth: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxLatencyMs?: number;
}

export interface RLMContextHandle {
	id: string;
	kind: "text" | "file" | "memory" | "benchmark" | "external";
	description?: string;
	tokenEstimate?: number;
	characterEstimate?: number;
	metadata?: JsonObject;
}

export interface RLMRequest {
	task: string;
	context?: string;
	contextHandle?: RLMContextHandle;
	allowedOperations?: RLMOperation[];
	budget: RLMBudget;
	metadata?: JsonObject;
}

export interface RLMIteration {
	index: number;
	operation: RLMOperation;
	query?: string;
	generatedCode?: string;
	observation?: string;
	subcallCount?: number;
	promptTokens?: number;
	completionTokens?: number;
	latencyMs?: number;
	metadata?: JsonObject;
}

export interface RLMTelemetry {
	iterations: number;
	subcallCount: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	latencyMs?: number;
	costUsd?: number;
}

export interface RLMResult {
	text: string;
	iterations: RLMIteration[];
	telemetry: RLMTelemetry;
	evidence?: JsonValue[];
	trajectoryId?: string;
}

export interface RLMStatus {
	available: boolean;
	backend?: string;
	environment?: string;
	reason?: string;
}

export interface RLMService {
	status(): Promise<RLMStatus>;
	infer(request: RLMRequest): Promise<RLMResult>;
	shutdown?(): Promise<void>;
}

export interface RLMPolicyInput {
	taskKind?: string;
	contextTokens?: number;
	contextChars?: number;
	hasExternalContext?: boolean;
	latencyBudgetMs?: number;
	explicitlyRequested?: boolean;
}

export interface RLMPolicyDecision {
	enabled: boolean;
	reason: string;
	budget: RLMBudget;
}

const SHORT_TASK_KINDS = new Set([
	"action-calling",
	"bfcl",
	"mind2web",
	"vending_bench",
	"voicebench",
	"woobench",
]);

export function decideRLMUse(input: RLMPolicyInput): RLMPolicyDecision {
	const budget: RLMBudget = {
		maxIterations: 4,
		maxDepth: 1,
		maxLatencyMs: input.latencyBudgetMs,
	};
	const taskKind = input.taskKind?.trim().toLowerCase();
	if (input.explicitlyRequested) {
		return { enabled: true, reason: "explicitly_requested", budget };
	}
	if (taskKind && SHORT_TASK_KINDS.has(taskKind)) {
		return { enabled: false, reason: "short_action_task", budget };
	}
	const contextTokens = input.contextTokens ?? 0;
	const contextChars = input.contextChars ?? 0;
	if (
		!input.hasExternalContext &&
		contextTokens < 32000 &&
		contextChars < 128000
	) {
		return {
			enabled: false,
			reason: "context_within_direct_model_budget",
			budget,
		};
	}
	return { enabled: true, reason: "large_external_context", budget };
}
