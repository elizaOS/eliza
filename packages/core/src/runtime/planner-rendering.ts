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
 * Serialize the complete PlannerToolResult into the next model turn. Tool
 * results are model context: preferring one projection and omitting sibling
 * fields hides receipts, user-facing evidence, and structured failure data in
 * ways that are extremely difficult to diagnose.
 */
export function toolMessageContent(result: PlannerToolResult): string {
	return stringifyForModel(result);
}

export function cacheProviderOptions(
	args: ProviderCachePlanArgs,
): Record<string, JsonValue | object | undefined> {
	return buildProviderCachePlan(args).providerOptions;
}

export type { CacheableSection, ProviderCachePlan };
