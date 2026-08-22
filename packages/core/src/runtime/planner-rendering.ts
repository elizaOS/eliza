/**
 * Renders completed planner trajectory steps into native assistant/tool chat
 * message pairs and projects a tool result to plain text for the next planner
 * call, shaping everything append-only so the prompt prefix stays byte-stable
 * for provider prompt caching. Also re-exports the provider cache-plan helpers.
 */

import { ElizaError } from "../errors";
import {
	composeToolDiagnosticRedactor,
	projectToolDiagnosticArgs,
	projectToolDiagnosticValue,
	type ToolDiagnosticTextRedactor,
} from "../security/tool-diagnostics";
import { isReadView } from "../types/content";
import type { ChatMessage, ChatMessageContentPart } from "../types/model";
import type { JsonValue } from "../types/primitives.ts";
import { stringifyForModel } from "./json-output";
import {
	type ContentProjectionBudget,
	estimateTokensFromChars,
} from "./model-input-budget";
import type { PlannerStep, PlannerToolResult } from "./planner-types";
import {
	buildProviderCachePlan,
	type CacheableSection,
	type ProviderCachePlan,
	type ProviderCachePlanArgs,
} from "./provider-cache-plan";

/**
 * Options for {@link trajectoryStepsToMessages}.
 */
export interface TrajectoryStepsToMessagesOptions {
	/**
	 * Runtime-aware diagnostic redactor for model-bound tool history. When
	 * omitted, the shared credential-shape pass still runs.
	 */
	redactText?: ToolDiagnosticTextRedactor;
	/** Final-serialization allowance derived from the active model input budget. */
	projectionBudget?: ContentProjectionBudget;
	/** Metadata-only preflight used to compute the final projection allowance. */
	omitRecoverableText?: boolean;
	/** Receives redacted aggregate projection counts for the rendered request. */
	onProjectionStats?: (stats: ToolResultProjectionStats) => void;
}

export interface ToolResultProjectionStats {
	resultCount: number;
	pagesIncluded: number;
	pagesOmitted: number;
	omissionReasons: Record<string, number>;
}

/**
 * Convert completed trajectory steps into proper assistant/tool message pairs
 * for native tool-calling. Skips steps that lack a toolCall or result (e.g.
 * terminal-only steps). The resulting array grows append-only across planner
 * iterations, which keeps the prefix byte-identical for cache hits.
 *
 * Emits AI SDK v6's `AssistantModelMessage` / `ToolModelMessage` shape — tool
 * calls live inside `content` as `ToolCallPart`, tool results inside `content`
 * as `ToolResultPart`. The legacy OpenAI v0.x shape (`assistant` with a
 * top-level `toolCalls` array + `tool` with `toolCallId`/`name` siblings) is
 * silently ignored by AI SDK v6's message conversion: `AssistantContent` only
 * understands `string | Array<TextPart | FilePart | ReasoningPart |
 * ToolCallPart | ToolResultPart | ToolApprovalRequest>` and has no top-level
 * `toolCalls` field. Emitting the legacy shape leaves the evaluator's
 * downstream model call with no view of the tool history, so the LLM keeps
 * routing CONTINUE under the belief that no tool has been executed yet — the
 * planner-loop then iterates until `TrajectoryLimitExceeded` on every
 * shell-tool turn.
 */
export function trajectoryStepsToMessages(
	steps: PlannerStep[],
	options: TrajectoryStepsToMessagesOptions = {},
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const redactText = options.redactText ?? composeToolDiagnosticRedactor();
	const resultCount = steps.filter(
		(step) => step.toolCall && step.result,
	).length;
	const fairResultBudget = options.projectionBudget
		? Math.min(
				options.projectionBudget.perResultTokens,
				resultCount === 0
					? 0
					: Math.floor(options.projectionBudget.aggregateTokens / resultCount),
			)
		: undefined;
	let pagesIncluded = 0;
	let pagesOmitted = 0;
	const omissionReasons: Record<string, number> = {};
	for (const step of steps) {
		if (!step.toolCall || !step.result) {
			continue;
		}
		const toolCallId = stableToolCallId(step);

		const assistantContent: ChatMessageContentPart[] = [];
		const thought = redactText((step.thought ?? "").trim());
		if (thought) {
			assistantContent.push({ type: "text", text: thought });
		}
		assistantContent.push({
			type: "tool-call",
			toolCallId,
			toolName: step.toolCall.name,
			input:
				projectToolDiagnosticArgs(step.toolCall.params ?? {}, redactText) ?? {},
		});
		messages.push({
			role: "assistant",
			content: assistantContent,
		});

		const rawResultText = toolMessageContent(
			projectToolDiagnosticValue(step.result, redactText) as PlannerToolResult,
			{
				...(fairResultBudget === undefined
					? {}
					: { maxSerializedTokens: fairResultBudget }),
				omitRecoverableText: options.omitRecoverableText,
				onProjection: (observation) => {
					if (!observation.validatedReadView) return;
					if (observation.textIncluded) {
						pagesIncluded++;
						return;
					}
					pagesOmitted++;
					const reason = observation.omissionReason ?? "unknown";
					omissionReasons[reason] = (omissionReasons[reason] ?? 0) + 1;
				},
			},
		);
		messages.push({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId,
					toolName: step.toolCall.name,
					output: { type: "text", value: rawResultText },
				},
			],
		});
	}
	options.onProjectionStats?.({
		resultCount,
		pagesIncluded,
		pagesOmitted,
		omissionReasons,
	});
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

