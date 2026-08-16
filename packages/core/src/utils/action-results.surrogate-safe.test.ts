/**
 * Test that action results with split UTF-16 surrogates (emoji) are safely
 * serialized to JSON without creating lone surrogate escapes that strict
 * JSON parsers reject.
 */

import { describe, expect, it } from "vitest";
import { deepToWellFormedUnicode } from "./well-formed";

/** JSON.stringify escapes ONLY lone surrogates as \ud8xx..\udfff; well-formed
 * astral characters are emitted raw. A strict parser (serde_json, Cerebras)
 * rejects those escapes, so their absence is the wire-safety invariant. */
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

describe("action results with emoji (surrogate pairs)", () => {
	it("prevents lone surrogates in streaming tool_result payload", () => {
		// Simulate a tool result that contains emoji truncated mid-character
		const toolResult = `web page title 🤖 with emoji`.slice(0, 16); // splits 🤖
		const payload = {
			type: "tool_result",
			toolCall: {
				id: "call_123",
				name: "web_search",
				arguments: {},
				result: toolResult, // contains lone surrogate
			},
		};

		// Without sanitization, this would contain \uD8xx escape
		const rawJson = JSON.stringify(payload);
		expect(LONE_SURROGATE_ESCAPE.test(rawJson)).toBe(true);

		// With deepToWellFormedUnicode, it should be clean
		const sanitizedJson = JSON.stringify(deepToWellFormedUnicode(payload));
		expect(LONE_SURROGATE_ESCAPE.test(sanitizedJson)).toBe(false);

		// And it should round-trip through strict parsing
		const parsed = JSON.parse(sanitizedJson);
		expect(parsed.type).toBe("tool_result");
		expect(parsed.toolCall.result).toBe("web page title �");
	});

	it("prevents lone surrogates in tool_call payload with multi-code-unit chars", () => {
		const payload = {
			type: "tool_call",
			toolCall: {
				id: "call_456",
				name: "test_action",
				arguments: { text: "emoji 🎉 test".slice(0, 8) }, // splits 🎉
			},
		};

		const sanitizedJson = JSON.stringify(deepToWellFormedUnicode(payload));
		expect(LONE_SURROGATE_ESCAPE.test(sanitizedJson)).toBe(false);

		const parsed = JSON.parse(sanitizedJson);
		expect(parsed.toolCall.arguments.text).toContain("emoji");
	});

	it("preserves well-formed emoji in evaluation payload", () => {
		const payload = {
			type: "evaluation",
			evaluation: {
				message: "Task completed successfully 🎉",
				score: 0.95,
			},
		};

		const sanitizedJson = JSON.stringify(deepToWellFormedUnicode(payload));
		expect(LONE_SURROGATE_ESCAPE.test(sanitizedJson)).toBe(false);

		const parsed = JSON.parse(sanitizedJson);
		expect(parsed.evaluation.message).toBe("Task completed successfully 🎉");
	});

	it("handles nested tool results with complex action data", () => {
		const payload = {
			type: "tool_result",
			toolCall: {
				id: "call_789",
				name: "process_data",
				arguments: {},
				result: {
					status: "success",
					data: [
						{ name: "Item 1 💰", value: 100 },
						{ name: "Item 2 🚀", value: 200 },
					],
					summary: "Processed items 🎯".slice(0, 15), // truncates emoji
				},
			},
		};

		const sanitizedJson = JSON.stringify(deepToWellFormedUnicode(payload));
		expect(LONE_SURROGATE_ESCAPE.test(sanitizedJson)).toBe(false);

		const parsed = JSON.parse(sanitizedJson);
		expect(parsed.toolCall.result.status).toBe("success");
		// The truncated summary should have the replacement character
		expect(parsed.toolCall.result.summary).toContain("Processed items");
	});

	it("sanitizes deeply nested structures with multiple emoji", () => {
		const payload = {
			type: "context_event",
			event: {
				type: "action_result",
				action: "search",
				result: {
					items: [
						{ title: "Page 🌍 title", url: "http://example.com" },
						{
							title: "Another 🔍 result".slice(0, 10), // truncates emoji
							url: "http://test.com",
						},
					],
					timestamp: new Date().toISOString(),
				},
			},
		};

		const sanitizedJson = JSON.stringify(deepToWellFormedUnicode(payload));
		expect(LONE_SURROGATE_ESCAPE.test(sanitizedJson)).toBe(false);

		const parsed = JSON.parse(sanitizedJson);
		expect(parsed.event.type).toBe("action_result");
		expect(parsed.event.result.items.length).toBe(2);
	});

	it("returns same reference for clean payloads (optimization)", () => {
		const cleanPayload = {
			type: "tool_result",
			toolCall: {
				id: "call_clean",
				name: "action",
				arguments: {},
				result: "clean result with no special chars",
			},
		};

		const sanitized = deepToWellFormedUnicode(cleanPayload);
		// Reference equality check — no allocation needed for clean data
		expect(sanitized).toBe(cleanPayload);
	});
});
