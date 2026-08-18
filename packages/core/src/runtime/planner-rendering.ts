/**
 * Renders completed planner trajectory steps into native assistant/tool chat
 * message pairs and projects a tool result to plain text for the next planner
 * call, shaping everything append-only so the prompt prefix stays byte-stable
 * for provider prompt caching. Also re-exports the provider cache-plan helpers.
 */

import {
	composeToolDiagnosticRedactor,
	projectToolDiagnosticArgs,
	projectToolDiagnosticValue,
	type ToolDiagnosticTextRedactor,
} from "../security/tool-diagnostics";
import type { ChatMessage, ChatMessageContentPart } from "../types/model";
import type { JsonValue } from "../types/primitives.ts";
import { tailWellFormed, truncateWellFormed } from "../utils/well-formed";
import { stringifyForModel } from "./json-output";
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
	/**
	 * When set, caps each rendered tool-result string to this many characters.
	 *
	 * A single pathologically-large tool result (a 30 KB shell output, a
	 * full file read, a multi-thousand-line grep) can blow the planner's
	 * compaction budget single-handedly when it lives inside the
	 * kept-verbatim window after compaction. This cap renders such results
	 * as `<head> ... [N chars truncated] ... <tail>` so the planner still
	 * sees the beginning and end of the result (which is where structure
	 * lives) without paying for the middle.
	 *
	 * **The trajectory itself is unchanged** — the raw `PlannerStep.result`
	 * still carries the full content for archival, recorder, replay, and
	 * any downstream consumer that wants the unredacted output. Only the
	 * wire-shape message that goes to the next planner call is truncated.
	 *
	 * Default: undefined (no cap).
	 */
	maxToolResultChars?: number;
}

/**
 * Truncate a tool-result string to fit within `maxChars` by keeping a head
 * + tail and stitching in a deterministic marker. Pure function — exported
 * so the evaluator/recorder can mirror the exact rendering rule.
 *
 * Returns the input unchanged when it already fits OR when `maxChars` is
 * unset / non-positive / not finite.
 */
export function truncateToolResultText(
	text: string,
	maxChars: number | undefined,
): string {
	if (
		typeof maxChars !== "number" ||
		!Number.isFinite(maxChars) ||
		maxChars <= 0
	) {
		return text;
	}
	if (text.length <= maxChars) {
		return text;
	}

	const limit = Math.floor(maxChars);
	const markerFor = (count: number) => ` [${count} chars truncated] `;

	for (
		let preserveBudget = limit - markerFor(text.length).length;
		preserveBudget > 0;
		preserveBudget--
	) {
		const headFloor = preserveBudget >= 20 ? 10 : 1;
		const tailFloor = preserveBudget >= 20 ? 10 : preserveBudget > 1 ? 1 : 0;
		const headChars = Math.max(headFloor, Math.floor(preserveBudget * 0.6));
		const tailChars = Math.max(tailFloor, preserveBudget - headChars);
		// Surrogate-safe cuts: a plain slice landing mid-emoji leaves a lone
		// surrogate that strict provider JSON parsers reject (#18025).
		const head = truncateWellFormed(text, headChars);
		const tail = tailWellFormed(text, tailChars);
		// Compute the truncated count from the ACTUAL retained code-unit
		// lengths, not the requested head/tail lengths — truncateWellFormed
		// and tailWellFormed back off at surrogate boundaries, so the actual
		// retained length may be shorter than the request (#18081).
		const actualPreserved = head.length + tail.length;
		const truncatedCount = text.length - actualPreserved;
		if (truncatedCount <= 0) {
			return truncateWellFormed(text, limit);
		}
		const marker = markerFor(truncatedCount);
		if (actualPreserved + marker.length <= limit) {
			return `${head}${marker}${tail}`;
		}
	}

	return truncateWellFormed(text, limit);
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
		);
		const renderedResultText = truncateToolResultText(
			rawResultText,
			options.maxToolResultChars,
		);
		messages.push({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId,
					toolName: step.toolCall.name,
					output: { type: "text", value: renderedResultText },
				},
			],
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
 *
 * An action may provide `promptData` when its complete machine payload is not
 * an appropriate model projection. This keeps projection ownership with the
 * action and leaves arbitrary chaining data intact by default.
 */
export function toolMessageContent(result: PlannerToolResult): string {
	const parts: string[] = [];
	const hasText =
		typeof result.text === "string" && result.text.trim().length > 0;
	if (hasText && typeof result.text === "string") {
		parts.push(`text: ${result.text.trim()}`);
	}
	const modelData = result.promptData ?? result.data;
	if (modelData && Object.keys(modelData).length > 0) {
		parts.push(`data: ${stringifyForModel(modelData)}`);
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

export function cacheProviderOptions(
	args: ProviderCachePlanArgs,
): Record<string, JsonValue | object | undefined> {
	return buildProviderCachePlan(args).providerOptions;
}

export type { CacheableSection, ProviderCachePlan };