/** Serialize one validated, non-duplicating tool-result projection. */
export function toolMessageContent(
	result: PlannerToolResult,
	options: {
		maxSerializedTokens?: number;
		omitRecoverableText?: boolean;
		onProjection?: (observation: ToolResultProjectionObservation) => void;
	} = {},
): string {
	const validatedReadView = findReadView(result.promptData);
	const projected = projectToolResultForModel(
		result,
		options.omitRecoverableText,
	);
	const serialized = stringifyForModel(projected);
	if (
		options.maxSerializedTokens === undefined ||
		estimateTokensFromChars(serialized.length) <= options.maxSerializedTokens
	) {
		options.onProjection?.({
			validatedReadView,
			textIncluded: validatedReadView && projected.text !== undefined,
			...(validatedReadView && projected.text === undefined
				? { omissionReason: "model-input-budget" }
				: {}),
		});
		return serialized;
	}

	if (!validatedReadView) {
		throw new ElizaError(
			"Non-recoverable tool result exceeds the model content projection budget",
			{
				code: "MODEL_CONTENT_PROJECTION_BUDGET_EXCEEDED",
				context: {
					maxSerializedTokens: options.maxSerializedTokens,
					serializedTokens: estimateTokensFromChars(serialized.length),
				},
				severity: "fatal",
			},
		);
	}

	const metadataOnly = projectToolResultForModel(result, true);
	const metadataSerialized = stringifyForModel(metadataOnly);
	if (
		estimateTokensFromChars(metadataSerialized.length) >
		options.maxSerializedTokens
	) {
		throw new ElizaError(
			"ReadView metadata exceeds the model content projection budget",
			{
				code: "MODEL_CONTENT_PROJECTION_BUDGET_EXCEEDED",
				context: {
					maxSerializedTokens: options.maxSerializedTokens,
					serializedTokens: estimateTokensFromChars(metadataSerialized.length),
				},
				severity: "fatal",
			},
		);
	}
	options.onProjection?.({
		validatedReadView: true,
		textIncluded: false,
		omissionReason: "model-input-budget",
	});
	return metadataSerialized;
}

export interface ToolResultProjectionObservation {
	validatedReadView: boolean;
	textIncluded: boolean;
	omissionReason?: "model-input-budget";
}

function findReadView(value: unknown): boolean {
	if (isReadView(value)) return true;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return isReadView((value as Record<string, unknown>).readView);
}

/**
 * Produce the sole model-bound shape for a tool result. `promptData` is an
 * explicit replacement for `data`, never an additional payload. Recoverable
 * page text may be omitted during budget preflight/fallback while its validated
 * ReadView remains available for an exact native continuation.
 */
export function projectToolResultForModel(
	result: PlannerToolResult,
	omitRecoverableText = false,
): PlannerToolResult & {
	contentProjection?: { textIncluded: boolean; reason?: string };
} {
	const hasReadView = findReadView(result.promptData);
	const projected = { ...result };
	if (result.promptData !== undefined) {
		delete projected.data;
	}
	if (omitRecoverableText && hasReadView && projected.text !== undefined) {
		delete projected.text;
		return {
			...projected,
			contentProjection: {
				textIncluded: false,
				reason: "model-input-budget",
			},
		};
	}
	return {
		...projected,
		...(hasReadView
			? { contentProjection: { textIncluded: projected.text !== undefined } }
			: {}),
	};
}

export function cacheProviderOptions(
	args: ProviderCachePlanArgs,
): Record<string, JsonValue | object | undefined> {
	return buildProviderCachePlan(args).providerOptions;
}

export type { CacheableSection, ProviderCachePlan };
