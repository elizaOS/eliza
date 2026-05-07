import { v5PlannerTemplate } from "../prompts/planner";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { ActionResult, ProviderDataRecord } from "../types/components";
import type { ContextEvent, ContextObject } from "../types/context-object";
import {
	type ChatMessage,
	type GenerateTextResult,
	ModelType,
	type TextGenerationModelType,
	type ToolCall,
	type ToolChoice,
	type ToolDefinition,
} from "../types/model";
import { computeCallCostUsd } from "./cost-table";
import type { EvaluatorEffects, EvaluatorOutput } from "./evaluator";
import { runEvaluator } from "./evaluator";
import { parseJsonObject, stringifyForModel } from "./json-output";
import {
	assertRepeatedFailureLimit,
	assertTrajectoryLimit,
	type ChainingLoopConfig,
	type FailureLike,
	mergeChainingLoopConfig,
} from "./limits";
import type {
	RecordedStage,
	RecordedToolCall,
	RecordedUsage,
	TrajectoryRecorder,
} from "./trajectory-recorder";

export type { ContextObject } from "../types/context-object";

export interface PlannerRuntime {
	useModel(
		modelType: TextGenerationModelType,
		params: {
			prompt: string;
			tools?: ToolDefinition[];
			toolChoice?: ToolChoice;
			messages?: ChatMessage[];
		},
		provider?: string,
	): Promise<string | GenerateTextResult>;
	logger?: {
		debug?: (context: unknown, message?: string) => void;
		warn?: (context: unknown, message?: string) => void;
		error?: (context: unknown, message?: string) => void;
	};
}

export interface PlannerToolCall {
	id?: string;
	name: string;
	params?: Record<string, unknown>;
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
	 * Trajectory recorder for v5 observability. When supplied, the planner
	 * loop records one stage per planner call, tool execution, and evaluator
	 * call. When omitted the loop is unaffected.
	 */
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
}

interface RawPlannerOutput {
	thought?: unknown;
	toolCalls?: unknown;
	tools?: unknown;
	actions?: unknown;
	action?: unknown;
	messageToUser?: unknown;
	text?: unknown;
}

