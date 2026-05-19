/**
 * Structured-output planning on the Capacitor surface.
 *
 * llama.cpp itself supports GBNF grammars and JSON-Schema-as-grammar natively;
 * the Capacitor binding exposes both via `CompletionParams.grammar` (raw GBNF
 * source) and `CompletionParams.response_format` (JSON object or JSON schema).
 *
 * Function-calling is exposed differently than in node-llama-cpp: the
 * Capacitor binding takes a raw `tools` object plus optional `tool_choice` /
 * `parallel_tool_calls` and the model emits an OpenAI-shaped
 * `tool_calls[]` array inside the completion result. We project this back
 * into the elizaOS `ToolCallResult` shape so downstream callers do not care
 * which backend produced the call.
 */

import type { JSONSchema, ToolDefinition } from "@elizaos/core";
import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
	CapacitorLlamaToolCall,
} from "./types";

export interface ToolCallResult {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	type: "function";
}

export interface StructuredRequestPlan {
	kind: "text" | "tools" | "schema" | "json_object";
	/** Forwarded to `CapacitorLlamaCompletionParams.tools`. */
	tools?: object;
	/** Forwarded to `CapacitorLlamaCompletionParams.response_format`. */
	responseFormat?: CapacitorLlamaCompletionParams["response_format"];
	/** Optional `tool_choice` directive. */
	toolChoice?: string;
}

/**
 * Build the OpenAI-style `tools` object the Capacitor binding accepts. Each
 * elizaOS `ToolDefinition` becomes one entry of:
 *   { type: "function", function: { name, description, parameters } }
 */
export function buildCapacitorTools(tools: readonly ToolDefinition[]): object {
	const out: Array<{
		type: "function";
		function: {
			name: string;
			description?: string;
			parameters?: JSONSchema;
		};
	}> = [];
	for (const tool of tools) {
		if (!tool.name) continue;
		out.push({
			type: "function",
			function: {
				name: tool.name,
				...(tool.description ? { description: tool.description } : {}),
				...(tool.parameters ? { parameters: tool.parameters } : {}),
			},
		});
	}
	return out;
}

/**
 * Extract tool calls from the Capacitor completion result. The binding emits
 * them on `result.tool_calls`; we parse `arguments` JSON and surface the
 * elizaOS shape.
 */
export function extractToolCalls(
	result: CapacitorLlamaCompletionResult,
): ToolCallResult[] {
	const calls: ToolCallResult[] = [];
	let i = 0;
	for (const call of result.tool_calls ?? []) {
		const parsedArgs = parseToolArguments(call);
		calls.push({
			id: call.id ?? `call_${i++}`,
			name: call.function.name,
			arguments: parsedArgs,
			type: "function",
		});
	}
	return calls;
}

function parseToolArguments(
	call: CapacitorLlamaToolCall,
): Record<string, unknown> {
	const raw = call.function.arguments;
	if (typeof raw !== "string" || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { _: parsed };
	} catch {
		// Model emitted invalid JSON; surface raw text so the runtime can
		// recover or report rather than silently dropping the call.
		return { _raw: raw };
	}
}

/**
 * Decide which structured-output mode applies. Mirrors the legacy
 * `planStructuredRequest` semantics: tools > schema > generic json > text.
 */
export function planStructuredRequest(params: {
	tools?: readonly ToolDefinition[];
	responseSchema?: JSONSchema;
	responseFormat?: { type: "json_object" | "text" } | string | undefined;
	toolChoice?: string;
}): StructuredRequestPlan {
	if (params.tools && params.tools.length > 0) {
		return {
			kind: "tools",
			tools: buildCapacitorTools(params.tools),
			...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
		};
	}
	if (params.responseSchema) {
		return {
			kind: "schema",
			responseFormat: {
				type: "json_schema",
				json_schema: {
					strict: true,
					schema: params.responseSchema as object,
				},
			},
		};
	}
	if (
		params.responseFormat &&
		typeof params.responseFormat === "object" &&
		params.responseFormat.type === "json_object"
	) {
		return {
			kind: "json_object",
			responseFormat: { type: "json_object" },
		};
	}
	return { kind: "text" };
}

/**
 * Apply a `StructuredRequestPlan` onto a `CapacitorLlamaCompletionParams`
 * object, returning a new merged object. Used by the index module right
 * before dispatching the completion.
 */
export function applyStructuredPlan(
	params: CapacitorLlamaCompletionParams,
	plan: StructuredRequestPlan,
): CapacitorLlamaCompletionParams {
	if (plan.kind === "text") return params;
	const next: CapacitorLlamaCompletionParams = { ...params };
	if (plan.tools) next.tools = plan.tools;
	if (plan.toolChoice) next.tool_choice = plan.toolChoice;
	if (plan.responseFormat) next.response_format = plan.responseFormat;
	return next;
}
