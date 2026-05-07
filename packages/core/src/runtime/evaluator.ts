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
import { renderContextObject } from "./context-renderer";
import { computeCallCostUsd } from "./cost-table";
import { parseJsonObject, stringifyForModel } from "./json-output";
import type {
	ContextObject,
	PlannerToolCall,
	PlannerTrajectory,
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
			prompt: string;
			messages?: ChatMessage[];
			responseSchema?: unknown;
			promptSegments?: PromptSegment[];
			providerOptions?: Record<string, unknown>;
		},
		provider?: string,
	): Promise<string | { text?: string; object?: unknown }>;
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
	prompt?: string;
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
	const renderedInput = params.prompt
		? renderModelInputFromPrompt(params.prompt)
		: renderEvaluatorModelInput({
				context: params.context,
				trajectory: params.trajectory,
			});
	const prompt = renderedInput.prompt;
	const prefixHashes = computePrefixHashes(renderedInput.promptSegments);
	const cachePrefixHashes = computePrefixHashes(
		cachePrefixSegments(renderedInput.promptSegments),
	);
	const prefixHash =
		cachePrefixHashes[cachePrefixHashes.length - 1]?.hash ??
		"no-context-segments";
	const startedAt = Date.now();
	const modelType = params.modelType ?? ModelType.RESPONSE_HANDLER;
	const raw = await params.runtime.useModel(
		modelType,
		{
			prompt,
			messages: renderedInput.messages,
			responseSchema: v5EvaluatorSchema,
			promptSegments: renderedInput.promptSegments,
			providerOptions: cacheProviderOptions({
				prefixHash,
				segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
			}),
		},
		params.provider,
	);
	const endedAt = Date.now();
	const output = parseEvaluatorOutput(raw);
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
		prompt,
		messages: renderedInput.messages,
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
	prompt: string;
	messages?: ChatMessage[];
	raw: string | { text?: string; object?: unknown };
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
				provider: args.provider ?? "default",
				prompt: args.prompt,
				messages: args.messages,
				response: responseText,
				usage,
				costUsd: usage ? computeCallCostUsd(undefined, usage) : undefined,
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

export function renderEvaluatorPrompt(params: {
	context: ContextObject;
	trajectory: PlannerTrajectory;
	template?: string;
}): string {
	return renderEvaluatorModelInput(params).prompt;
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
	const trajectory = stringifyForModel(params.trajectory);
	const template = params.template ?? v5EvaluatorTemplate;
	const instructions = (
		template.split("context_object:")[0] ?? template
	).trim();
	const trajectoryContent = `trajectory:\n${trajectory}`;
	const promptSegments = normalizePromptSegments([
		...renderedContext.promptSegments,
		{ content: `evaluator_stage:\n${instructions}`, stable: false },
		{ content: trajectoryContent, stable: false },
	]);
	const prompt = promptSegments.map((segment) => segment.content).join("");
	const messages: ChatMessage[] = [
		...toChatMessages(renderedContext.messages),
		{ role: "system", content: `evaluator_stage:\n${instructions}` },
		{ role: "user", content: trajectoryContent },
	];
	return { prompt, messages, promptSegments };
}

function renderModelInputFromPrompt(prompt: string): {
	prompt: string;
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	return renderMessagesFromPrompt(prompt, [{ content: prompt, stable: false }]);
}

function renderMessagesFromPrompt(
	prompt: string,
	promptSegments: PromptSegment[],
): {
	prompt: string;
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const contextStart = prompt.indexOf("context_object:");
	const systemContent =
		contextStart > 0 ? prompt.slice(0, contextStart).trimEnd() : prompt;
	const userContent =
		contextStart > 0 ? prompt.slice(contextStart).trimStart() : prompt;
	const messages: ChatMessage[] =
		contextStart > 0
			? [
					{ role: "system", content: systemContent },
					{ role: "user", content: userContent },
				]
			: [{ role: "user", content: prompt }];
	return { prompt, messages, promptSegments };
}

function compactPromptSegments(segments: PromptSegment[]): PromptSegment[] {
	return segments.filter((segment) => segment.content.length > 0);
}

function normalizePromptSegments(segments: PromptSegment[]): PromptSegment[] {
	return compactPromptSegments(
		segments.map((segment, index) => ({
			...segment,
			content: `${index === 0 ? "" : "\n\n"}${segment.content.trim()}`,
		})),
	);
}

function toChatMessages(
	messages: Array<{
		role: string;
		content?: unknown;
		name?: string;
		toolCallId?: string;
	}>,
): ChatMessage[] {
	return messages.map((message) => {
		const role =
			message.role === "system" ||
			message.role === "developer" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "tool"
				? message.role
				: "system";
		const content =
			typeof message.content === "string"
				? message.content
				: message.content == null
					? null
					: stringifyForModel(message.content);
		return {
			role,
			content,
			...(message.name ? { name: message.name } : {}),
			...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
		};
	});
}

function cachePrefixSegments(segments: PromptSegment[]): PromptSegment[] {
	const prefix: PromptSegment[] = [];
	for (const segment of segments) {
		if (!segment.stable) break;
		prefix.push(segment);
	}
	return prefix.length > 0 ? prefix : segments.slice(0, 1);
}

function cacheProviderOptions(args: {
	prefixHash: string;
	segmentHashes?: readonly string[];
}): Record<string, unknown> {
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
		gateway: {
			caching: "auto",
		},
	};
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
