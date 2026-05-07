import { v5EvaluatorSchema, v5EvaluatorTemplate } from "../prompts/evaluator";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { EvaluationResult } from "../types/components";
import {
	type ChatMessage,
	ModelType,
	type PromptSegment,
	type TextGenerationModelType,
} from "../types/model";
import { computePrefixHashes } from "./context-hash";
import {
	buildStageChatMessages,
	cachePrefixSegments,
	normalizePromptSegments,
	renderContextObject,
} from "./context-renderer";
import { computeCallCostUsd } from "./cost-table";
import { parseJsonObject } from "./json-output";
import {
	buildModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "./model-input-budget";
import type {
	ContextObject,
	PlannerToolCall,
	PlannerTrajectory,
} from "./planner-loop";
import {
	cacheProviderOptions,
	trajectoryStepsToMessages,
} from "./planner-loop";
import type {
	RecordedStage,
	RecordedUsage,
	TrajectoryRecorder,
} from "./trajectory-recorder";

export type EvaluatorRoute = EvaluationResult["decision"];

export interface EvaluatorRuntime {
	useModel(
		modelType: TextGenerationModelType,
		params: {
			prompt?: string;
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
	raw?: Record<string, unknown>;
};

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

interface RawEvaluatorOutput {
	success?: unknown;
	decision?: unknown;
	route?: unknown;
	thought?: unknown;
	nextTool?: unknown;
	nextRecommendedTool?: unknown;
	messageToUser?: unknown;
	copyToClipboard?: unknown;
	recommendedToolCallId?: unknown;
}

export async function runEvaluator(
	params: RunEvaluatorParams,
): Promise<EvaluatorOutput> {
	const renderedInput = renderEvaluatorModelInput({
		context: params.context,
		trajectory: params.trajectory,
	});
	const prefixHashes = computePrefixHashes(renderedInput.promptSegments);
	const cachePrefixHashes = computePrefixHashes(
		cachePrefixSegments(renderedInput.promptSegments),
	);
	const prefixHash =
		cachePrefixHashes[cachePrefixHashes.length - 1]?.hash ??
		"no-context-segments";
	const modelInputBudget = buildModelInputBudget({
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
	});
	const providerOptions = withModelInputBudgetProviderOptions(
		cacheProviderOptions({
			prefixHash,
			segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
		}),
		modelInputBudget,
	);
	const startedAt = Date.now();
	const modelType = params.modelType ?? ModelType.RESPONSE_HANDLER;
	const raw = await params.runtime.useModel(
		modelType,
		{
			prompt: renderedInput.prompt,
			messages: renderedInput.messages,
			responseSchema: v5EvaluatorSchema,
			promptSegments: renderedInput.promptSegments,
			providerOptions,
		},
		params.provider,
	);
	const endedAt = Date.now();
	const output = repairMissingEvaluatorSuccess(
		parseEvaluatorOutput(raw),
		params.trajectory,
	);
	const streamingContext = getStreamingContext();
	await emitStreamingHook(streamingContext, "onEvaluation", {
		evaluation: output,
		messageId: streamingContext?.messageId,
	});
	await applyEvaluatorEffects(output, params.effects);

	await recordEvaluationStage({
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		iteration: params.iteration ?? 1,
		modelType: String(modelType),
		provider: params.provider,
		prompt: renderedInput.prompt,
		messages: renderedInput.messages,
		providerOptions,
		raw,
		output,
		startedAt,
		endedAt,
		segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
		prefixHash,
		logger: params.runtime.logger,
	});

	return output;
}

async function recordEvaluationStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	modelType: string;
	provider?: string;
	prompt?: string;
	messages?: ChatMessage[];
	providerOptions?: Record<string, unknown>;
	raw: string | { text?: string; object?: unknown; providerMetadata?: unknown };
	output: EvaluatorOutput;
	startedAt: number;
	endedAt: number;
	segmentHashes: string[];
	prefixHash: string;
	logger?: EvaluatorRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;
	try {
		const responseText =
			typeof args.raw === "string"
				? args.raw
				: typeof args.raw.text === "string"
					? args.raw.text
					: JSON.stringify(args.raw.object ?? {});
		const usage = extractEvaluatorUsage(args.raw);
		const modelName = extractEvaluatorModelName(args.raw);
		const stage: RecordedStage = {
			stageId: `stage-eval-iter-${args.iteration}-${args.startedAt}`,
			kind: "evaluation",
			iteration: args.iteration,
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			model: {
				modelType: args.modelType,
				modelName,
				provider: args.provider ?? "default",
				prompt: args.prompt,
				messages: args.messages,
				tools: [],
				toolCalls: [],
				providerOptions: args.providerOptions,
				response: responseText,
				usage,
				costUsd: usage ? computeCallCostUsd(modelName, usage) : undefined,
			},
			evaluation: {
				success: args.output.success,
				decision: args.output.decision,
				thought: args.output.thought,
				messageToUser: args.output.messageToUser,
				copyToClipboard: args.output.copyToClipboard,
				recommendedToolCallId: args.output.recommendedToolCallId,
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
			"[TrajectoryRecorder] failed to record evaluation stage",
		);
	}
}

function extractEvaluatorModelName(
	raw: string | { providerMetadata?: unknown },
): string | undefined {
	if (typeof raw === "string") return undefined;
	const meta = raw.providerMetadata;
	if (meta && typeof meta === "object" && !Array.isArray(meta)) {
		const direct = (meta as Record<string, unknown>).modelName;
		if (typeof direct === "string") return direct;
		const model = (meta as Record<string, unknown>).model;
		if (typeof model === "string") return model;
	}
	return undefined;
}

function extractEvaluatorUsage(
	raw: string | { text?: string; object?: unknown; usage?: unknown },
): RecordedUsage | undefined {
	if (typeof raw === "string") return undefined;
	const usage = (raw as Record<string, unknown>).usage as
		| Record<string, unknown>
		| undefined;
	if (!usage) return undefined;
	const promptTokens = (usage.promptTokens as number | undefined) ?? 0;
	const completionTokens = (usage.completionTokens as number | undefined) ?? 0;
	const totalTokens =
		(usage.totalTokens as number | undefined) ??
		promptTokens + completionTokens;
	const out: RecordedUsage = {
		promptTokens,
		completionTokens,
		totalTokens,
	};
	if (typeof usage.cacheReadInputTokens === "number") {
		out.cacheReadInputTokens = usage.cacheReadInputTokens;
	} else if (typeof usage.cachedPromptTokens === "number") {
		out.cacheReadInputTokens = usage.cachedPromptTokens;
	}
	if (typeof usage.cacheCreationInputTokens === "number") {
		out.cacheCreationInputTokens = usage.cacheCreationInputTokens;
	}
	return out;
}

function renderEvaluatorModelInput(params: {
	context: ContextObject;
	trajectory: PlannerTrajectory;
	template?: string;
}): {
	prompt: string;
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const renderedContext = renderContextObject(params.context);
	const template = params.template ?? v5EvaluatorTemplate;
	const instructions = (
		template.split("context_object:")[0] ?? template
	).trim();
	const stepMessages = trajectoryStepsToMessages(params.trajectory.steps);
	const promptSegments = normalizePromptSegments([
		...renderedContext.promptSegments,
		{ content: `evaluator_stage:\n${instructions}`, stable: false },
	]);
	const prompt = promptSegments.map((segment) => segment.content).join("");
	// Use proper assistant/tool message pairs so the evaluator sees the same
	// native tool-calling format as the planner. The trajectory JSON is NOT
	// included in dynamicBlocks — it is conveyed through stepMessages.
	const messages = buildStageChatMessages({
		contextSegments: renderedContext.promptSegments,
		stageLabel: "evaluator_stage",
		instructions,
		dynamicBlocks: [],
		stepMessages,
	});
	return { prompt, messages, promptSegments };
}

export function parseEvaluatorOutput(
	raw: string | { text?: string; object?: unknown },
): EvaluatorOutput {
	const parsed = getStructuredObject<RawEvaluatorOutput>(raw) ?? {};
	const decision = normalizeEvaluatorRoute(parsed.decision ?? parsed.route);
	return {
		success: parsed.success === true,
		decision,
		thought: typeof parsed.thought === "string" ? parsed.thought : "",
		nextTool: normalizeNextTool(parsed.nextTool ?? parsed.nextRecommendedTool),
		messageToUser:
			typeof parsed.messageToUser === "string" &&
			parsed.messageToUser.trim().length > 0
				? parsed.messageToUser
				: undefined,
		copyToClipboard: normalizeClipboard(parsed.copyToClipboard),
		recommendedToolCallId:
			typeof parsed.recommendedToolCallId === "string"
				? parsed.recommendedToolCallId
				: undefined,
		raw: parsed as Record<string, unknown>,
	};
}

function repairMissingEvaluatorSuccess(
	output: EvaluatorOutput,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (output.raw && Object.hasOwn(output.raw, "success")) {
		return output;
	}
	if (output.decision !== "FINISH") {
		return output;
	}
	const latestStep = [...trajectory.steps]
		.reverse()
		.find((step) => step.toolCall && step.result);
	if (latestStep?.result?.success !== true) {
		return output;
	}
	return {
		...output,
		success: true,
	};
}

export async function applyEvaluatorEffects(
	output: EvaluatorOutput,
	effects?: EvaluatorEffects,
): Promise<void> {
	if (output.copyToClipboard && effects?.copyToClipboard) {
		await effects.copyToClipboard(output.copyToClipboard);
	}
	if (output.messageToUser && effects?.messageToUser) {
		await effects.messageToUser(output.messageToUser);
	}
}

export function normalizeEvaluatorRoute(route: unknown): EvaluatorRoute {
	const normalized = String(route ?? "")
		.trim()
		.toUpperCase();
	if (
		normalized === "FINISH" ||
		normalized === "NEXT_RECOMMENDED" ||
		normalized === "CONTINUE"
	) {
		return normalized;
	}
	return "CONTINUE";
}

function getStructuredObject<T extends object>(
	raw: string | { text?: string; object?: unknown },
): T | null {
	if (typeof raw === "string") {
		return parseJsonObject<T>(raw);
	}
	if (
		raw.object &&
		typeof raw.object === "object" &&
		!Array.isArray(raw.object)
	) {
		return raw.object as T;
	}
	if (typeof raw.text === "string") {
		return parseJsonObject<T>(raw.text);
	}
	return null;
}

function normalizeNextTool(value: unknown): PlannerToolCall | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const name = String(record.name ?? record.tool ?? record.action ?? "").trim();
	if (!name) {
		return undefined;
	}

	const params =
		record.args && typeof record.args === "object"
			? (record.args as Record<string, unknown>)
			: record.params && typeof record.params === "object"
				? (record.params as Record<string, unknown>)
				: undefined;
	return { name, params };
}

function normalizeClipboard(
	value: unknown,
): EvaluationResult["copyToClipboard"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const content =
		typeof record.content === "string" ? record.content.trim() : "";
	if (!title || !content) {
		return undefined;
	}
	const tags = Array.isArray(record.tags)
		? record.tags.map((tag) => String(tag).trim()).filter(Boolean)
		: undefined;
	return {
		title,
		content,
		...(tags && tags.length > 0 ? { tags } : {}),
	};
}
