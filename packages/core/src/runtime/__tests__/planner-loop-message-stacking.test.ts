/**
 * Pins the planner's chat-message wire shape across loop iterations: an
 * append-only array with a stable system+user prefix, one assistant+tool pair
 * per completed step, and chronological loop feedback (prefix-cache-safe, no
 * JSON trajectory dump).
 * Deterministic — `useModel` is a vitest mock that captures each `messages`
 * array; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	ChatMessage,
	ChatMessageContentPart,
	ToolDefinition,
} from "../../types/model";
import { ModelType } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";

/**
 * Regression: the planner messages array must grow append-only across
 * iterations. Specifically:
 *
 *   1. Every earlier planner request must be a byte-identical array prefix of
 *      every later planner request — required for provider prefix caches.
 *
 *   2. Each completed step adds exactly one assistant message (with a
 *      tool-call content part) and one tool message (with a tool-result
 *      content part). Loop/evaluator feedback follows as an appended user
 *      message instead of rewriting the original context message.
 *
 *   3. The messages array MUST NOT contain a role:"user" message whose content
 *      matches /^trajectory:\n\[/ (the old JSON-dump anti-pattern).
 *
 * These tests drive the planner with a mock useModel that captures every
 * `messages` array passed to it. Two planner calls happen in the two-tool chain:
 *   - Call 1 (iteration 1): no prior steps → base N messages
 *   - Call 2 (iteration 2): one completed step plus evaluator feedback
 */

const TOOL_DEF: ToolDefinition = {
	name: "LOOKUP",
	description: "Look something up",
	parameters: { type: "object", properties: {} },
};

