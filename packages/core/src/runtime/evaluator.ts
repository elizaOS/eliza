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

interface ParsedEvaluatorObject {
	object: RawEvaluatorOutput | null;
	parseError?: string;
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
			conversationId: params.trajectoryId,
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
	const output = repairForwardLookingFinish(
		repairMissingEvaluatorSuccess(parseEvaluatorOutput(raw), params.trajectory),
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
				parseError: args.output.parseError,
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
	const parsedResult = getStructuredEvaluatorObject(raw);
	if (parsedResult.parseError) {
		return {
			success: false,
			decision: "CONTINUE",
			thought: `Invalid evaluator output: ${parsedResult.parseError}. Replanning from recorded tool results.`,
			parseError: parsedResult.parseError,
			raw: {},
		};
	}

	const parsed = parsedResult.object ?? {};
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

const FORWARD_LOOKING_PROMISE_PATTERNS: RegExp[] = [
	/^\s*(?:on it|got it|sure|okay|kk)[,!.\s-]/i,
	/\b(?:i'?ll|i\s+will|i'?m\s+(?:going to|about to|gonna))\s+(?:install|build|deploy|create|spawn|kick(?:ing)?\s+off|start|launch|run|do|handle|fix|update|generate|set\s+up|put|drop|grab|pull|push|send|write|make|add)/i,
	/\b(?:kick(?:ing)?\s+off|spinning\s+up|spawning|starting(?:\s+it)?(?:\s+now)?|launching|firing\s+off)\s+(?:a\s+|the\s+|task|agent|build|job|process|now)/i,
	/\bwill\s+(?:install|build|deploy|create|spawn|kick\s+off|start|launch|run|generate|fix|update|report\s+back)\b/i,
	/\babout\s+to\s+(?:install|build|deploy|create|spawn|kick|start|launch|run|generate|fix)/i,
	/\bwill\s+report\s+back\b/i,
	// Present-continuous "(verb-ing) ... now" pattern. The LLM frequently
	// closes a turn with "File exists (656 lines) — running a grep count
	// now" or "checking it now" or "computing the result now" — describing
	// work it CLAIMS to be doing this instant but never actually invoked
	// a tool for. Treat any of those gerund verbs followed by "...now" as
	// an unfulfilled promise unless the prior tool actually executed it.
	/\b(?:running|fetching|checking|computing|loading|grabbing|reading|writing|saving|searching|processing|fixing|building|installing|deploying|verifying|counting|grepping|inspecting|scanning|querying|pulling|pushing|sending)\s+[^.!?\n]{0,80}?\bnow\b/i,
	// "let me run/check/grep ..." — first-person command-form that the
	// LLM uses to imply "I'm about to do this" without actually doing it.
	/\blet\s+me\s+(?:run|check|grep|fetch|read|write|save|search|count|verify|inspect|scan|query|do|try|look|kick|spawn|start|launch|build|deploy)\b/i,
];

function isForwardLookingPromise(text: string): boolean {
	return FORWARD_LOOKING_PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Match the present-continuous file-write promise pattern, e.g.
 *   "Writing `/tmp/arxiv-grab-fixed.py` now..."
 *   "writing /tmp/X now"
 *   "Writing (bold-md-wrapped) /tmp/file now ..."
 *
 * Captures the inner path so we can cross-check it against what the
 * trajectory actually wrote. The path is unwrapped from backticks,
 * bold-markdown wrappers, or appears bare.
 */
const WRITING_PATH_NOW_PATTERN =
	/\b(?:writing|saving)\s+(?:`([^`]+)`|\*\*([^*]+?)\*\*|((?:[/~]|\.{1,2}\/)[^\s`*"'<>]+))\s+now\b/i;

function extractPromisedWritePath(text: string): string | null {
	const match = text.match(WRITING_PATH_NOW_PATTERN);
	if (!match) return null;
	const captured = match[1] ?? match[2] ?? match[3];
	if (!captured) return null;
	const trimmed = captured.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Look at every tool call in the trajectory and return true if any of
 * them either:
 *   - has `args.file_path` / `args.path` matching the promised path, OR
 *   - has `args.command` whose text contains the promised path (which
 *     covers `BASH` writes like `cat > /tmp/x <<EOF`, `tee /tmp/x`, or
 *     `> /tmp/x` redirects), AND succeeded.
 *
 * We only count successful tool results — a `BASH` that mentioned the
 * path but errored out doesn't satisfy the promise.
 */
function trajectoryWroteToPath(
	trajectory: PlannerTrajectory,
	path: string,
): boolean {
	for (const step of trajectory.steps) {
		const result = step.result;
		if (!result || result.success !== true) continue;
		const toolArgs =
			(step.toolCall as { params?: Record<string, unknown> } | undefined)
				?.params ?? {};
		const filePath = toolArgs.file_path ?? toolArgs.path;
		if (typeof filePath === "string" && filePath.trim() === path) {
			return true;
		}
		const command = toolArgs.command;
		if (typeof command === "string" && command.includes(path)) {
			return true;
		}
	}
	return false;
}

/**
 * Repair the failure mode where the evaluator picks `FINISH` but the
 * `messageToUser` is a forward-looking promise about work that hasn't been
 * executed yet (e.g. "On it — kicking off a build task now"). The prompt
 * already says "if the response would need any unexecuted tool/action side
 * effect to be true, choose CONTINUE; do not imagine the missing result",
 * but LLMs ignore that rule often enough that we enforce it server-side.
 *
 * Trigger conditions (ALL must hold):
 *   - decision === "FINISH"
 *   - messageToUser is a non-empty string
 *   - the trajectory's most-recent tool result was NOT a successful execution
 *     (so the LLM is promising something that hasn't happened yet)
 *   - messageToUser matches a forward-looking promise pattern
 *
 * When triggered, downgrade decision to "CONTINUE" and drop the hallucinated
 * messageToUser so the planner gets another turn to actually emit the
 * follow-up action.
 */
/**
 * Words that signal the work is ACTUALLY done within the message
 * (vs. a forward-looking promise). If a message contains both a
 * forward-looking phrase AND one of these markers, treat it as a
 * legitimate FINISH (the LLM is narrating "I was about to do X,
 * then I did it, here's the result").
 */
const COMPLETION_INDICATORS =
	/\b(?:done|completed|finished|verified|confirmed|here['']?s\s+(?:the|what|how)|here\s+is|results?:|output:|wrote\s+\d|saved\s+\d|exit\s+0|✓|all\s+(?:passed|set)|success(?:ful(?:ly)?)?:)\b/i;

function repairForwardLookingFinish(
	output: EvaluatorOutput,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (output.decision !== "FINISH") return output;
	if (typeof output.messageToUser !== "string") return output;
	const trimmed = output.messageToUser.trim();
	if (!trimmed) return output;

	const downgrade: EvaluatorOutput = {
		...output,
		decision: "CONTINUE",
		messageToUser: undefined,
		success: false,
	};

	// Case A: messageToUser names a specific path the LLM is "writing now"
	// but no successful tool call in the trajectory actually wrote to that
	// path. This catches the failure mode where the planner runs a bunch
	// of probing tools (some succeed, some fail), forms a diagnosis, and
	// then closes the turn with "Writing `/path/to/fix.py` now..." without
	// ever emitting the WRITE itself. Specific-path promises ignore the
	// completion-indicator gate because we have ground truth (the actual
	// trajectory tool calls) to check against.
	const promisedPath = extractPromisedWritePath(trimmed);
	if (promisedPath && !trajectoryWroteToPath(trajectory, promisedPath)) {
		return downgrade;
	}

	// Case B: messageToUser matches a generic forward-looking pattern
	// (gerund "running X now", "let me run", "on it — kicking off",
	// "i'll start", etc.) AND has no completion indicator suggesting
	// the work actually happened. We fire regardless of which tool was
	// most recent — the live failure that motivated this guard had a
	// successful READ as the latest tool, but the promised grep never
	// ran. The completion-indicator check prevents false-positives like
	// "Writing /tmp/x.py now. Done." or "On it — wait, actually it's
	// done. APK at /tmp/out.apk."
	if (
		isForwardLookingPromise(trimmed) &&
		!COMPLETION_INDICATORS.test(trimmed)
	) {
		return downgrade;
	}

	return output;
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

function getStructuredEvaluatorObject(
	raw: string | { text?: string; object?: unknown },
): ParsedEvaluatorObject {
	if (typeof raw === "string") {
		return parseEvaluatorText(raw);
	}
	if (
		raw.object &&
		typeof raw.object === "object" &&
		!Array.isArray(raw.object)
	) {
		return { object: raw.object as RawEvaluatorOutput };
	}
	if (typeof raw.text === "string") {
		return parseEvaluatorText(raw.text);
	}
	return { object: null, parseError: "missing evaluator text/object" };
}

function parseEvaluatorText(text: string): ParsedEvaluatorObject {
	const candidate = unwrapJsonFence(text.trim());
	if (!candidate) {
		return { object: null, parseError: "empty response" };
	}
	try {
		const parsed = JSON.parse(candidate);
		if (!isEvaluatorShapedObject(parsed)) {
			return {
				object: null,
				parseError: "JSON object is not evaluator-shaped",
			};
		}
		return { object: parsed };
	} catch {
		const tolerant = parseJsonObject<RawEvaluatorOutput>(candidate);
		if (isEvaluatorShapedObject(tolerant)) {
			return {
				object: null,
				parseError:
					"response contains extra text or multiple JSON objects around evaluator JSON",
			};
		}
		return { object: null, parseError: "response is not a single JSON object" };
	}
}

function unwrapJsonFence(text: string): string {
	if (!text.startsWith("```")) return text;
	const firstLineEnd = text.indexOf("\n");
	if (firstLineEnd < 0 || !text.endsWith("```")) return text;
	return text.slice(firstLineEnd + 1, -3).trim();
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
