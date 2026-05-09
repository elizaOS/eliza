import { describe, expect, it, vi } from "vitest";
import type { GenerateTextResult, ToolDefinition } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";

type CerebrasRecordedToolCall = NonNullable<
	GenerateTextResult["toolCalls"]
>[number] & {
	toolName: string;
	input: Record<string, string>;
};

/**
 * Integration regression: drive the planner with a recorded Cerebras response
 * shape (AI SDK v6 native tool-call format: finishReason="tool-calls",
 * toolCalls[].name, toolCalls[].input) and assert the planner correctly
 * extracts the tool call name and args.
 *
 * The fixture matches the shape returned by the Cerebras provider via the
 * AI SDK v6 adapter used in this branch.
 */

/**
 * Real Cerebras response shape (recorded from trajectories-eliza-cerebras/
 * 93432706-b3b2-08ea-ab6a-ba55340a8848 chain-2-tools run).
 * Keys: toolName (not name), input (not arguments), finishReason="tool-calls".
 */
const RECORDED_CEREBRAS_RESPONSE: GenerateTextResult = {
	text: "",
	finishReason: "tool-calls",
		toolCalls: [
			{
				id: "call_recorded_abc123",
				// AI SDK v6 Cerebras adapter returns `toolName` and `input`
				// normalizeToolCall in planner-loop handles both shapes.
				toolName: "DOCUMENT",
				input: { query: "elizaOS architecture" },
			} as CerebrasRecordedToolCall,
		],
	usage: {
		promptTokens: 526,
		completionTokens: 42,
		totalTokens: 568,
	},
	providerMetadata: {
		cerebras: {
			id: "chatcmpl-recorded-fixture",
			model: "llama-4-scout-17b-16e-instruct",
		},
	},
};

const TOOL_DEF: ToolDefinition = {
	name: "DOCUMENT",
	description: "Search the knowledge base",
	parameters: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};

describe("planner-loop cerebras recorded response regression", () => {
	it("parses Cerebras toolName/input shape correctly", async () => {
		let plannerCallCount = 0;
		const runtime = {
			useModel: vi.fn(async () => {
				plannerCallCount++;
				if (plannerCallCount === 1) {
					return RECORDED_CEREBRAS_RESPONSE;
				}
				// After tool executes, return REPLY to finish
				return {
					text: "Here is what I found.",
					finishReason: "stop",
					toolCalls: [],
					usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
				} satisfies Partial<GenerateTextResult> as GenerateTextResult;
			}),
		};

		const capturedToolCalls: Array<{
			name: string;
			params?: Record<string, unknown>;
		}> = [];
		const executeToolCall = vi.fn(
			async (toolCall: { name: string; params?: Record<string, unknown> }) => {
				capturedToolCalls.push(toolCall);
				return {
					success: true,
					text: "Knowledge base result: elizaOS uses plugins.",
				};
			},
		);

		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Got the answer.",
			messageToUser: "elizaOS uses plugins.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx-cerebras-recorded" },
			tools: [TOOL_DEF],
			executeToolCall,
			evaluate,
		});

		// The tool call must have been extracted correctly
		expect(capturedToolCalls).toHaveLength(1);
		expect(capturedToolCalls[0]?.name).toBe("DOCUMENT");
		expect(capturedToolCalls[0]?.params).toEqual({
			query: "elizaOS architecture",
		});

		// The loop must complete successfully
		expect(result.status).toBe("finished");
	});

	it("handles finishReason=tool-calls without text content", async () => {
		const runtime = {
			useModel: vi.fn(async () => RECORDED_CEREBRAS_RESPONSE),
		};

		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "result",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		// Must not throw despite empty text in response
		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx-empty-text" },
				tools: [TOOL_DEF],
				executeToolCall,
				evaluate,
			}),
		).resolves.toBeDefined();
	});

	it("records the tool call id from the recorded Cerebras response", async () => {
		let callCount = 0;
		const capturedSteps: Array<{ toolCall?: { id?: string; name: string } }> =
			[];
		const runtime = {
			useModel: vi.fn(async () => {
				callCount++;
				if (callCount === 1) return RECORDED_CEREBRAS_RESPONSE;
				return {
					text: "done",
					finishReason: "stop",
					toolCalls: [],
					usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
				} as GenerateTextResult;
			}),
		};

		const executeToolCall = vi.fn(async (tc: { id?: string; name: string }) => {
			capturedSteps.push({ toolCall: { id: tc.id, name: tc.name } });
			return { success: true, text: "ok" };
		});

		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx-id-record" },
			tools: [TOOL_DEF],
			executeToolCall,
			evaluate,
		});

		expect(capturedSteps).toHaveLength(1);
		// The id from the recorded Cerebras fixture must propagate to the tool call
		expect(capturedSteps[0]?.toolCall?.id).toBe("call_recorded_abc123");
	});
});