function contentPartOfType(
	message: ChatMessage | undefined,
	type: string,
): ChatMessageContentPart | undefined {
	if (!Array.isArray(message?.content)) {
		return undefined;
	}
	return message.content.find((part) => part.type === type);
}

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

		// The complete earlier request—not just its system message—must be the
		// byte-identical prefix of the later request.
		for (let i = 0; i < msgs1.length; i++) {
			expect(JSON.stringify(msgs2[i])).toBe(JSON.stringify(msgs1[i]));
		}

		// AI SDK v6 shape: tool calls live inside `content` as ToolCallPart,
		// tool results inside `content` as ToolResultPart. Evaluator feedback is
		// chronological and follows the pair without changing either message.
		const added = msgs2.slice(msgs1.length);
		expect(added.length).toBe(3);
		expect(added[0].role).toBe("assistant");
		expect(added[1].role).toBe("tool");
		expect(added[2].role).toBe("user");

		const assistantToolCall = contentPartOfType(added[0], "tool-call");
		const toolResult = contentPartOfType(added[1], "tool-result");
		expect(assistantToolCall).toBeDefined();
		expect(toolResult).toBeDefined();

		// The assistant message's tool-call id must match the tool-result id.
		expect(toolResult?.toolCallId).toBe(assistantToolCall?.toolCallId);
		expect(JSON.stringify(added).match(/result of LOOKUP/g)).toHaveLength(1);
	});

	it("planner never appends a standalone trajectory JSON dump as the LAST message", async () => {
		// Regression guard: the LAST appended planner message must NOT be a
		// role:"user" message whose content starts `trajectory:\n[` — trajectory
		// steps render as assistant/tool pairs, never as a standalone user JSON
		// dump appended at the end.
		//
		// Note: the context renderer (renderContextObject) legitimately includes
		// trajectory state as part of messages[1] (the rendered context); that is
		// expected and not what this guard checks.

		const capturedMessages: ChatMessage[][] = [];
		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async (_modelType, params) => {
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
		// role:"user" message with content starting `trajectory:\n[`. The last
		// messages are the assistant/tool pairs from trajectory steps.
		for (const messages of capturedMessages) {
			const lastMsg = messages[messages.length - 1];
			const isJsonDump =
				lastMsg !== undefined &&
				lastMsg.role === "user" &&
				typeof lastMsg.content === "string" &&
				/^trajectory:\n\[/.test(lastMsg.content);
			expect(isJsonDump).toBe(false);
		}

		// After the first tool executes, the exact tool pair remains immediately
		// before the appended evaluator feedback message.
		if (capturedMessages.length >= 2) {
			const secondPlannerMsgs = capturedMessages[1];
			const suffix = secondPlannerMsgs?.slice(-3);
			expect(suffix?.map((message) => message.role)).toEqual([
				"assistant",
				"tool",
				"user",
			]);
		}
	});

	it("emits exactly one system + one user message before the suffix", async () => {
		// Wire-shape regression: stacking many `system` messages fragments the
		// cache prefix, confuses turn boundaries, and triggers strict provider
		// validation (Cerebras 400s on certain combinations). The native chat
		// protocol expects ONE system + ONE user prefix, then assistant/tool
		// suffix turns for each iteration of the loop.
		const capturedMessages: ChatMessage[][] = [];
		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async (_modelType, params) => {
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
						{ id: "tc-end", name: "REPLY", arguments: { text: "ok" } },
					],
				};
			}),
		};

		await runPlannerLoop({
			runtime,
			context: {
				id: "ctx-shape",
				staticPrefix: {
					systemPrompt: {
						id: "system",
						label: "system",
						content: "You are Eliza.",
						stable: true,
					},
					contextRegistryDigest: "general,calendar,email",
				},
				trajectoryPrefix: {
					selectedContexts: ["general"],
				},
				events: [
					{
						id: "instr-rules",
						type: "instruction",
						source: "test",
						content: "rules: be concise",
						stable: true,
						role: "system",
					},
					{
						id: "msg-user-1",
						type: "message",
						source: "user",
						message: { role: "user", content: "What's 2+2?" },
					},
				],
			},
			tools: [TOOL_DEF],
			executeToolCall: vi.fn(async () => ({ success: true, text: "ok" })),
			evaluate: vi.fn(async () => ({
				success: true,
				decision: "CONTINUE" as const,
				thought: "go",
			})),
		});

		expect(capturedMessages.length).toBeGreaterThanOrEqual(1);
		for (const messages of capturedMessages) {
			// Exactly one leading system message.
			expect(messages[0]?.role).toBe("system");
			// No second system message — that would fragment the cache prefix.
			expect(messages[1]?.role).not.toBe("system");
			// Second message must be the live user turn.
			expect(messages[1]?.role).toBe("user");
			// No system messages after the user turn. Suffix entries are native
			// assistant/tool pairs or chronological loop-feedback user messages.
			for (let i = 2; i < messages.length; i++) {
				expect(messages[i]?.role).not.toBe("system");
				expect(["assistant", "tool", "user"]).toContain(messages[i]?.role);
			}
		}
	});

	it("tool message result id matches the assistant tool-call id", async () => {
		const capturedMessages: ChatMessage[][] = [];
		let callCount = 0;
		const runtime = {
			useModel: vi.fn(async (_modelType, params) => {
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
			const tcId = contentPartOfType(assistantMsg, "tool-call")?.toolCallId;
			const resultId = contentPartOfType(toolMsg, "tool-result")?.toolCallId;
			expect(tcId).toBeDefined();
			expect(resultId).toBe(tcId);
		}
	});

	it("evaluator requests also grow as byte-identical same-stage prefixes", async () => {
		const evaluatorMessages: ChatMessage[][] = [];
		let plannerCalls = 0;
		let evaluatorCalls = 0;
		const runtime = {
			useModel: vi.fn(async (modelType: string, params: unknown) => {
				const messages = (params as { messages?: ChatMessage[] }).messages;
				if (modelType === ModelType.RESPONSE_HANDLER) {
					if (messages) {
						evaluatorMessages.push(JSON.parse(JSON.stringify(messages)));
					}
					evaluatorCalls++;
					return JSON.stringify({
						success: true,
						decision: evaluatorCalls === 1 ? "CONTINUE" : "FINISH",
						thought: evaluatorCalls === 1 ? "Run the second lookup." : "Done.",
						...(evaluatorCalls === 2 ? { messageToUser: "complete" } : {}),
					});
				}
				plannerCalls++;
				return plannerCalls === 1
					? {
							text: "",
							toolCalls: [
								{ id: "tc-first", name: "LOOKUP", arguments: { q: "first" } },
							],
						}
					: {
							text: "",
							toolCalls: [
								{ id: "tc-second", name: "LOOKUP", arguments: { q: "second" } },
							],
						};
			}),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx-evaluator-prefix" },
			tools: [TOOL_DEF],
			executeToolCall: vi.fn(async (toolCall) => ({
				success: true,
				text: `result:${String(toolCall.params?.q)}`,
			})),
		});

		expect(evaluatorMessages).toHaveLength(2);
		const first = evaluatorMessages[0] ?? [];
		const second = evaluatorMessages[1] ?? [];
		expect(second.length).toBeGreaterThan(first.length);
		for (let i = 0; i < first.length; i++) {
			expect(JSON.stringify(second[i])).toBe(JSON.stringify(first[i]));
		}
		expect(JSON.stringify(second).match(/result:first/g)).toHaveLength(1);
		expect(JSON.stringify(second).match(/result:second/g)).toHaveLength(1);
	});

	it("keeps local cache affinity stable across trajectories and separated by stage", async () => {
		type CacheCapture = {
			modelType: string;
			conversationId?: string;
			promptCacheKey?: string;
		};
		const captures: CacheCapture[] = [];

		for (const trajectoryId of ["trajectory-a", "trajectory-b"]) {
			const runtime = {
				useModel: vi.fn(async (modelType: string, params: unknown) => {
					const providerOptions = (
						params as {
							providerOptions?: {
								eliza?: { conversationId?: string };
								cerebras?: { prompt_cache_key?: string };
							};
						}
					).providerOptions;
					captures.push({
						modelType,
						conversationId: providerOptions?.eliza?.conversationId,
						promptCacheKey: providerOptions?.cerebras?.prompt_cache_key,
					});
					if (modelType === ModelType.RESPONSE_HANDLER) {
						return JSON.stringify({
							success: true,
							decision: "FINISH",
							thought: "Done.",
							messageToUser: "complete",
						});
					}
					return {
						text: "",
						toolCalls: [
							{ id: `tc-${trajectoryId}`, name: "LOOKUP", arguments: {} },
						],
					};
				}),
			};

			await runPlannerLoop({
				runtime,
				context: { id: "same-context" },
				tools: [TOOL_DEF],
				trajectoryId,
				cacheConversationId: "room-stable",
				executeToolCall: vi.fn(async () => ({ success: true, text: "ok" })),
			});
		}

		const planners = captures.filter(
			(capture) => capture.modelType === ModelType.ACTION_PLANNER,
		);
		const evaluators = captures.filter(
			(capture) => capture.modelType === ModelType.RESPONSE_HANDLER,
		);
		expect(planners.map((capture) => capture.conversationId)).toEqual([
			"room-stable:planner",
			"room-stable:planner",
		]);
		expect(evaluators.map((capture) => capture.conversationId)).toEqual([
			"room-stable:evaluator",
			"room-stable:evaluator",
		]);
		expect(planners[0]?.conversationId).not.toBe(evaluators[0]?.conversationId);
		expect(planners[1]?.promptCacheKey).toBe(planners[0]?.promptCacheKey);
		expect(evaluators[1]?.promptCacheKey).toBe(evaluators[0]?.promptCacheKey);
	});

	it("shows the evaluator complete pending calls and executes its recommendation", async () => {
		const evaluatorMessages: ChatMessage[][] = [];
		let evaluatorCalls = 0;
		const runtime = {
			useModel: vi.fn(async (modelType: string, params: unknown) => {
				if (modelType === ModelType.RESPONSE_HANDLER) {
					const messages =
						(params as { messages?: ChatMessage[] }).messages ?? [];
					evaluatorMessages.push(JSON.parse(JSON.stringify(messages)));
					evaluatorCalls++;
					return JSON.stringify(
						evaluatorCalls === 1
							? {
									success: true,
									decision: "NEXT_RECOMMENDED",
									thought: "Execute the remaining planned lookup.",
									recommendedToolCallId: "tc-second",
								}
							: {
									success: true,
									decision: "FINISH",
									thought: "Both lookups completed.",
									messageToUser: "complete",
								},
					);
				}
				return {
					text: "",
					toolCalls: [
						{ id: "tc-first", name: "LOOKUP", arguments: { q: "first" } },
						{
							id: "tc-second",
							name: "LOOKUP",
							arguments: { q: "second", nested: { full: "arguments" } },
						},
					],
				};
			}),
		};
		const executeToolCall = vi.fn(async (toolCall) => ({
			success: true,
			text: `result:${String(toolCall.params?.q)}`,
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx-pending-queue" },
			tools: [TOOL_DEF],
			executeToolCall,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(executeToolCall.mock.calls.map((call) => call[0]?.id)).toEqual([
			"tc-first",
			"tc-second",
		]);
		const firstEvaluatorPrompt = JSON.stringify(evaluatorMessages[0]);
		expect(firstEvaluatorPrompt).toContain("pending_tool_calls");
		expect(firstEvaluatorPrompt).toContain('\\"id\\": \\"tc-second\\"');
		expect(firstEvaluatorPrompt).toContain('\\"nested\\": {');
		expect(firstEvaluatorPrompt).toContain('\\"full\\": \\"arguments\\"');
		expect(
			firstEvaluatorPrompt.match(/tc-second/g)?.length,
		).toBeGreaterThanOrEqual(1);
		expect(firstEvaluatorPrompt).not.toContain("result:second");
		expect(JSON.stringify(evaluatorMessages[1])).toContain("result:second");
	});
});
