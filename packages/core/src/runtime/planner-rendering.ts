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
export function trajectoryStepsToMessages(steps: PlannerStep[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const step of steps) {
		if (!step.toolCall || !step.result) {
			continue;
		}
		const toolCallId = stableToolCallId(step);

		const assistantContent: ChatMessageContentPart[] = [];
		const thought = (step.thought ?? "").trim();
		if (thought) {
			assistantContent.push({ type: "text", text: thought });
		}
		assistantContent.push({
			type: "tool-call",
			toolCallId,
			toolName: step.toolCall.name,
			input: (step.toolCall.params ?? {}) as Record<string, unknown>,
		});
		messages.push({
			role: "assistant",
			content: assistantContent,
		});

		messages.push({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId,
					toolName: step.toolCall.name,
					output: { type: "text", value: toolMessageContent(step.result) },
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
 */
export function toolMessageContent(result: PlannerToolResult): string {
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

export function cacheProviderOptions(
	args: ProviderCachePlanArgs,
): Record<string, JsonValue | object | undefined> {
	return buildProviderCachePlan(args).providerOptions;
}

export function providerCachePlan(
	args: ProviderCachePlanArgs,
): ProviderCachePlan {
	return buildProviderCachePlan(args);
}

export type { CacheableSection, ProviderCachePlan };
