import { v5PlannerSchema, v5PlannerTemplate } from "../prompts/planner";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { ActionResult, ProviderDataRecord } from "../types/components";
import type { ContextEvent, ContextObject } from "../types/context-object";
import {
	type ChatMessage,
	type GenerateTextResult,
	ModelType,
	type PromptSegment,
	type TextGenerationModelType,
	type ToolCall,
	type ToolChoice,
	type ToolDefinition,
} from "../types/model";
import type { JsonValue } from "../types/primitives.ts";
import { computePrefixHashes } from "./context-hash";
import { appendContextEvent } from "./context-object";
import {
	buildStageChatMessages,
	cachePrefixSegments,
	normalizePromptSegments,
	renderContextObject,
} from "./context-renderer";
import { computeCallCostUsd } from "./cost-table";
import type { EvaluatorEffects, EvaluatorOutput } from "./evaluator";
import { runEvaluator } from "./evaluator";
import { parseJsonObject, stringifyForModel } from "./json-output";
import {
	assertTrajectoryLimit,
	type ChainingLoopConfig,
	countRepeatedFailures,
	type FailureLike,
	mergeChainingLoopConfig,
} from "./limits";
import {
	buildModelInputBudget,
	type ModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "./model-input-budget";
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
		archivedSteps: [],
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
				context: trajectory.context,
				trajectory,
				config,
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
			trajectory.context = {
				...trajectory.context,
				plannedQueue: [
					...(trajectory.context.plannedQueue ?? []),
					...nonTerminalCalls.map((toolCall) => ({
						id: toolCall.id,
						name: toolCall.name,
						args: stringifyForModel(toolCall.params ?? {}),
						status: "queued" as const,
						sourceStageId: `planner:${iteration}`,
					})),
				],
			};
			for (const toolCall of nonTerminalCalls) {
				trajectory.context = appendContextEvent(trajectory.context, {
					id: `queue:${toolCall.id ?? toolCall.name}:${iteration}`,
					type: "planned_tool_call",
					source: "planner-loop",
					createdAt: Date.now(),
					metadata: {
						iteration,
						toolCallId: toolCall.id,
						name: toolCall.name,
						params: stringifyForModel(toolCall.params ?? {}),
						status: "queued",
					},
				});
			}
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

		const latestStep = trajectory.steps[trajectory.steps.length - 1];
		if (latestStep?.result?.continueChain === false) {
			return {
				status: "finished",
				trajectory,
				finalMessage: latestToolResultText(trajectory),
			};
		}

		await maybeCompactBeforeNextModelCall({
			trajectory,
			config,
			tools: params.tools,
			recorder: params.recorder,
			trajectoryId: params.trajectoryId,
			parentStageId: params.parentStageId,
			iteration,
			logger: params.runtime.logger,
		});

		const evaluator = await evaluateTrajectory(params, trajectory, iteration);
		trajectory.evaluatorOutputs.push(evaluator);
		trajectory.context = appendContextEvent(trajectory.context, {
			id: `evaluation:${iteration}:${Date.now()}`,
			type: "evaluation",
			source: "planner-loop",
			createdAt: Date.now(),
			metadata: {
				iteration,
				success: evaluator.success,
				decision: evaluator.decision,
				thought: evaluator.thought,
				messageToUser: evaluator.messageToUser,
				recommendedToolCallId: evaluator.recommendedToolCallId,
			},
		});

		if (evaluator.decision === "FINISH") {
			return {
				status: "finished",
				trajectory,
				evaluator,
				finalMessage:
					evaluator.messageToUser ??
					latestToolResultText(trajectory) ??
					evaluator.thought,
			};
		}

		if (evaluator.decision === "NEXT_RECOMMENDED") {
			const selected = preferRecommendedToolCall(trajectory, evaluator);
			if (!selected) {
				params.runtime.logger?.warn?.(
					{
						recommendedToolCallId: evaluator.recommendedToolCallId,
						queuedToolCallIds: trajectory.plannedQueue.map((call) => call.id),
					},
					"Evaluator requested NEXT_RECOMMENDED without a valid queued tool; replanning",
				);
				trajectory.plannedQueue.length = 0;
			}
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

function renderPlannerModelInput(params: {
	context: ContextObject;
	trajectory: PlannerTrajectory;
	template?: string;
}): {
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const renderedContext = renderContextObject(params.context);
	const template = params.template ?? v5PlannerTemplate;
	const instructions = (
		template.split("context_object:")[0] ?? template
	).trim();
	const stepMessages = trajectoryStepsToMessages(params.trajectory.steps);
	const promptSegments = normalizePromptSegments([
		...renderedContext.promptSegments,
		{ content: `planner_stage:\n${instructions}`, stable: false },
	]);
	// Native tool-call messages: assistant (with toolCalls) + tool (result) per
	// completed step. This grows append-only across planner iterations so the
	// base prefix remains byte-identical and Cerebras's prompt cache can hit.
	// The trajectory JSON is NOT included in dynamicBlocks here — it is conveyed
	// through stepMessages (proper assistant/tool pairs). Including it as a
	// dynamic block would re-introduce the JSON-dump anti-pattern in the user
	// message and invalidate the cache prefix on every iteration.
	const messages = buildStageChatMessages({
		contextSegments: renderedContext.promptSegments,
		stageLabel: "planner_stage",
		instructions,
		dynamicBlocks: [],
		stepMessages,
	});
	return { messages, promptSegments };
}

/**
 * Convert completed trajectory steps into proper assistant/tool message pairs
 * for native tool-calling. Skips steps that lack a toolCall or result (e.g.
 * terminal-only steps). The resulting array grows append-only across planner
 * iterations, which keeps the prefix byte-identical for cache hits.
 */
export function trajectoryStepsToMessages(steps: PlannerStep[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const step of steps) {
		if (!step.toolCall || !step.result) {
			continue;
		}
		const toolCallId = stableToolCallId(step);
		// The model's prior decision: assistant message with a tool call.
		messages.push({
			role: "assistant",
			content: step.thought ?? null,
			toolCalls: [
				{
					id: toolCallId,
					type: "function",
					name: step.toolCall.name,
					arguments: JSON.stringify(step.toolCall.params ?? {}),
				},
			],
		});
		messages.push({
			role: "tool",
			toolCallId,
			name: step.toolCall.name,
			content: toolMessageContent(step.result),
		});
	}
	return messages;
}

/**
 * Stable tool-call id for an assistant turn. Prefer the model-supplied id;
 * fall back to a deterministic `tc-<iter>-<name>-<argsDigest>` so two tool
 * calls in the same iteration with different args don't collide and so
 * re-rendering the trajectory produces byte-identical assistant turns.
 */
function stableToolCallId(step: PlannerStep): string {
	if (step.toolCall?.id) {
		return step.toolCall.id;
	}
	const name = step.toolCall?.name ?? "unknown";
	const argsDigest = shortArgsDigest(step.toolCall?.params);
	return `tc-${step.iteration}-${name}-${argsDigest}`;
}

function shortArgsDigest(params: Record<string, unknown> | undefined): string {
	if (!params) return "0";
	const json = stringifyForModel(params);
	let hash = 0;
	for (let i = 0; i < json.length; i++) {
		hash = (hash * 31 + json.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * Project a PlannerToolResult to plain-text `tool` message content per OpenAI
 * conventions: prefer `result.text`, fall back to a JSON serialization of
 * `data`/`error` only when no text projection exists. Strict-grammar
 * providers (Cerebras) and Anthropic both prefer text over a JSON blob in
 * the tool turn, and this preserves byte-stability when text is consistent.
 */
function toolMessageContent(result: PlannerToolResult): string {
	const parts: string[] = [];
	if (typeof result.text === "string" && result.text.trim().length > 0) {
		parts.push(`text: ${result.text.trim()}`);
	}
	if (result.data && Object.keys(result.data).length > 0) {
		parts.push(`data: ${stringifyForModel(result.data)}`);
	}
	if (result.error) {
		const errMsg =
			typeof result.error === "string"
				? result.error
				: result.error instanceof Error
					? result.error.message
					: stringifyForModel(result.error);
		parts.push(result.success ? `note: ${errMsg}` : `error: ${errMsg}`);
	}
	if (parts.length > 0) {
		return parts.join("\n");
	}
	return result.success ? "ok" : "failed";
}

export function cacheProviderOptions(args: {
	prefixHash: string;
	segmentHashes?: readonly string[];
}): Record<string, JsonValue | object | undefined> {
	const promptCacheKey = `v5:${args.prefixHash}`.slice(0, 1024);
	return {
		eliza: {
			promptCacheKey,
			prefixHash: args.prefixHash,
			...(args.segmentHashes ? { segmentHashes: [...args.segmentHashes] } : {}),
		},
		cerebras: {
			promptCacheKey,
			prompt_cache_key: promptCacheKey,
		},
		openai: {
			promptCacheKey,
			promptCacheRetention: "24h",
		},
		// Anthropic requires explicit cache_control on stable segments.
		// plugin-anthropic reads cacheControl from anthropic providerOptions and
		// stamps it onto each stable promptSegment block. This key tells the
		// plugin which TTL to use; "5m" is the Anthropic default.
		anthropic: {
			cacheControl: { type: "ephemeral" },
		},
		// OpenRouter passes cache_control through to the underlying provider.
		// For Anthropic-backed models it forwards the anthropic cache_control;
		// for OpenAI-compat models it forwards prompt_cache_key.
		openrouter: {
			promptCacheKey,
		},
		gateway: {
			caching: "auto",
		},
	};
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
	config: ChainingLoopConfig;
	modelType?: TextGenerationModelType;
	provider?: string;
	tools?: ToolDefinition[];
	toolChoice?: ToolChoice;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration?: number;
}): Promise<ReturnType<typeof parsePlannerOutput>> {
	let renderedInput = renderPlannerModelInput({
		context: params.context,
		trajectory: params.trajectory,
	});
	let modelInputBudget = buildModelInputBudget({
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
		tools: params.tools,
		contextWindowTokens: params.config.contextWindowTokens,
		reserveTokens: params.config.compactionReserveTokens,
	});
	if (modelInputBudget.shouldCompact && params.config.compactionEnabled) {
		const compacted = await maybeCompactPlannerTrajectory({
			trajectory: params.trajectory,
			budget: modelInputBudget,
			config: params.config,
			recorder: params.recorder,
			trajectoryId: params.trajectoryId,
			parentStageId: params.parentStageId,
			iteration: params.iteration ?? 1,
			logger: params.runtime.logger,
		});
		if (compacted) {
			renderedInput = renderPlannerModelInput({
				context: params.trajectory.context,
				trajectory: params.trajectory,
			});
			modelInputBudget = buildModelInputBudget({
				messages: renderedInput.messages,
				promptSegments: renderedInput.promptSegments,
				tools: params.tools,
				contextWindowTokens: params.config.contextWindowTokens,
				reserveTokens: params.config.compactionReserveTokens,
			});
		}
	}
	const prefixHashes = computePrefixHashes(renderedInput.promptSegments);
	const cachePrefixHashes = computePrefixHashes(
		cachePrefixSegments(renderedInput.promptSegments),
	);
	const prefixHash =
		cachePrefixHashes[cachePrefixHashes.length - 1]?.hash ??
		"no-context-segments";
	const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
	const modelParams: {
		messages: ChatMessage[];
		responseSchema?: unknown;
		promptSegments: PromptSegment[];
		providerOptions: Record<string, unknown>;
		tools?: ToolDefinition[];
		toolChoice?: ToolChoice;
	} = {
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
		providerOptions: withModelInputBudgetProviderOptions(
			cacheProviderOptions({
				prefixHash,
				segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
			}),
			modelInputBudget,
		),
	};
	if (hasTools) {
		modelParams.tools = params.tools;
		modelParams.toolChoice = params.toolChoice ?? "auto";
	} else {
		modelParams.responseSchema = v5PlannerSchema;
	}

	const startedAt = Date.now();
	const modelType = params.modelType ?? ModelType.ACTION_PLANNER;
	const raw = await params.runtime.useModel(
		modelType,
		modelParams,
		params.provider,
	);
	const endedAt = Date.now();

	const parsed = parsePlannerOutput(raw);

	await recordPlannerStage({
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		iteration: params.iteration ?? 1,
		modelType,
		provider: params.provider,
		modelParams,
		raw,
		parsed,
		startedAt,
		endedAt,
		segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
		prefixHash,
		logger: params.runtime.logger,
	});

	return parsed;
}

async function maybeCompactPlannerTrajectory(args: {
	trajectory: PlannerTrajectory;
	budget: ModelInputBudget;
	config: ChainingLoopConfig;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	logger?: PlannerRuntime["logger"];
}): Promise<boolean> {
	const keepSteps = Math.max(0, Math.floor(args.config.compactionKeepSteps));
	const compactableStepCount = Math.max(
		0,
		args.trajectory.steps.length - keepSteps,
	);
	if (compactableStepCount === 0) {
		args.logger?.debug?.(
			{
				estimatedInputTokens: args.budget.estimatedInputTokens,
				compactionThresholdTokens: args.budget.compactionThresholdTokens,
				stepCount: args.trajectory.steps.length,
				keepSteps,
			},
			"Planner input crossed compaction threshold but no old steps are compactable",
		);
		return false;
	}

	const startedAt = Date.now();
	const compactedSteps = args.trajectory.steps.slice(0, compactableStepCount);
	const keptSteps = args.trajectory.steps.slice(compactableStepCount);
	const summary = buildCompactionSummary({
		compactedSteps,
		keptSteps,
		budget: args.budget,
	});
	args.trajectory.archivedSteps.push(...compactedSteps);
	args.trajectory.steps = keptSteps;
	args.trajectory.context = appendContextEvent(args.trajectory.context, {
		id: `compaction:${args.iteration}:${startedAt}`,
		type: "segment",
		source: "planner-loop",
		createdAt: startedAt,
		metadata: {
			reason: "input_budget",
			iteration: args.iteration,
			compactedStepCount: compactableStepCount,
			keptStepCount: keptSteps.length,
			estimatedInputTokens: args.budget.estimatedInputTokens,
			contextWindowTokens: args.budget.contextWindowTokens,
			reserveTokens: args.budget.reserveTokens,
			compactionThresholdTokens: args.budget.compactionThresholdTokens,
		},
		segment: {
			id: `compaction:${args.iteration}:${startedAt}`,
			label: "compaction",
			content: summary,
			stable: false,
			metadata: {
				reason: "input_budget",
				iteration: args.iteration,
				compactedStepCount: compactableStepCount,
				keptStepCount: keptSteps.length,
			},
		},
	});
	const endedAt = Date.now();
	await recordCompactionStage({
		recorder: args.recorder,
		trajectoryId: args.trajectoryId,
		parentStageId: args.parentStageId,
		iteration: args.iteration,
		startedAt,
		endedAt,
		summary,
		budget: args.budget,
		compactedStepCount: compactableStepCount,
		keptStepCount: keptSteps.length,
		logger: args.logger,
	});
	return true;
}

async function maybeCompactBeforeNextModelCall(args: {
	trajectory: PlannerTrajectory;
	config: ChainingLoopConfig;
	tools?: ToolDefinition[];
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	logger?: PlannerRuntime["logger"];
}): Promise<boolean> {
	if (!args.config.compactionEnabled) {
		return false;
	}
	const renderedInput = renderPlannerModelInput({
		context: args.trajectory.context,
		trajectory: args.trajectory,
	});
	const budget = buildModelInputBudget({
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
		tools: args.tools,
		contextWindowTokens: args.config.contextWindowTokens,
		reserveTokens: args.config.compactionReserveTokens,
	});
	if (!budget.shouldCompact) {
		return false;
	}
	return await maybeCompactPlannerTrajectory({
		trajectory: args.trajectory,
		budget,
		config: args.config,
		recorder: args.recorder,
		trajectoryId: args.trajectoryId,
		parentStageId: args.parentStageId,
		iteration: args.iteration,
		logger: args.logger,
	});
}

function buildCompactionSummary(args: {
	compactedSteps: readonly PlannerStep[];
	keptSteps: readonly PlannerStep[];
	budget: ModelInputBudget;
}): string {
	const lines = [
		"Compacted prior planner trajectory steps because estimated input approached the model context window.",
		`compacted_steps: ${args.compactedSteps.length}`,
		`kept_recent_steps_verbatim: ${args.keptSteps.length}`,
		`estimated_input_tokens_before_compaction: ${args.budget.estimatedInputTokens}`,
		`compaction_threshold_tokens: ${args.budget.compactionThresholdTokens}`,
		"",
		"Compacted step summaries:",
	];
	for (const step of args.compactedSteps) {
		lines.push(`- ${summarizePlannerStep(step)}`);
	}
	return lines.join("\n").trim();
}

function summarizePlannerStep(step: PlannerStep): string {
	const name = step.toolCall?.name ?? (step.terminalOnly ? "terminal" : "step");
	const status = step.result
		? step.result.success
			? "success"
			: "failed"
		: "no_result";
	const args =
		step.toolCall?.params && Object.keys(step.toolCall.params).length > 0
			? ` args=${compactText(stringifyForModel(step.toolCall.params), 180)}`
			: "";
	const result = step.result
		? ` result=${compactText(toolMessageContent(step.result), 360)}`
		: step.terminalMessage
			? ` message=${compactText(step.terminalMessage, 240)}`
			: "";
	return `iter ${step.iteration} ${name} ${status}${args}${result}`;
}

function compactText(value: string, maxLength: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= maxLength) {
		return text;
	}
	const headLength = Math.max(20, Math.floor(maxLength * 0.65));
	const tailLength = Math.max(20, maxLength - headLength - 24);
	return `${text.slice(0, headLength)} ...[${text.length - headLength - tailLength} chars compacted]... ${text.slice(-tailLength)}`;
}

async function recordCompactionStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	startedAt: number;
	endedAt: number;
	summary: string;
	budget: ModelInputBudget;
	compactedStepCount: number;
	keptStepCount: number;
	logger?: PlannerRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;
	try {
		const stage: RecordedStage = {
			stageId: `stage-compaction-iter-${args.iteration}-${args.startedAt}`,
			kind: "compaction",
			iteration: args.iteration,
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			tool: {
				name: "CONTEXT_COMPACTION",
				args: {
					reason: "input_budget",
					estimatedInputTokens: args.budget.estimatedInputTokens,
					contextWindowTokens: args.budget.contextWindowTokens,
					reserveTokens: args.budget.reserveTokens,
					compactionThresholdTokens: args.budget.compactionThresholdTokens,
				},
				result: {
					summary: args.summary,
					compactedStepCount: args.compactedStepCount,
					keptStepCount: args.keptStepCount,
				},
				success: true,
				durationMs: args.endedAt - args.startedAt,
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record compaction stage",
		);
	}
}

async function recordPlannerStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	modelType: TextGenerationModelType;
	provider?: string;
	modelParams: {
		messages?: ChatMessage[];
		tools?: ToolDefinition[];
		toolChoice?: ToolChoice;
		providerOptions?: Record<string, unknown>;
	};
	raw: string | GenerateTextResult;
	parsed: ReturnType<typeof parsePlannerOutput>;
	startedAt: number;
	endedAt: number;
	segmentHashes: string[];
	prefixHash: string;
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
				messages: args.modelParams.messages,
				tools: args.modelParams.tools,
				toolChoice: args.modelParams.toolChoice,
				providerOptions: args.modelParams.providerOptions,
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
			cache: {
				segmentHashes: args.segmentHashes,
				prefixHash: args.prefixHash,
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

function extractUsage(
	raw: string | GenerateTextResult,
): RecordedUsage | undefined {
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
	const cacheCreation = (usage as Record<string, unknown>)
		.cacheCreationInputTokens;
	if (typeof cacheCreation === "number") {
		out.cacheCreationInputTokens = cacheCreation;
	}
	return out;
}

function extractFinishReason(
	raw: string | GenerateTextResult,
): string | undefined {
	if (typeof raw === "string") return undefined;
	return raw.finishReason;
}

function extractModelName(
	raw: string | GenerateTextResult,
): string | undefined {
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
			context: trajectory.context,
			trajectory,
		});
	}

	return await runEvaluator({
		runtime: params.runtime,
		context: trajectory.context,
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
		const repeatedFailures = countRepeatedFailures(params.failures, failure);
		if (repeatedFailures > params.config.maxRepeatedFailures) {
			result = {
				...result,
				text:
					result.text?.trim() ||
					`Tool ${params.toolCall.name} failed repeatedly: ${stringifyForModel(
						result.error ?? "failed",
					)}`,
				data: {
					...result.data,
					repeatedFailureLimit: {
						max: params.config.maxRepeatedFailures,
						observed: repeatedFailures,
					},
				},
				continueChain: false,
			};
		}
	}

	params.trajectory.steps.push({
		iteration: params.iteration,
		toolCall: params.toolCall,
		result,
	});
	params.trajectory.context = {
		...params.trajectory.context,
		plannedQueue: (params.trajectory.context.plannedQueue ?? []).map((entry) =>
			entry.id === params.toolCall.id ||
			(!entry.id && entry.name === params.toolCall.name)
				? {
						...entry,
						status: result.success ? "completed" : "failed",
					}
				: entry,
		),
	};
	params.trajectory.context = appendContextEvent(params.trajectory.context, {
		id: `tool-result:${params.toolCall.id ?? params.toolCall.name}:${endedAt}`,
		type: "tool_result",
		source: "planner-loop",
		createdAt: endedAt,
		metadata: {
			iteration: params.iteration,
			toolCallId: params.toolCall.id,
			name: params.toolCall.name,
			params: stringifyForModel(params.toolCall.params ?? {}),
			result: stringifyForModel(result),
			status: result.success ? "completed" : "failed",
		},
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
	const name = String(
		record.name ?? record.toolName ?? record.tool ?? record.action ?? "",
	).trim();
	if (!name) {
		return null;
	}

	const args = normalizeArgs(
		record.input ?? record.args ?? record.arguments ?? record.params,
	);
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

function latestToolResultText(
	trajectory: PlannerTrajectory,
): string | undefined {
	for (const step of [...trajectory.steps].reverse()) {
		const text = step.result?.text?.trim();
		if (text) {
			return text;
		}
	}
	return undefined;
}

function preferRecommendedToolCall(
	trajectory: PlannerTrajectory,
	evaluator: EvaluatorOutput,
): boolean {
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
		return index >= 0;
	}

	return trajectory.plannedQueue.length > 0;
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
