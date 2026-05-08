import { PLAN_ACTIONS_TOOL_NAME } from "../actions/to-tool";
import { v5PlannerSchema, v5PlannerTemplate } from "../prompts/planner";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { ActionResult, ProviderDataRecord } from "../types/components";
import type { ContextEvent, ContextObjectTool } from "../types/context-object";
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
import { computePrefixHashes } from "./context-hash";
import { appendContextEvent } from "./context-object";
import {
	buildStageChatMessages,
	cachePrefixSegments,
	normalizePromptSegments,
	renderContextObject,
} from "./context-renderer";
import { computeCallCostUsd } from "./cost-table";
import { runEvaluator } from "./evaluator";
import { parseJsonObject, stringifyForModel } from "./json-output";
import {
	assertRepeatedFailureLimit,
	assertTrajectoryLimit,
	type ChainingLoopConfig,
	type FailureLike,
	mergeChainingLoopConfig,
} from "./limits";
import {
	buildModelInputBudget,
	type ModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "./model-input-budget";
import {
	cacheProviderOptions,
	toolMessageContent,
	trajectoryStepsToMessages,
} from "./planner-rendering";
import type {
	ContextObject,
	EvaluatorOutput,
	PlannerLoopParams,
	PlannerLoopResult,
	PlannerRuntime,
	PlannerStep,
	PlannerToolCall,
	PlannerToolResult,
	PlannerTrajectory,
} from "./planner-types";
import type {
	RecordedStage,
	RecordedToolCall,
	RecordedUsage,
	TrajectoryRecorder,
} from "./trajectory-recorder";

export {
	cacheProviderOptions,
	trajectoryStepsToMessages,
} from "./planner-rendering";
export type {
	ContextObject,
	EvaluatorEffects,
	EvaluatorOutput,
	PlannerLoopParams,
	PlannerLoopResult,
	PlannerRuntime,
	PlannerStep,
	PlannerToolCall,
	PlannerToolResult,
	PlannerTrajectory,
} from "./planner-types";

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
	let terminalOnlyContinuations = 0;

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
				trajectory.context = appendTerminalPlannerOutputEvent({
					context: trajectory.context,
					iteration,
					message: plannerOutput.messageToUser,
				});
				if (trajectory.steps.some((step) => step.toolCall)) {
					const evaluator = await evaluateTrajectory(
						params,
						trajectory,
						iteration,
					);
					trajectory.evaluatorOutputs.push(evaluator);
					trajectory.context = appendEvaluationEvent({
						context: trajectory.context,
						iteration,
						evaluator,
					});

					if (evaluator.decision === "FINISH") {
						return {
							status: "finished",
							trajectory,
							evaluator,
							finalMessage: userSafeFinalMessage(
								evaluator.messageToUser ??
									plannerOutput.messageToUser ??
									latestToolResultText(trajectory) ??
									evaluator.thought,
								trajectory,
							),
						};
					}

					if (evaluator.decision === "NEXT_RECOMMENDED") {
						const selected = preferRecommendedToolCall(trajectory, evaluator);
						if (!selected) {
							params.runtime.logger?.warn?.(
								{
									recommendedToolCallId: evaluator.recommendedToolCallId,
									queuedToolCallIds: trajectory.plannedQueue.map(
										(call) => call.id,
									),
								},
								"Evaluator requested NEXT_RECOMMENDED without a valid queued tool after terminal planner output; replanning",
							);
							trajectory.plannedQueue.length = 0;
						}
						continue;
					}

					terminalOnlyContinuations++;
					assertTrajectoryLimit({
						kind: "terminal_only_continuations",
						max: config.maxTerminalOnlyContinuations,
						observed: terminalOnlyContinuations,
					});
					trajectory.plannedQueue.length = 0;
					trajectory.context = appendTerminalContinuationEvent({
						context: trajectory.context,
						iteration,
						terminalOnlyContinuations,
						message: plannerOutput.messageToUser,
					});
					continue;
				}
				return {
					status: "finished",
					trajectory,
					finalMessage: userSafeFinalMessage(
						plannerOutput.messageToUser,
						trajectory,
					),
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

		const latestResult = trajectory.steps[trajectory.steps.length - 1]?.result;
		if (latestResult?.continueChain === false) {
			return {
				status: "finished",
				trajectory,
				finalMessage: latestResult.text,
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
		trajectory.context = appendEvaluationEvent({
			context: trajectory.context,
			iteration,
			evaluator,
		});

		if (evaluator.decision === "FINISH") {
			return {
				status: "finished",
				trajectory,
				evaluator,
				finalMessage: userSafeFinalMessage(
					evaluator.messageToUser ??
						latestToolResultText(trajectory) ??
						evaluator.thought,
					trajectory,
				),
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
	const availableActionsBlock = renderAvailableActionsBlock(params.context);
	const contextSegments = availableActionsBlock
		? [
				...renderedContext.promptSegments,
				{
					content: availableActionsBlock,
					stable: false,
				} satisfies PromptSegment,
			]
		: renderedContext.promptSegments;
	// The planner stage instructions are template-derived (`v5PlannerTemplate`)
	// and structurally identical across iterations and across user turns, so they
	// belong in the cached prefix. Marking the segment `stable: true` lets the
	// Anthropic provider stamp `cache_control` on this block and lets the
	// cache-key prefix extend through these instructions.
	const promptSegments = normalizePromptSegments([
		...contextSegments,
		{ content: `planner_stage:\n${instructions}`, stable: true },
	]);
	// Native tool-call messages: assistant (with toolCalls) + tool (result) per
	// completed step. This grows append-only across planner iterations so the
	// base prefix remains byte-identical and Cerebras's prompt cache can hit.
	// The trajectory JSON is NOT included in dynamicBlocks here — it is conveyed
	// through stepMessages (proper assistant/tool pairs). Including it as a
	// dynamic block would re-introduce the JSON-dump anti-pattern in the user
	// message and invalidate the cache prefix on every iteration.
	const messages = buildStageChatMessages({
		contextSegments,
		stageLabel: "planner_stage",
		instructions,
		dynamicBlocks: [],
		stepMessages,
	});
	return { messages, promptSegments };
}

function normalizePlannerToolName(name: string): string {
	return name
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

function isPlannerWrapperTool(name: string): boolean {
	return (
		normalizePlannerToolName(name) ===
		normalizePlannerToolName(PLAN_ACTIONS_TOOL_NAME)
	);
}

function compactToolParameters(parameters: unknown): unknown {
	if (!parameters || typeof parameters !== "object") {
		return undefined;
	}
	const record = parameters as {
		type?: unknown;
		properties?: unknown;
		required?: unknown;
		additionalProperties?: unknown;
	};
	return {
		...(typeof record.type === "string" ? { type: record.type } : {}),
		...(record.properties &&
		typeof record.properties === "object" &&
		!Array.isArray(record.properties)
			? { properties: record.properties }
			: {}),
		...(Array.isArray(record.required) ? { required: record.required } : {}),
		...(record.additionalProperties !== undefined
			? { additionalProperties: record.additionalProperties }
			: {}),
	};
}

function renderToolForAvailableActions(tool: ContextObjectTool): string {
	const description = tool.description?.trim();
	const parameterSummary = compactToolParameters(tool.parameters);
	const lines = [`- ${tool.name}:${description ? ` ${description}` : ""}`];
	if (parameterSummary !== undefined) {
		lines.push(`  parameters: ${JSON.stringify(parameterSummary)}`);
	}
	return lines.join("\n");
}

function renderAvailableActionsBlock(context: ContextObject): string | null {
	const parentAction =
		typeof context.metadata?.subPlannerParentAction === "string"
			? context.metadata.subPlannerParentAction
			: "";
	const inSubPlanner = parentAction.length > 0;
	const tools: ContextObjectTool[] = [];
	const seen = new Set<string>();

	for (const event of context.events ?? []) {
		if (event.type !== "tool" || !("tool" in event)) {
			continue;
		}
		const tool = event.tool as ContextObjectTool;
		if (!tool?.name || isPlannerWrapperTool(tool.name)) {
			continue;
		}
		const parentMatches =
			typeof tool.metadata?.parentAction === "string" &&
			tool.metadata.parentAction === parentAction;
		if (inSubPlanner) {
			if (event.source !== "sub-planner" && !parentMatches) {
				continue;
			}
		} else if (event.source === "sub-planner" || parentMatches) {
			continue;
		}
		const key = normalizePlannerToolName(tool.name);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		tools.push(tool);
	}

	if (tools.length === 0) {
		return null;
	}

	const scope = inSubPlanner
		? [
				`sub_planner_scope: parent=${parentAction}`,
				`Use only the child actions listed below. Do not call ${parentAction} from inside its own sub-planner.`,
				"",
			]
		: [];

	return [
		...scope,
		"# Available Actions",
		...tools.map(renderToolForAvailableActions),
	].join("\n");
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
	const trimmed = raw.trim();
	const parsedOrNull = parseJsonObject<RawPlannerOutput>(trimmed);
	if (!parsedOrNull) {
		// Non-JSON output: treat as a terminal message rather than swallowing.
		// Planners that drift to plain text would otherwise produce a no-op
		// terminal step with empty messageToUser.
		const fallback = getNonEmptyString(trimmed);
		if (fallback) {
			return {
				toolCalls: [],
				messageToUser: fallback,
				raw: { text: trimmed } as Record<string, unknown>,
			};
		}
	}
	const parsed: RawPlannerOutput = parsedOrNull ?? {};
	const messageToUser = getNonEmptyString(parsed.messageToUser ?? parsed.text);
	const rawToolCalls =
		parsed.toolCalls ??
		parsed.tools ??
		parsed.actions ??
		(parsed.action != null ? parsed : undefined);
	const toolCalls = normalizeToolCalls(rawToolCalls);
	if (toolCalls.length > 0 || messageToUser) {
		return {
			thought: typeof parsed.thought === "string" ? parsed.thought : undefined,
			toolCalls,
			messageToUser,
			raw: parsed as Record<string, unknown>,
		};
	}

	const array = parseJsonArrayFromText(raw);
	const arrayToolCalls = normalizeToolCalls(array);
	if (arrayToolCalls.length > 0) {
		return {
			thought: undefined,
			toolCalls: arrayToolCalls,
			messageToUser: undefined,
			raw: { toolCalls: array } as Record<string, unknown>,
		};
	}

	return {
		thought: typeof parsed.thought === "string" ? parsed.thought : undefined,
		toolCalls: [],
		messageToUser,
		raw: parsed as Record<string, unknown>,
	};
}

function parseJsonArrayFromText(raw: string): unknown[] | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}

	const candidates: string[] = [];
	const fullFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	candidates.push(fullFence?.[1]?.trim() ?? trimmed);

	for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
		const candidate = match[1]?.trim();
		if (candidate) {
			candidates.push(candidate);
		}
	}

	const arrayText = extractFirstJsonArray(trimmed);
	if (arrayText) {
		candidates.push(arrayText);
	}

	for (const candidate of [...new Set(candidates)]) {
		try {
			const parsed = JSON.parse(candidate);
			if (Array.isArray(parsed)) {
				return parsed;
			}
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

function extractFirstJsonArray(raw: string): string | null {
	const start = raw.indexOf("[");
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < raw.length; index++) {
		const char = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "[") {
			depth++;
			continue;
		}
		if (char !== "]") continue;
		depth--;
		if (depth === 0) {
			return raw.slice(start, index + 1);
		}
	}
	return null;
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
				promptSegments: renderedInput.promptSegments,
				provider: params.provider,
				hasTools,
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

function appendEvaluationEvent(args: {
	context: ContextObject;
	iteration: number;
	evaluator: EvaluatorOutput;
}): ContextObject {
	const createdAt = Date.now();
	return appendContextEvent(args.context, {
		id: `evaluation:${args.iteration}:${createdAt}`,
		type: "evaluation",
		source: "planner-loop",
		createdAt,
		metadata: {
			iteration: args.iteration,
			success: args.evaluator.success,
			decision: args.evaluator.decision,
			thought: args.evaluator.thought,
			messageToUser: args.evaluator.messageToUser,
			recommendedToolCallId: args.evaluator.recommendedToolCallId,
		},
	});
}

function appendTerminalPlannerOutputEvent(args: {
	context: ContextObject;
	iteration: number;
	message?: string;
}): ContextObject {
	const createdAt = Date.now();
	const unsafe = isUnsafeUserVisibleText(args.message);
	const content = [
		"planner_terminal_output:",
		compactText(args.message ?? "", 1_200),
		"",
		unsafe
			? "note: This output looked like internal planning or attempted tool-call text. It must not be shown directly to the user."
			: "note: Evaluate whether this user-visible output actually completes the request.",
	].join("\n");
	return appendContextEvent(args.context, {
		id: `terminal-planner-output:${args.iteration}:${createdAt}`,
		type: "segment",
		source: "planner-loop",
		createdAt,
		metadata: {
			iteration: args.iteration,
			unsafe,
		},
		segment: {
			id: `terminal-planner-output:${args.iteration}:${createdAt}`,
			label: "terminal_planner_output",
			content,
			stable: false,
			metadata: {
				iteration: args.iteration,
				unsafe,
			},
		},
	});
}

function appendTerminalContinuationEvent(args: {
	context: ContextObject;
	iteration: number;
	terminalOnlyContinuations: number;
	message?: string;
}): ContextObject {
	const createdAt = Date.now();
	const unsafe = isUnsafeUserVisibleText(args.message);
	const content = [
		"planner_retry_instruction:",
		`terminal_only_continuations: ${args.terminalOnlyContinuations}`,
		unsafe
			? "The previous planner output exposed internal tool planning. Emit native toolCalls for remaining work, or a concise user-safe message only if the request is complete."
			: "The evaluator found the previous terminal planner output incomplete. Emit native toolCalls for remaining work.",
	].join("\n");
	return appendContextEvent(args.context, {
		id: `terminal-planner-retry:${args.iteration}:${createdAt}`,
		type: "segment",
		source: "planner-loop",
		createdAt,
		metadata: {
			iteration: args.iteration,
			terminalOnlyContinuations: args.terminalOnlyContinuations,
			unsafe,
		},
		segment: {
			id: `terminal-planner-retry:${args.iteration}:${createdAt}`,
			label: "planner_retry_instruction",
			content,
			stable: false,
			metadata: {
				iteration: args.iteration,
				terminalOnlyContinuations: args.terminalOnlyContinuations,
				unsafe,
			},
		},
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

/**
 * The LLM sees the stable Stage 2 wrapper surface, so every action invocation
 * arrives wrapped:
 * `{ name: "PLAN_ACTIONS", args: { action, subaction?, parameters, thought } }`.
 * Holding the tool list fixed keeps prompt-cache hashes stable across requests
 * no matter which actions are gated this turn.
 *
 * We unwrap at the parse boundary so all downstream logic — context-event
 * lookup, trajectory recording, terminal sentinels (REPLY/IGNORE/STOP),
 * failure attribution — sees the actual action name, not the wrapper.
 *
 * The `subaction` hint is preserved on `params.subaction` for router-style
 * actions.
 */

function normalizeToolCall(entry: unknown): PlannerToolCall | null {
	if (typeof entry === "string") {
		const name = normalizeToolCallName(entry);
		return name ? { name } : null;
	}

	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return null;
	}

	const record = entry as ToolCall & Record<string, unknown>;
	const rawFunction =
		record.function && typeof record.function === "object"
			? (record.function as Record<string, unknown>)
			: null;
	const functionName =
		typeof record.function === "string" ? record.function : rawFunction?.name;
	const name = normalizeToolCallName(
		record.name ??
			record.toolName ??
			record.tool ??
			record.action ??
			record.actionName ??
			functionName ??
			"",
	);
	if (!name) {
		return null;
	}

	const args = normalizeArgs(
		record.input ??
			record.args ??
			record.arguments ??
			record.params ??
			record.parameters ??
			rawFunction?.input ??
			rawFunction?.args ??
			rawFunction?.arguments ??
			rawFunction?.params ??
			rawFunction?.parameters,
	);

	if (name.toUpperCase() === PLAN_ACTIONS_TOOL_NAME) {
		const inner = args ?? {};
		const actionName =
			typeof inner.action === "string" ? inner.action.trim() : "";
		if (!actionName) {
			return null;
		}
		const subaction =
			typeof inner.subaction === "string" && inner.subaction.trim().length > 0
				? inner.subaction.trim()
				: undefined;
		const baseParameters =
			inner.parameters &&
			typeof inner.parameters === "object" &&
			!Array.isArray(inner.parameters)
				? (inner.parameters as Record<string, unknown>)
				: {};
		const actionParameters: Record<string, unknown> = subaction
			? { ...baseParameters, subaction }
			: baseParameters;
		return {
			id: typeof record.id === "string" ? record.id : undefined,
			name: actionName,
			params: actionParameters,
		};
	}

	return {
		id: typeof record.id === "string" ? record.id : undefined,
		name,
		params: args,
	};
}

function normalizeToolCallName(value: unknown): string {
	const raw = String(value ?? "").trim();
	if (!raw) return "";
	const withoutPrefix = raw.replace(/^(?:functions?|tools?)\./i, "");
	return withoutPrefix.trim();
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

function userSafeFinalMessage(
	message: string | undefined,
	trajectory: PlannerTrajectory,
): string | undefined {
	const candidate = getNonEmptyString(message);
	if (candidate && !isUnsafeUserVisibleText(candidate)) {
		return candidate;
	}
	const latest = latestToolResultText(trajectory);
	if (latest && !isUnsafeUserVisibleText(latest)) {
		return latest;
	}
	return candidate ? "I handled the available step." : undefined;
}

function isUnsafeUserVisibleText(value: string | undefined): boolean {
	if (!value) return false;
	const text = value.trim();
	if (!text) return false;
	return [
		/\bto=functions\.[A-Z0-9_]+\b/i,
		/\bfunctions\.[A-Z0-9_]+\b/i,
		/"action"\s*:\s*"functions\.[A-Z0-9_]+"/i,
		/\b(?:tool|function)\s+calls?\b/i,
		/\b(?:I|we)\s+(?:need|should|must|will)\s+to\s+(?:call|use|invoke|issue|perform)\b/i,
		/\b(?:call|use|invoke)\s+[A-Z][A-Z0-9_]{2,}\b/,
		/\b(?:MESSAGE\s+operation|operation=(?:draft_reply|respond|send_draft|triage|list_inbox))\b/i,
		/\{\s*"parameters"\s*:/i,
	].some((pattern) => pattern.test(text));
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