export async function runPlannerLoop(
	params: PlannerLoopParams,
): Promise<PlannerLoopResult> {
	const config = mergeChainingLoopConfig(params.config);
	const trajectory: PlannerTrajectory = {
		context: params.context,
		steps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
	const failures: FailureLike[] = [];

	for (
		let iteration = 1;
		iteration <= config.maxPlannerIterations;
		iteration++
	) {
		assertTrajectoryLimit({
			kind: "planner_iterations",
			max: config.maxPlannerIterations,
			observed: iteration,
		});

		if (trajectory.plannedQueue.length === 0) {
			const plannerOutput = await callPlanner({
				runtime: params.runtime,
				context: params.context,
				trajectory,
				modelType: params.modelType,
				provider: params.provider,
				tools: params.tools,
				toolChoice: params.toolChoice,
				recorder: params.recorder,
				trajectoryId: params.trajectoryId,
				parentStageId: params.parentStageId,
				iteration,
			});

			if (plannerOutput.toolCalls.length === 0) {
				trajectory.steps.push({
					iteration,
					thought: plannerOutput.thought,
					terminalMessage: plannerOutput.messageToUser,
					terminalOnly: true,
				});
				return {
					status: "finished",
					trajectory,
					finalMessage: plannerOutput.messageToUser,
				};
			}

			if (plannerOutput.toolCalls.every(isTerminalToolCall)) {
				const finalMessage = terminalMessageFromToolCalls(
					plannerOutput.toolCalls,
					plannerOutput.messageToUser,
				);
				trajectory.steps.push({
					iteration,
					thought: plannerOutput.thought,
					terminalMessage: finalMessage,
					terminalOnly: true,
				});
				return {
					status: "finished",
					trajectory,
					finalMessage,
				};
			}

			const nonTerminalCalls = plannerOutput.toolCalls
				.filter((toolCall) => !isTerminalToolCall(toolCall))
				.map((toolCall, index) => ensureToolCallId(toolCall, iteration, index));
			trajectory.plannedQueue.push(...nonTerminalCalls);
		}

		const toolCall = trajectory.plannedQueue.shift();
		if (!toolCall) {
			continue;
		}

		await executeQueuedToolCall({
			params,
			trajectory,
			toolCall,
			iteration,
			config,
			failures,
		});

		const evaluator = await evaluateTrajectory(params, trajectory, iteration);
		trajectory.evaluatorOutputs.push(evaluator);

		if (evaluator.decision === "FINISH") {
			return {
				status: "finished",
				trajectory,
				evaluator,
				finalMessage: evaluator.messageToUser,
			};
		}

		if (evaluator.decision === "NEXT_RECOMMENDED") {
			preferRecommendedToolCall(trajectory, evaluator);
			continue;
		}

		trajectory.plannedQueue.length = 0;
	}

	const evaluator =
		trajectory.evaluatorOutputs[trajectory.evaluatorOutputs.length - 1] ??
		({
			success: false,
			decision: "CONTINUE",
			thought: "Planner loop stopped at iteration limit.",
		} satisfies EvaluatorOutput);
	return {
		status: "continued",
		trajectory,
		evaluator,
	};
}

export function renderPlannerPrompt(params: {
	context: ContextObject;
	trajectory: PlannerTrajectory;
	template?: string;
}): string {
	return (params.template ?? v5PlannerTemplate)
		.replace("{{contextObject}}", stringifyForModel(params.context))
		.replace("{{trajectory}}", stringifyForModel(params.trajectory.steps));
}

export function parsePlannerOutput(raw: string | GenerateTextResult): {
	thought?: string;
	toolCalls: PlannerToolCall[];
	messageToUser?: string;
	raw: Record<string, unknown>;
} {
	if (typeof raw === "string") {
		return parseJsonPlannerOutput(raw);
	}

	const nativeToolCalls = normalizeToolCalls(raw.toolCalls);
	if (nativeToolCalls.length > 0) {
		return {
			thought: undefined,
			toolCalls: nativeToolCalls,
			messageToUser: getNonEmptyString(raw.text),
			raw: {
				text: raw.text,
				toolCalls: raw.toolCalls,
			} as Record<string, unknown>,
		};
	}

	if (typeof raw.text === "string" && raw.text.trim().length > 0) {
		const fromText = parseJsonPlannerOutput(raw.text);
		if (fromText.toolCalls.length > 0 || fromText.messageToUser) {
			return fromText;
		}
	}

	return {
		thought: undefined,
		toolCalls: [],
		messageToUser: getNonEmptyString(raw.text),
		raw: {
			text: raw.text,
			toolCalls: raw.toolCalls,
		} as Record<string, unknown>,
	};
}

function parseJsonPlannerOutput(raw: string): {
	thought?: string;
	toolCalls: PlannerToolCall[];
	messageToUser?: string;
	raw: Record<string, unknown>;
} {
	const parsed = parseJsonObject<RawPlannerOutput>(raw) ?? {};
	const messageToUser = getNonEmptyString(parsed.messageToUser ?? parsed.text);
	const toolCalls = normalizeToolCalls(
		parsed.toolCalls ?? parsed.tools ?? parsed.actions ?? parsed.action,
	);
	return {
		thought: typeof parsed.thought === "string" ? parsed.thought : undefined,
		toolCalls,
		messageToUser,
		raw: parsed as Record<string, unknown>,
	};
}

async function callPlanner(params: {
	runtime: PlannerRuntime;
	context: ContextObject;
	trajectory: PlannerTrajectory;
	modelType?: TextGenerationModelType;
	provider?: string;
	tools?: ToolDefinition[];
	toolChoice?: ToolChoice;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration?: number;
}): Promise<ReturnType<typeof parsePlannerOutput>> {
	const prompt = renderPlannerPrompt({
		context: params.context,
		trajectory: params.trajectory,
	});
	const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
	const modelParams: {
		prompt: string;
		tools?: ToolDefinition[];
		toolChoice?: ToolChoice;
	} = { prompt };
	if (hasTools) {
		modelParams.tools = params.tools;
		modelParams.toolChoice = params.toolChoice ?? "auto";
	}

	const startedAt = Date.now();
	const modelType = params.modelType ?? ModelType.ACTION_PLANNER;
	const raw = await params.runtime.useModel(modelType, modelParams, params.provider);
	const endedAt = Date.now();

	const parsed = parsePlannerOutput(raw);

	await recordPlannerStage({
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		iteration: params.iteration ?? 1,
		modelType,
		provider: params.provider,
		prompt,
		modelParams,
		raw,
		parsed,
		startedAt,
		endedAt,
		logger: params.runtime.logger,
	});

	return parsed;
}

async function recordPlannerStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	modelType: TextGenerationModelType;
	provider?: string;
	prompt: string;
	modelParams: { tools?: ToolDefinition[]; toolChoice?: ToolChoice };
	raw: string | GenerateTextResult;
	parsed: ReturnType<typeof parsePlannerOutput>;
	startedAt: number;
	endedAt: number;
	logger?: PlannerRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;

	try {
		const responseText =
			typeof args.raw === "string" ? args.raw : (args.raw.text ?? "");
		const usage = extractUsage(args.raw);
		const finishReason = extractFinishReason(args.raw);
		const modelName = extractModelName(args.raw);
		const stage: RecordedStage = {
			stageId: `stage-planner-iter-${args.iteration}-${args.startedAt}`,
			kind: "planner",
			iteration: args.iteration,
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			model: {
				modelType: String(args.modelType),
				modelName,
				provider: args.provider ?? "default",
				prompt: args.prompt,
				tools: args.modelParams.tools?.map((t) => ({
					name: t.name,
					description: t.description,
				})),
				toolChoice: args.modelParams.toolChoice,
				response: responseText,
				toolCalls: args.parsed.toolCalls.map<RecordedToolCall>((tc) => ({
					id: tc.id,
					name: tc.name,
					args: tc.params,
				})),
				usage,
				finishReason,
				costUsd: usage ? computeCallCostUsd(modelName, usage) : undefined,
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record planner stage",
		);
	}
}

function extractUsage(raw: string | GenerateTextResult): RecordedUsage | undefined {
	if (typeof raw === "string") return undefined;
	if (!raw.usage) return undefined;
	const usage = raw.usage;
	const promptTokens = usage.promptTokens ?? 0;
	const completionTokens = usage.completionTokens ?? 0;
	const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
	const out: RecordedUsage = {
		promptTokens,
		completionTokens,
		totalTokens,
	};
	const cacheRead = (usage as Record<string, unknown>).cacheReadInputTokens;
	if (typeof cacheRead === "number") {
		out.cacheReadInputTokens = cacheRead;
	} else {
		// Fall back to OpenAI plugin's `cachedPromptTokens` shape, which adapters
		// emitted before the shared schema landed.
		const cachedPrompt = (usage as Record<string, unknown>).cachedPromptTokens;
		if (typeof cachedPrompt === "number") {
			out.cacheReadInputTokens = cachedPrompt;
		}
	}
	const cacheCreation = (usage as Record<string, unknown>).cacheCreationInputTokens;
	if (typeof cacheCreation === "number") {
		out.cacheCreationInputTokens = cacheCreation;
	}
	return out;
}

function extractFinishReason(raw: string | GenerateTextResult): string | undefined {
	if (typeof raw === "string") return undefined;
	return raw.finishReason;
}

function extractModelName(raw: string | GenerateTextResult): string | undefined {
	if (typeof raw === "string") return undefined;
	const meta = raw.providerMetadata;
	if (meta && typeof meta === "object") {
		const direct = (meta as Record<string, unknown>).modelName;
		if (typeof direct === "string") return direct;
		const model = (meta as Record<string, unknown>).model;
		if (typeof model === "string") return model;
	}
	return undefined;
}

async function evaluateTrajectory(
	params: PlannerLoopParams,
	trajectory: PlannerTrajectory,
	iteration: number,
): Promise<EvaluatorOutput> {
	if (params.evaluate) {
		return await params.evaluate({
			runtime: params.runtime,
			context: params.context,
			trajectory,
		});
	}

	return await runEvaluator({
		runtime: params.runtime,
		context: params.context,
		trajectory,
		effects: params.evaluatorEffects,
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		iteration,
	});
}

async function executeQueuedToolCall(params: {
	params: PlannerLoopParams;
	trajectory: PlannerTrajectory;
	toolCall: PlannerToolCall;
	iteration: number;
	config: ChainingLoopConfig;
	failures: FailureLike[];
}): Promise<void> {
	assertTrajectoryLimit({
		kind: "tool_calls",
		max: params.config.maxToolCalls,
		observed:
			params.trajectory.steps.filter((step) => step.toolCall).length + 1,
	});

	const streamingContext = getStreamingContext();
	const contextEvent = findToolContextEvent(
		params.trajectory.context,
		params.toolCall,
	);
	await emitStreamingHook(streamingContext, "onToolCall", {
		toolCall: plannerToolCallToStreamingToolCall(params.toolCall, "pending"),
		contextEvent,
		messageId: streamingContext?.messageId,
		metadata: { iteration: params.iteration },
	});

	await params.params.onToolCallEnqueued?.(params.toolCall, {
		iteration: params.iteration,
	});

	const startedAt = Date.now();
	let result: PlannerToolResult;
	try {
		result = await params.params.executeToolCall(params.toolCall, {
			trajectory: params.trajectory,
			iteration: params.iteration,
		});
	} catch (error) {
		result = {
			success: false,
			error,
		};
	}
	const endedAt = Date.now();

	const failure = {
		toolName: params.toolCall.name,
		success: result.success,
		error: result.error,
	};
	if (!result.success || result.error != null) {
		params.failures.push(failure);
		assertRepeatedFailureLimit({
			failures: params.failures,
			latestFailure: failure,
			maxRepeatedFailures: params.config.maxRepeatedFailures,
		});
	}

	params.trajectory.steps.push({
		iteration: params.iteration,
		toolCall: params.toolCall,
		result,
	});

	await recordToolStage({
		recorder: params.params.recorder,
		trajectoryId: params.params.trajectoryId,
		parentStageId: params.params.parentStageId,
		toolCall: params.toolCall,
		result,
		startedAt,
		endedAt,
		logger: params.params.runtime.logger,
	});
}

async function recordToolStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	toolCall: PlannerToolCall;
	result: PlannerToolResult;
	startedAt: number;
	endedAt: number;
	logger?: PlannerRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;
	try {
		const stage: RecordedStage = {
			stageId: `stage-tool-${args.toolCall.name}-${args.startedAt}`,
			kind: "tool",
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			tool: {
				name: args.toolCall.name,
				args: (args.toolCall.params ?? {}) as Record<string, unknown>,
				result: args.result,
				success: args.result.success,
				durationMs: args.endedAt - args.startedAt,
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record tool stage",
		);
	}
}

function plannerToolCallToStreamingToolCall(
	toolCall: PlannerToolCall,
	status: "pending" | "completed" | "failed",
): ToolCall {
	return {
		id: toolCall.id ?? toolCall.name,
		name: toolCall.name,
		arguments: (toolCall.params ?? {}) as ToolCall["arguments"],
		status,
	};
}

function findToolContextEvent(
	context: ContextObject,
	toolCall: PlannerToolCall,
): ContextEvent | undefined {
	return context.events?.find((event) => {
		if (event.type !== "tool" || !("tool" in event)) {
			return false;
		}
		const tool = (event as { tool?: { name?: string } }).tool;
		return tool?.name === toolCall.name;
	});
}

function normalizeToolCalls(value: unknown): PlannerToolCall[] {
	if (value == null || value === "") {
		return [];
	}

	const entries = Array.isArray(value) ? value : [value];
	const calls: PlannerToolCall[] = [];
	for (const entry of entries) {
		const call = normalizeToolCall(entry);
		if (call) {
			calls.push(call);
		}
	}
	return calls;
}

function normalizeToolCall(entry: unknown): PlannerToolCall | null {
	if (typeof entry === "string") {
		const name = entry.trim();
		return name ? { name } : null;
	}

	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return null;
	}

	const record = entry as ToolCall & Record<string, unknown>;
	const name = String(record.name ?? record.tool ?? record.action ?? "").trim();
	if (!name) {
		return null;
	}

	const args = normalizeArgs(record.args ?? record.arguments ?? record.params);
	return {
		id: typeof record.id === "string" ? record.id : undefined,
		name,
		params: args,
	};
}

