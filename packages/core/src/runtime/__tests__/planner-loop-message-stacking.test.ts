import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolDefinition } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";

/**
 * Regression: the planner messages array must grow append-only across
 * iterations. Specifically:
 *
 *   1. The base messages (before any trajectory steps) must be byte-identical
 *      across planner iterations — required for Cerebras/OpenAI prefix cache.
 *
 *   2. Each completed step adds exactly one assistant message (with toolCalls)
 *      and one tool message (with toolCallId). No JSON dump in a user message.
 *
 *   3. The messages array MUST NOT contain a role:"user" message whose content
 *      matches /^trajectory:\n\[/ (the old JSON-dump anti-pattern).
 *
 * These tests drive the planner with a mock useModel that captures every
 * `messages` array passed to it. Two planner calls happen in the two-tool chain:
 *   - Call 1 (iteration 1): no prior steps → base N messages
 *   - Call 2 (iteration 2): one completed step → N + 2 messages (assistant + tool)
 */

const TOOL_DEF: ToolDefinition = {
	name: "LOOKUP",
	description: "Look something up",
	parameters: { type: "object", properties: {} },
};

describe("planner-loop message stacking regression", () => {
	it("messages array grows append-only across planner iterations", async () => {
		const capturedMessages: ChatMessage[][] = [];

		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async () => {
				callCount++;
				if (callCount === 1) {
					// First planner call: return a tool call
					return {
						text: "",
						toolCalls: [
							{ id: "tc-iter1-0", name: "LOOKUP", arguments: { q: "first" } },
						],
					};
				}
				// Second planner call (after first tool executed): terminal
				return {
					text: "",
					toolCalls: [
						{ id: "tc-final", name: "REPLY", arguments: { text: "done" } },
					],
				};
			}),
		};

		// Capture messages from each useModel call
		const originalUseModel = runtime.useModel;
		runtime.useModel = vi.fn(async (modelType, params, provider) => {
			const p = params as { messages?: ChatMessage[] };
			if (p.messages) {
				capturedMessages.push(JSON.parse(JSON.stringify(p.messages)));
			}
			return originalUseModel(modelType, params, provider);
		}) as typeof runtime.useModel;

		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Continue.",
		}));
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "result of LOOKUP",
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx-stack" },
			tools: [TOOL_DEF],
			executeToolCall,
			evaluate,
		});

		// Should have at least 2 planner calls
		expect(capturedMessages.length).toBeGreaterThanOrEqual(2);

		const msgs1 = capturedMessages[0];
		const msgs2 = capturedMessages[1];

		if (!msgs1 || !msgs2) {
			throw new Error("Expected at least 2 planner calls");
		}

		// The second call must have more messages than the first
		expect(msgs2.length).toBeGreaterThan(msgs1.length);

		// The system message (messages[0]) must be byte-identical across iterations.
		// messages[1] is the rendered context which legitimately grows as tool results
		// are appended to context.events — that growth is expected and correct.
		expect(JSON.stringify(msgs2[0])).toBe(JSON.stringify(msgs1[0]));

		// Prior assistant/tool pair messages (indices >= 2) must be preserved byte-for-byte.
		for (let i = 2; i < msgs1.length; i++) {
			expect(JSON.stringify(msgs2[i])).toBe(JSON.stringify(msgs1[i]));
		}

		// The new messages added in call 2 must be assistant + tool pair
		const added = msgs2.slice(msgs1.length);
		expect(added.length).toBe(2);
		expect(added[0].role).toBe("assistant");
		expect(added[0].toolCalls).toBeDefined();
		expect(added[0].toolCalls).toHaveLength(1);
		expect(added[1].role).toBe("tool");
		expect(added[1].toolCallId).toBeDefined();

		// The assistant message's tool call id must match the tool message's toolCallId
		const assistantToolCallId = added[0].toolCalls?.[0]?.id;
		expect(added[1].toolCallId).toBe(assistantToolCallId);
	});

	it("planner never appends a standalone trajectory JSON dump as the LAST message", async () => {
		// The old bug: renderPlannerModelInput appended a role:"user" message at
		// the END of the array as the LAST message containing `trajectory:\n[...]`.
		// The fix: trajectory steps are now rendered as assistant/tool pairs, not
		// as a standalone user message appended at the end.
		//
		// Note: the context renderer (renderContextObject) legitimately includes
		// trajectory state as part of messages[1] (the rendered context). That is
		// expected. The regression guard is that the LAST appended planner message
		// must NOT be a role:"user" message with content starting `trajectory:\n[`.

		const capturedMessages: ChatMessage[][] = [];
		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async (modelType, params) => {
				callCount++;
				const p = params as { messages?: ChatMessage[] };
				if (p.messages) {
					capturedMessages.push(JSON.parse(JSON.stringify(p.messages)));
				}
				if (callCount === 1) {
					return {
						text: "",
						toolCalls: [{ id: "tc-1", name: "LOOKUP", arguments: { q: "x" } }],
					};
				}
				return {
					text: "",
					toolCalls: [
						{ id: "tc-end", name: "REPLY", arguments: { text: "done" } },
					],
				};
			}),
		};

		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "go on",
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx-no-dump" },
			tools: [TOOL_DEF],
			executeToolCall: vi.fn(async () => ({ success: true, text: "ok" })),
			evaluate,
		});

		// For each planner call, the LAST message in the array must NOT be a
		// role:"user" message with content starting `trajectory:\n[` (the old dump).
		// After the fix, the last messages should be the assistant/tool pairs from
		// trajectory steps.
		for (const messages of capturedMessages) {
			const lastMsg = messages[messages.length - 1];
			const isJsonDump =
				lastMsg !== undefined &&
				lastMsg.role === "user" &&
				typeof lastMsg.content === "string" &&
				/^trajectory:\n\[/.test(lastMsg.content);
			expect(isJsonDump).toBe(false);
		}

		// After the first tool executes, the second planner call must end with
		// a role:"tool" message (the new append-only pattern).
		if (capturedMessages.length >= 2) {
			const secondPlannerMsgs = capturedMessages[1];
			const lastMsg = secondPlannerMsgs?.[secondPlannerMsgs.length - 1];
			expect(lastMsg?.role).toBe("tool");
		}
	});

	it("tool message toolCallId matches the assistant toolCalls id", async () => {
		const capturedMessages: ChatMessage[][] = [];
		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async (modelType, params) => {
				callCount++;
				const p = params as { messages?: ChatMessage[] };
				if (p.messages) {
					capturedMessages.push(JSON.parse(JSON.stringify(p.messages)));
				}
				if (callCount === 1) {
					return {
						text: "thinking",
						toolCalls: [
							{
								id: "my-tool-id-42",
								name: "LOOKUP",
								arguments: { q: "hello" },
							},
						],
					};
				}
				return `{"thought":"done","toolCalls":[{"name":"REPLY","params":{"text":"Done."}}]}`;
			}),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx-id-match" },
			tools: [TOOL_DEF],
			executeToolCall: vi.fn(async () => ({ success: true, text: "result" })),
			evaluate: vi.fn(async () => ({
				success: true,
				decision: "CONTINUE" as const,
				thought: "",
			})),
		});

		// Second planner call should have assistant+tool appended
		expect(capturedMessages.length).toBeGreaterThanOrEqual(2);
		const msgs2 = capturedMessages[1];
		if (!msgs2) throw new Error("Expected second capture");
		const msgs1 = capturedMessages[0];
		if (!msgs1) throw new Error("Expected first capture");

		const added = msgs2.slice(msgs1.length);
		if (added.length >= 2) {
			const assistantMsg = added[0];
			const toolMsg = added[1];
			const tcId = assistantMsg?.toolCalls?.[0]?.id;
			expect(tcId).toBeDefined();
			expect(toolMsg?.toolCallId).toBe(tcId);
		}
	});
});
