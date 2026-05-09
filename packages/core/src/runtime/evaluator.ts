import { evaluatorSchema, evaluatorTemplate } from "../prompts/evaluator";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { EvaluationResult } from "../types/components";
import {
	type ChatMessage,
	ModelType,
	type PromptSegment,
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
import {
	cacheProviderOptions,
	trajectoryStepsToMessages,
} from "./planner-rendering";
import type {
	ContextObject,
	EvaluatorEffects,
	EvaluatorOutput,
	EvaluatorRoute,
	EvaluatorRuntime,
	PlannerToolCall,
	PlannerTrajectory,
	RunEvaluatorParams,
} from "./planner-types";
import type {
	RecordedStage,
	RecordedUsage,
	TrajectoryRecorder,
} from "./trajectory-recorder";

export type {
	EvaluatorEffects,
	EvaluatorOutput,
	EvaluatorRoute,
	EvaluatorRuntime,
	RunEvaluatorParams,
} from "./planner-types";

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
			promptSegments: renderedInput.promptSegments,
			provider: params.provider,
		}),
		modelInputBudget,
	);
	const startedAt = Date.now();
	const modelType = params.modelType ?? ModelType.RESPONSE_HANDLER;
	const raw = await params.runtime.useModel(
		modelType,
		{
			messages: renderedInput.messages,
			responseSchema: evaluatorSchema,
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
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const renderedContext = renderContextObject(params.context);
	const template = params.template ?? evaluatorTemplate;
	const instructions = (
		template.split("context_object:")[0] ?? template
	).trim();
	const stepMessages = trajectoryStepsToMessages(params.trajectory.steps);
	// Mirrors planner-loop: the evaluator stage instructions are template-derived
	// (`evaluatorTemplate`) and structurally identical across calls. Marking
	// the segment `stable: true` makes them cacheable on Anthropic's wire path.
	const promptSegments = normalizePromptSegments([
		...renderedContext.promptSegments,
		{ content: `evaluator_stage:\n${instructions}`, stable: true },
	]);
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
	return { messages, promptSegments };
}

export function parseEvaluatorOutput(
	raw: string | { text?: string; object?: unknown },
): EvaluatorOutput {
	const parsed = getStructuredEvaluatorObject(raw) ?? {};
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

function isEvaluatorShapedObject(value: unknown): value is RawEvaluatorOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return "success" in record || "decision" in record || "route" in record;
}

function parseJsonObjects<T extends object>(raw: string): T[] {
	const objects: T[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < raw.length; index++) {
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
		if (char === "{") {
			if (depth === 0) start = index;
			depth++;
			continue;
		}
		if (char !== "}") continue;
		depth--;
		if (depth !== 0 || start < 0) continue;
		try {
			const parsed = JSON.parse(raw.slice(start, index + 1));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				objects.push(parsed as T);
			}
		} catch {
			// Ignore malformed embedded JSON and keep scanning for later objects.
		}
		start = -1;
	}

	return objects;
}

function getStructuredEvaluatorObject(
	raw: string | { text?: string; object?: unknown },
): RawEvaluatorOutput | null {
	if (typeof raw === "string") {
		return parseEvaluatorText(raw);
	}
	if (
		raw.object &&
		typeof raw.object === "object" &&
		!Array.isArray(raw.object)
	) {
		return raw.object as RawEvaluatorOutput;
	}
	if (typeof raw.text === "string") {
		return parseEvaluatorText(raw.text);
	}
	return null;
}

function parseEvaluatorText(text: string): RawEvaluatorOutput | null {
	const direct = parseJsonObject<RawEvaluatorOutput>(text);
	if (isEvaluatorShapedObject(direct)) return direct;

	const objects = parseJsonObjects<RawEvaluatorOutput>(text);
	for (let index = objects.length - 1; index >= 0; index--) {
		const object = objects[index];
		if (!isEvaluatorShapedObject(object)) continue;
		const hasEarlierNonEvaluatorJson = objects
			.slice(0, index)
			.some((candidate) => !isEvaluatorShapedObject(candidate));
		const decision = normalizeEvaluatorRoute(object.decision ?? object.route);
		if (
			hasEarlierNonEvaluatorJson &&
			object.success === true &&
			decision === "FINISH"
		) {
			return {
				success: false,
				decision: "CONTINUE",
				thought:
					"Evaluator emitted non-evaluator JSON before claiming completion; ignore the claimed finish and replan from recorded tool results.",
			};
		}
		return object;
	}
	return direct;
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
