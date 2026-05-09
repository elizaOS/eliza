import type { EvaluationResult } from "../types/components";
import type { ContextObject } from "../types/context-object";
import type {
	ChatMessage,
	GenerateTextResult,
	PromptSegment,
	TextGenerationModelType,
	ToolChoice,
	ToolDefinition,
} from "../types/model";
import type { ChainingLoopConfig } from "./limits";
import type { TrajectoryRecorder } from "./trajectory-recorder";

export type { ContextObject } from "../types/context-object";

export interface PlannerToolCall {
	id?: string;
	name: string;
	params?: Record<string, unknown>;
}

export type EvaluatorRoute = EvaluationResult["decision"];

export interface EvaluatorRuntime {
	useModel(
		modelType: TextGenerationModelType,
		params: {
			messages: ChatMessage[];
			responseSchema?: unknown;
			promptSegments?: PromptSegment[];
			providerOptions?: Record<string, unknown>;
		},
		provider?: string,
	): Promise<
		string | { text?: string; object?: unknown; providerMetadata?: unknown }
	>;
	logger?: {
		warn?: (context: unknown, message?: string) => void;
		debug?: (context: unknown, message?: string) => void;
	};
}

export interface EvaluatorEffects {
	copyToClipboard?: (
		clipboard: NonNullable<EvaluationResult["copyToClipboard"]>,
	) => Promise<void> | void;
	messageToUser?: (message: string) => Promise<void> | void;
}

export type EvaluatorOutput = EvaluationResult & {
	nextTool?: PlannerToolCall;
	parseError?: string;
	raw?: Record<string, unknown>;
};

export interface PlannerRuntime {
	useModel(
		modelType: TextGenerationModelType,
		params: {
			messages: ChatMessage[];
			tools?: ToolDefinition[];
			toolChoice?: ToolChoice;
			responseSchema?: unknown;
			promptSegments?: PromptSegment[];
			providerOptions?: Record<string, unknown>;
		},
		provider?: string,
	): Promise<string | GenerateTextResult>;
	logger?: {
		debug?: (context: unknown, message?: string) => void;
		warn?: (context: unknown, message?: string) => void;
		error?: (context: unknown, message?: string) => void;
	};
}

export interface PlannerToolResult {
	success: boolean;
	text?: string;
	data?: Record<string, unknown>;
	error?: unknown;
	continueChain?: boolean;
}

export interface PlannerStep {
	iteration: number;
	thought?: string;
	toolCall?: PlannerToolCall;
	result?: PlannerToolResult;
	terminalMessage?: string;
	terminalOnly?: boolean;
}

export interface PlannerTrajectory {
	context: ContextObject;
	steps: PlannerStep[];
	archivedSteps: PlannerStep[];
	plannedQueue: PlannerToolCall[];
	evaluatorOutputs: EvaluatorOutput[];
}

export interface PlannerLoopResult {
	status: "finished" | "continued";
	trajectory: PlannerTrajectory;
	evaluator?: EvaluatorOutput;
	finalMessage?: string;
}

export interface PlannerLoopParams {
	runtime: PlannerRuntime;
	context: ContextObject;
	config?: Partial<ChainingLoopConfig>;
	executeToolCall: (
		toolCall: PlannerToolCall,
		context: {
			trajectory: PlannerTrajectory;
			iteration: number;
		},
	) => Promise<PlannerToolResult> | PlannerToolResult;
	evaluate?: (params: {
		runtime: PlannerRuntime;
		context: ContextObject;
		trajectory: PlannerTrajectory;
	}) => Promise<EvaluatorOutput> | EvaluatorOutput;
	onToolCallEnqueued?: (
		toolCall: PlannerToolCall,
		context: { iteration: number },
	) => Promise<void> | void;
	modelType?: TextGenerationModelType;
	evaluatorEffects?: EvaluatorEffects;
	provider?: string;
	/** Native tool definitions exposed to the planner model. */
	tools?: ToolDefinition[];
	/** Native tool selection policy. Defaults to "auto" when tools is non-empty. */
	toolChoice?: ToolChoice;
	/**
	 * When true, terminal planner output is only valid after at least one
	 * non-terminal tool has executed for the current turn.
	 */
	requireNonTerminalToolCall?: boolean;
	/**
	 * Trajectory recorder for v5 observability. When supplied, the planner
	 * loop records one stage per planner call, tool execution, and evaluator
	 * call. When omitted the loop is unaffected.
	 */
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
}

export interface RunEvaluatorParams {
	runtime: EvaluatorRuntime;
	context: ContextObject;
	trajectory: PlannerTrajectory;
	modelType?: TextGenerationModelType;
	effects?: EvaluatorEffects;
	provider?: string;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration?: number;
}
