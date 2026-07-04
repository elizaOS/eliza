/**
 * Tests the Capacitor structured-output planning: grammar / JSON-schema request
 * shaping and OpenAI-shaped tool-call extraction back into the elizaOS
 * `ToolCallResult`. Deterministic, no native model.
 */

import { describe, expect, it } from "vitest";
import {
	applyStructuredPlan,
	buildCapacitorTools,
	extractToolCalls,
	planStructuredRequest,
} from "../structured-output";
import type {
	CapacitorLlamaCompletionParams,
	CapacitorLlamaCompletionResult,
} from "../types";

describe("capacitor-llama / structured-output", () => {
	describe("planStructuredRequest", () => {
		it("returns kind=text when no tools/schema/json supplied", () => {
			const plan = planStructuredRequest({});
			expect(plan.kind).toBe("text");
			expect(plan.tools).toBeUndefined();
			expect(plan.responseFormat).toBeUndefined();
		});

		it("prioritises tools over schema", () => {
			const plan = planStructuredRequest({
				tools: [
					{ name: "foo", description: "f", parameters: { type: "object" } },
				],
				responseSchema: { type: "object" },
			});
			expect(plan.kind).toBe("tools");
			expect(plan.tools).toBeDefined();
		});

		it("emits json_schema response_format for responseSchema", () => {
			const plan = planStructuredRequest({
				responseSchema: {
					type: "object",
					properties: { x: { type: "string" } },
				},
			});
			expect(plan.kind).toBe("schema");
			expect(plan.responseFormat?.type).toBe("json_schema");
			expect(plan.responseFormat?.json_schema?.schema).toEqual({
				type: "object",
				properties: { x: { type: "string" } },
			});
		});

		it("emits json_object response_format for responseFormat json_object", () => {
			const plan = planStructuredRequest({
				responseFormat: { type: "json_object" },
			});
			expect(plan.kind).toBe("json_object");
			expect(plan.responseFormat?.type).toBe("json_object");
		});

		it("forwards toolChoice when tools present", () => {
			const plan = planStructuredRequest({
				tools: [{ name: "go", description: "go" }],
				toolChoice: "auto",
			});
			expect(plan.kind).toBe("tools");
			expect(plan.toolChoice).toBe("auto");
		});
	});

	describe("buildCapacitorTools", () => {
		it("skips tools without a name", () => {
			const out = buildCapacitorTools([
				{ name: "", description: "skip" },
				{ name: "ok", description: "keep" },
			]) as Array<{ function: { name: string } }>;
			expect(out).toHaveLength(1);
			expect(out[0].function.name).toBe("ok");
		});

		it("propagates description and parameters", () => {
			const out = buildCapacitorTools([
				{
					name: "ping",
					description: "pings",
					parameters: { type: "object", properties: { x: { type: "number" } } },
				},
			]) as Array<{
				type: "function";
				function: {
					name: string;
					description?: string;
					parameters?: unknown;
				};
			}>;
			expect(out[0].type).toBe("function");
			expect(out[0].function.description).toBe("pings");
			expect(out[0].function.parameters).toEqual({
				type: "object",
				properties: { x: { type: "number" } },
			});
		});
	});

	describe("extractToolCalls", () => {
		const baseResult = (
			overrides: Partial<CapacitorLlamaCompletionResult>,
		): CapacitorLlamaCompletionResult => ({
			text: "",
			reasoning_content: "",
			tool_calls: [],
			content: "",
			chat_format: 0,
			tokens_predicted: 0,
			tokens_evaluated: 0,
			truncated: false,
			stopped_eos: false,
			stopped_word: "",
			stopped_limit: 0,
			stopping_word: "",
			context_full: false,
			interrupted: false,
			tokens_cached: 0,
			timings: {
				prompt_n: 0,
				prompt_ms: 0,
				prompt_per_token_ms: 0,
				prompt_per_second: 0,
				predicted_n: 0,
				predicted_ms: 0,
				predicted_per_token_ms: 0,
				predicted_per_second: 0,
			},
			...overrides,
		});

		it("parses valid JSON arguments", () => {
			const calls = extractToolCalls(
				baseResult({
					tool_calls: [
						{
							type: "function",
							id: "call_a",
							function: { name: "foo", arguments: '{"x":1,"y":"z"}' },
						},
					],
				}),
			);
			expect(calls).toEqual([
				{
					id: "call_a",
					name: "foo",
					arguments: { x: 1, y: "z" },
					type: "function",
				},
			]);
		});

		it("synthesises a call id when missing", () => {
			const calls = extractToolCalls(
				baseResult({
					tool_calls: [
						{ type: "function", function: { name: "f", arguments: "{}" } },
						{ type: "function", function: { name: "g", arguments: "{}" } },
					],
				}),
			);
			expect(calls.map((c) => c.id)).toEqual(["call_0", "call_1"]);
		});

		it("surfaces invalid JSON as _raw rather than dropping the call", () => {
			const calls = extractToolCalls(
				baseResult({
					tool_calls: [
						{
							type: "function",
							id: "broken",
							function: { name: "x", arguments: "not-json" },
						},
					],
				}),
			);
			expect(calls).toHaveLength(1);
			expect(calls[0].arguments).toEqual({ _raw: "not-json" });
		});
	});

	describe("applyStructuredPlan", () => {
		const base: CapacitorLlamaCompletionParams = {
			prompt: "hi",
			n_predict: 32,
		};

		it("returns params untouched for text plans", () => {
			const out = applyStructuredPlan(base, { kind: "text" });
			expect(out).toEqual(base);
		});

		it("merges tools + tool_choice for tool plans", () => {
			const out = applyStructuredPlan(base, {
				kind: "tools",
				tools: [{ name: "foo" }],
				toolChoice: "auto",
			});
			expect(out.tools).toEqual([{ name: "foo" }]);
			expect(out.tool_choice).toBe("auto");
		});

		it("merges response_format for schema plans", () => {
			const out = applyStructuredPlan(base, {
				kind: "schema",
				responseFormat: {
					type: "json_schema",
					json_schema: { strict: true, schema: { type: "object" } },
				},
			});
			expect(out.response_format?.type).toBe("json_schema");
		});
	});
});
