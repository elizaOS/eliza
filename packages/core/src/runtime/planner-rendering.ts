import type { ChatMessage } from "../types/model";
import type { JsonValue } from "../types/primitives.ts";
import { stringifyForModel } from "./json-output";
import type { PlannerStep, PlannerToolResult } from "./planner-types";

/**
 * Convert completed trajectory steps into proper assistant/tool message pairs
 * for native tool-calling. Skips steps that lack a toolCall or result (e.g.
 * terminal-only steps). The resulting array grows append-only across planner
 * iterations, which keeps the prefix byte-identical for cache hits.
 */
export function trajectoryStepsToMessages(steps: PlannerStep[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const step of steps) {
		if (!step.toolCall || !step.result) {
			continue;
		}
		const toolCallId = stableToolCallId(step);
		// The model's prior decision: assistant message with a tool call.
		messages.push({
			role: "assistant",
			content: step.thought ?? null,
			toolCalls: [
				{
					id: toolCallId,
					type: "function",
					name: step.toolCall.name,
					arguments: JSON.stringify(step.toolCall.params ?? {}),
				},
			],
		});
		messages.push({
			role: "tool",
			toolCallId,
			name: step.toolCall.name,
			content: toolMessageContent(step.result),
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

export function cacheProviderOptions(args: {
	prefixHash: string;
	segmentHashes?: readonly string[];
}): Record<string, JsonValue | object | undefined> {
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
		// Anthropic requires explicit cache_control on stable segments.
		// plugin-anthropic reads cacheControl from anthropic providerOptions and
		// stamps it onto each stable promptSegment block. This key tells the
		// plugin which TTL to use; "5m" is the Anthropic default.
		anthropic: {
			cacheControl: { type: "ephemeral" },
		},
		// OpenRouter passes cache_control through to the underlying provider.
		// For Anthropic-backed models it forwards the anthropic cache_control;
		// for OpenAI-compat models it forwards prompt_cache_key.
		openrouter: {
			promptCacheKey,
		},
		gateway: {
			caching: "auto",
		},
	};
}