function normalizeArgs(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		return parseJsonObject<Record<string, unknown>>(value) ?? undefined;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function isTerminalToolCall(toolCall: PlannerToolCall): boolean {
	return ["REPLY", "IGNORE", "STOP"].includes(toolCall.name.toUpperCase());
}

function terminalMessageFromToolCalls(
	toolCalls: PlannerToolCall[],
	fallback?: string,
): string | undefined {
	const reply = toolCalls.find(
		(toolCall) => toolCall.name.toUpperCase() === "REPLY",
	);
	const params = reply?.params;
	return (
		getNonEmptyString(params?.text ?? params?.message ?? params?.reply) ??
		fallback
	);
}

function preferRecommendedToolCall(
	trajectory: PlannerTrajectory,
	evaluator: EvaluatorOutput,
): void {
	if (evaluator.recommendedToolCallId) {
		const recommendation = evaluator.recommendedToolCallId;
		let index = trajectory.plannedQueue.findIndex(
			(toolCall) => toolCall.id === recommendation,
		);
		if (index < 0) {
			index = trajectory.plannedQueue.findIndex(
				(toolCall) => toolCall.name === recommendation,
			);
		}
		if (index > 0) {
			const [selected] = trajectory.plannedQueue.splice(index, 1);
			if (selected) {
				trajectory.plannedQueue.unshift(selected);
			}
		}
		return;
	}

	if (evaluator.nextTool) {
		const next = ensureRecommendedToolCallId(evaluator.nextTool);
		trajectory.plannedQueue.unshift(next);
	}
}

function ensureToolCallId(
	toolCall: PlannerToolCall,
	iteration: number,
	index: number,
): PlannerToolCall {
	if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
		return toolCall;
	}
	return {
		...toolCall,
		id: `tool-${iteration}-${index}`,
	};
}

function ensureRecommendedToolCallId(
	toolCall: PlannerToolCall,
): PlannerToolCall {
	if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
		return toolCall;
	}
	return {
		...toolCall,
		id: `tool-recommended-${toolCall.name}`,
	};
}

/**
 * Canonical conversion from {@link ActionResult} to {@link PlannerToolResult}.
 * Both the top-level executor and the sub-planner produce ActionResults from
 * action handlers; the planner queue consumes PlannerToolResults. Keeping the
 * mapping in one place avoids drift between the two paths.
 */
export function actionResultToPlannerToolResult(
	result: ActionResult,
): PlannerToolResult {
	const data: Record<string, unknown> = {};
	if (result.data) {
		Object.assign(data, result.data as ProviderDataRecord);
	}
	if (result.values) {
		data.values = result.values;
	}
	return {
		success: result.success,
		text: result.text,
		data: Object.keys(data).length > 0 ? data : undefined,
		error: result.error,
		continueChain: result.continueChain,
	};
}

function getNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}
