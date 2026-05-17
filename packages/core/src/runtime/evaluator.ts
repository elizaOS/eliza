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
import { extractJsonObjects, parseJsonObject } from "./json-output";
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
	const output = sanitizeOutputMessage(
		repairFinishedToolTurnWithoutUserMessage(
			repairMissingEvaluatorMessage(
				repairMissingEvaluatorSuccess(
					recoverEvaluatorTextOutput(
						parseEvaluatorOutput(raw),
						raw,
						params.trajectory,
					),
					params.trajectory,
				),
				params.context,
				params.trajectory,
			),
			params.trajectory,
		),
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

/**
 * Patterns that match internal orchestration mechanics the LLM
 * sometimes echoes into `messageToUser` after a TASKS / sub-agent
 * spawn. They expose implementation details (auto-generated agent
 * labels, raw PTY session IDs, multi-agent enumeration verbiage) and
 * read as robotic to the human on the other end of the chat.
 *
 * Each pattern is conservative: it targets a parenthetical / inline
 * annotation that the LLM appends as metadata, not the surrounding
 * natural language. The replacement either drops the parenthetical
 * entirely or substitutes a neutral phrase, then collapses any
 * doubled whitespace.
 */
// Orchestrator auto-generated task labels always have at least two
// hyphen-separated word segments before the trailing index (e.g.
// "count-py-files-projects-1", "write-arxiv-grab-py-1"). Requiring
// `{2,}` segments here is what keeps the sanitizer from eating
// legitimate parentheticals the LLM might write — "(bug-42)",
// "(phase-1)", "(rfc-2616)", "(attempt-3)" — none of which match.
const AUTO_LABEL = /(?:[a-z][a-z0-9]*-){2,}\d+/.source;

const INTERNAL_MECHANIC_PATTERNS: ReadonlyArray<{
	pattern: RegExp;
	replacement: string;
}> = [
	// "(session: pty-1778500471501-4cf0e3a6)", "(session pty-...)"
	{
		pattern: /\s*\((?:session(?:[- _]?id)?\s*[:=]?\s*)?pty-\d+-[A-Za-z0-9]+\)/g,
		replacement: "",
	},
	// Bare session IDs "pty-1778500471501-4cf0e3a6" anywhere in the
	// message — `\s*` so the strip still fires at position 0.
	{ pattern: /\s*pty-\d+-[A-Za-z0-9]+/g, replacement: "" },
	// "(session write-arxiv-grab-py-1)" / "(write-arxiv-grab-py-1)" /
	// "(count-py-files-projects-1 and count-ts-files-iqlabs-1)" —
	// auto-generated labels in parens.
	{
		pattern: new RegExp(
			`\\s*\\((?:session\\s*[:=]?\\s*|sessions?\\s+)?${AUTO_LABEL}(?:\\s+and\\s+${AUTO_LABEL})*\\)`,
			"g",
		),
		replacement: "",
	},
	// "session write-arxiv-grab-py-1" inline (no parens).
	{
		pattern: new RegExp(`\\s+session\\s+${AUTO_LABEL}`, "g"),
		replacement: "",
	},
	// "task-agent / task_agent / subagent" mechanic phrases that
	// surface as "task-agent count-py-files-projects-1" right before
	// a label. Drop the prefix; keep "agent" in the natural-language
	// sense by mapping to "agent" only when the label follows.
	{
		pattern: new RegExp(`\\b(?:task[-_]agent|subagent)\\s+${AUTO_LABEL}`, "g"),
		replacement: "agent",
	},
];

function sanitizeMessageToUser(text: string): string {
	let cleaned = text;
	for (const { pattern, replacement } of INTERNAL_MECHANIC_PATTERNS) {
		cleaned = cleaned.replace(pattern, replacement);
	}
	// Collapse multiple spaces introduced by the substitutions and
	// trim trailing space before punctuation (", ." -> ".").
	cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
	cleaned = cleaned.replace(/\s+([.,!?:;])/g, "$1");
	return cleaned.trim();
}

function sanitizeOutputMessage(output: EvaluatorOutput): EvaluatorOutput {
	if (typeof output.messageToUser !== "string") return output;
	const sanitized = sanitizeMessageToUser(output.messageToUser);
	if (sanitized === output.messageToUser) return output;
	if (sanitized.length === 0) {
		// If sanitization removed everything, drop messageToUser so the
		// runtime doesn't post an empty Discord message.
		return { ...output, messageToUser: undefined };
	}
	return { ...output, messageToUser: sanitized };
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

function repairMissingEvaluatorMessage(
	output: EvaluatorOutput,
	context: ContextObject,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (typeof output.messageToUser === "string") return output;
	if (output.success !== true || output.decision !== "FINISH") return output;
	const command = latestSafeCommandForUser(context, trajectory);
	if (hasSuccessfulToolResult(trajectory) && !command) return output;
	const thought = output.thought.trim();
	if (!looksLikeUserFacingAnswer(thought)) return output;

	const messageToUser =
		command && !thought.includes(command)
			? `Command run: \`${command}\`\n\n${thought}`
			: thought;
	return {
		...output,
		messageToUser,
	};
}

function repairFinishedToolTurnWithoutUserMessage(
	output: EvaluatorOutput,
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (typeof output.messageToUser === "string") return output;
	if (output.success !== true || output.decision !== "FINISH") return output;
	const latestStep = [...trajectory.steps]
		.reverse()
		.find((step) => step.toolCall && step.result);
	if (!latestStep?.result || latestStep.result.success !== true) return output;
	if (latestStep.result.userFacingText?.trim()) return output;
	return {
		...output,
		success: false,
		decision: "CONTINUE",
		thought:
			"Evaluator finished without a user-facing message; replanning from recorded tool results.",
	};
}

function recoverEvaluatorTextOutput(
	output: EvaluatorOutput,
	raw: string | { text?: string; object?: unknown },
	trajectory: PlannerTrajectory,
): EvaluatorOutput {
	if (!output.parseError) return output;
	const text = rawText(raw).trim();
	if (!text) return output;

	if (containsToolAttemptObject(text)) {
		return {
			success: false,
			decision: "CONTINUE",
			thought:
				"Evaluator emitted tool/action syntax instead of evaluator JSON; replanning from recorded tool results.",
			raw: { recoverySource: "tool_attempt_text" },
		};
	}

	if (!hasSuccessfulToolResult(trajectory)) return output;
	if (!looksLikeUserFacingAnswer(text)) return output;

	return {
		success: true,
		decision: "FINISH",
		thought:
			"Recovered user-facing evaluator prose after a successful tool result.",
		messageToUser: text,
		raw: { recoverySource: "prose_after_successful_tool" },
	};
}

function rawText(raw: string | { text?: string; object?: unknown }): string {
	if (typeof raw === "string") return raw;
	if (typeof raw.text === "string") return raw.text;
	return "";
}

function hasSuccessfulToolResult(trajectory: PlannerTrajectory): boolean {
	return trajectory.steps.some((step) => step.result?.success === true);
}

function containsToolAttemptObject(text: string): boolean {
	for (const objectText of extractJsonObjects(text)) {
		try {
			const parsed = JSON.parse(objectText);
			if (isToolAttemptObject(parsed)) return true;
		} catch {}
	}
	return false;
}

function isToolAttemptObject(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	const name = record.name ?? record.tool ?? record.action;
	if (typeof name !== "string" || name.trim().length === 0) {
		return false;
	}
	if (isEvaluatorShapedObject(record)) {
		return false;
	}
	return (
		"parameters" in record ||
		"params" in record ||
		"args" in record ||
		"command" in record ||
		"arguments" in record
	);
}

function looksLikeUserFacingAnswer(text: string): boolean {
	if (text.length < 8 || text.length > 4000) return false;
	if (looksLikeRawToolTranscript(text)) return false;
	if (/\{\s*"(?:action|tool|name|parameters|command)"\s*:/i.test(text)) {
		return false;
	}
	if (
		/\b(?:need|needs|should|must|will)\s+(?:to\s+)?(?:run|call|use|invoke|execute)\b/i.test(
			text,
		)
	) {
		return false;
	}
	if (/\b(?:cannot|can't)\s+(?:answer|finish|complete)\b/i.test(text)) {
		return false;
	}
	return true;
}

function looksLikeRawToolTranscript(text: string): boolean {
	return /\[(?:exit\s+\d+|timeout\s+\d+ms)\]|\(cwd=|---\s+(?:stdout|stderr)\s+---/i.test(
		text,
	);
}

function latestSafeCommandForUser(
	context: ContextObject,
	trajectory: PlannerTrajectory,
): string | undefined {
	if (!latestUserAskedForCommandEcho(context)) return undefined;
	for (const step of [...trajectory.steps].reverse()) {
		const command = step.toolCall?.params?.command;
		if (typeof command !== "string") continue;
		const trimmed = command.trim();
		if (isSafeCommandEcho(trimmed)) return trimmed;
	}
	return undefined;
}

function latestUserAskedForCommandEcho(context: ContextObject): boolean {
	const latestUserText = [...context.events]
		.reverse()
		.map((event) => messageEventContent(event))
		.find((content) => typeof content !== "undefined");
	const text = messageContentText(latestUserText).toLowerCase();
	if (!text.includes("command")) return false;
	return (
		text.includes("exact command") ||
		text.includes("command you ran") ||
		text.includes("command ran") ||
		text.includes("what command") ||
		text.includes("which command") ||
		text.includes("show the command") ||
		text.includes("include the command")
	);
}

function messageEventContent(event: unknown): unknown {
	if (!event || typeof event !== "object") return undefined;
	const record = event as Record<string, unknown>;
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const messageRecord = message as Record<string, unknown>;
	if (messageRecord.role !== "user") return undefined;
	return messageRecord.content;
}

function messageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!content || typeof content !== "object") return "";
	const text = (content as Record<string, unknown>).text;
	return typeof text === "string" ? text : "";
}

function isSafeCommandEcho(command: string): boolean {
	if (command.length === 0 || command.length > 240) return false;
	if (command.includes("\n") || command.includes("\r")) return false;
	const lower = command.toLowerCase();
	return ![
		"authorization",
		"bearer",
		"password",
		"passwd",
		"secret",
		"token",
		"api_key",
		"apikey",
		"vault://",
	].some((needle) => lower.includes(needle));
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
		const labeled = parseLabeledEvaluatorText(candidate);
		if (labeled) {
			return { object: labeled };
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

function parseLabeledEvaluatorText(text: string): RawEvaluatorOutput | null {
	const sections: Array<{ label: string; value: string }> = [];
	let current: { label: string; lines: string[] } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const labeledLine = parseEvaluatorLabelLine(line);
		if (labeledLine) {
			if (current) {
				sections.push({
					label: current.label,
					value: current.lines.join("\n").trim(),
				});
			}
			current = { label: labeledLine.label, lines: [labeledLine.value] };
			continue;
		}
		if (current) current.lines.push(line);
	}
	if (current) {
		sections.push({
			label: current.label,
			value: current.lines.join("\n").trim(),
		});
	}
	if (sections.length === 0) return null;

	const output: RawEvaluatorOutput = {};
	for (const section of sections) {
		if (section.label === "success") {
			const success = parseBooleanLabelValue(section.value);
			if (typeof success === "boolean") output.success = success;
			continue;
		}
		if (section.label === "decision" || section.label === "route") {
			output.decision = firstLabelToken(section.value);
			continue;
		}
		if (section.label === "thought") {
			output.thought = section.value;
			continue;
		}
		if (section.label === "messagetouser" || section.label === "message") {
			output.messageToUser = section.value;
		}
	}

	if (!isEvaluatorShapedObject(output)) return null;
	deriveMessageFromLabeledFinalThought(output);
	return output;
}

function parseEvaluatorLabelLine(
	line: string,
): { label: string; value: string } | null {
	const colon = line.indexOf(":");
	if (colon <= 0) return null;
	const label = normalizeEvaluatorLabel(line.slice(0, colon));
	if (!isKnownEvaluatorTextLabel(label)) return null;
	return {
		label,
		value: line.slice(colon + 1).trimStart(),
	};
}

function normalizeEvaluatorLabel(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replaceAll(" ", "")
		.replaceAll("_", "")
		.replaceAll("-", "");
}

function isKnownEvaluatorTextLabel(label: string): boolean {
	return (
		label === "success" ||
		label === "decision" ||
		label === "route" ||
		label === "thought" ||
		label === "messagetouser" ||
		label === "message"
	);
}

function parseBooleanLabelValue(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized.startsWith("true") || normalized.startsWith("yes"))
		return true;
	if (normalized.startsWith("false") || normalized.startsWith("no"))
		return false;
	return undefined;
}

function firstLabelToken(value: string): string {
	return (
		value
			.trim()
			.split(/\s+/)[0]
			?.replace(/[.,;:]+$/g, "") ?? ""
	);
}

function deriveMessageFromLabeledFinalThought(
	output: RawEvaluatorOutput,
): void {
	if (typeof output.messageToUser === "string") return;
	if (output.success !== true) return;
	if (normalizeEvaluatorRoute(output.decision) !== "FINISH") return;
	if (typeof output.thought !== "string") return;
	const thought = output.thought.trim();
	if (!looksLikeMultilineFinalAnswer(thought)) return;
	output.messageToUser = thought;
	output.thought = "Recovered evaluator-labeled final answer.";
}

function looksLikeMultilineFinalAnswer(text: string): boolean {
	if (!text.includes("\n")) return false;
	return (
		text.includes("```") ||
		text.includes("\n- ") ||
		text.includes("\n* ") ||
		text.includes("\n1. ") ||
		text.includes("**")
	);
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
