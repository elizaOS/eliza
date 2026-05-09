import { describe, expect, it, vi } from "vitest";
import { executePlannedToolCall } from "../runtime/execute-planned-tool-call";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
} from "../runtime/planner-loop";
import { runSubPlanner } from "../runtime/sub-planner";
import { runWithStreamingContext } from "../streaming-context";
import type { Action, IAgentRuntime, Memory } from "../types";
import { ModelType } from "../types/model";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "LOOKUP",
		description: "Look up status",
		validate: async () => true,
		handler: async () => ({ success: true }),
		...overrides,
	};
}

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "check status" },
	} as Memory;
}

function makeRuntime(responses: unknown[], actions: Action[]): IAgentRuntime {
	const queue = [...responses];
	return {
		actions,
		useModel: vi.fn(async () => {
			if (queue.length === 0) {
				throw new Error("Unexpected useModel call");
			}
			return queue.shift();
		}),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

describe("v5 runtime streaming hooks", () => {
	it("fires planner, tool result, and evaluator hooks in execution order", async () => {
		const order: string[] = [];
		const action = makeAction({
			name: "LOOKUP",
			parameters: [
				{
					name: "query",
					description: "Lookup query",
					required: true,
					schema: { type: "string" },
				},
			],
			handler: vi.fn(async () => ({
				success: true,
				text: "all good",
				data: { answer: "ok" },
			})),
		});
		const runtime = makeRuntime(
			[
				{
					text: "",
					toolCalls: [
						{
							id: "call-1",
							name: "LOOKUP",
							arguments: { query: "status" },
						},
					],
				},
				JSON.stringify({
					success: true,
					decision: "FINISH",
					thought: "Done.",
					messageToUser: "Done.",
				}),
			],
			[action],
		);

		const onToolCall = vi.fn(() => order.push("toolCall"));
		const onToolResult = vi.fn(() => order.push("toolResult"));
		const onEvaluation = vi.fn(() => order.push("evaluation"));

		const result = await runWithStreamingContext(
			{
				onStreamChunk: vi.fn(),
				onToolCall,
				onToolResult,
				onEvaluation,
				messageId: "message-1",
			},
			() =>
				runPlannerLoop({
					runtime,
					context: {
						id: "ctx",
						events: [
							{
								id: "tool:LOOKUP",
								type: "tool",
								tool: {
									name: "LOOKUP",
									description: "Look up status",
								},
							},
						],
					},
					executeToolCall: async (toolCall) =>
						actionResultToPlannerToolResult(
							await executePlannedToolCall(
								runtime,
								{ message: makeMessage() },
								toolCall,
							),
						),
				}),
		);

		expect(result.status).toBe("finished");
		expect(order).toEqual(["toolCall", "toolResult", "evaluation"]);
		expect(onToolCall).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId: "message-1",
				toolCall: expect.objectContaining({
					id: "call-1",
					name: "LOOKUP",
					status: "pending",
				}),
				contextEvent: expect.objectContaining({ id: "tool:LOOKUP" }),
			}),
		);
		expect(onToolResult).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId: "message-1",
				toolCallId: "call-1",
				status: "completed",
				result: expect.objectContaining({
					success: true,
					text: "all good",
					data: expect.objectContaining({ answer: "ok" }),
				}),
			}),
		);
		expect(onEvaluation).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId: "message-1",
				evaluation: expect.objectContaining({
					decision: "FINISH",
					messageToUser: "Done.",
				}),
			}),
		);
		expect(runtime.useModel).toHaveBeenNthCalledWith(
			1,
			ModelType.ACTION_PLANNER,
			expect.any(Object),
			undefined,
		);
		expect(runtime.useModel).toHaveBeenNthCalledWith(
			2,
			ModelType.RESPONSE_HANDLER,
			expect.any(Object),
			undefined,
		);
	});

	it("isolates runtime hook failures", async () => {
		const runtime = makeRuntime(
			[
				{
					text: "",
					toolCalls: [{ id: "call-1", name: "LOOKUP", arguments: {} }],
				},
				JSON.stringify({
					success: true,
					decision: "FINISH",
					thought: "Done.",
					messageToUser: "Done.",
				}),
			],
			[makeAction({ name: "LOOKUP" })],
		);

		const result = await runWithStreamingContext(
			{
				onStreamChunk: vi.fn(),
				onToolCall: vi.fn(async () => {
					throw new Error("tool call observer failed");
				}),
				onToolResult: vi.fn(async () => {
					throw new Error("tool result observer failed");
				}),
				onEvaluation: vi.fn(async () => {
					throw new Error("evaluation observer failed");
				}),
			},
			() =>
				runPlannerLoop({
					runtime,
					context: { id: "ctx", events: [] },
					executeToolCall: async (toolCall) =>
						actionResultToPlannerToolResult(
							await executePlannedToolCall(
								runtime,
								{ message: makeMessage() },
								toolCall,
							),
						),
				}),
		);

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Done.");
	});

	it("emits failed tool results when handler errors become ActionResults", async () => {
		const runtime = makeRuntime(
			[],
			[
				makeAction({
					name: "BOOM",
					handler: async () => {
						throw new Error("handler failed");
					},
				}),
			],
		);
		const onToolResult = vi.fn();

		const result = await runWithStreamingContext(
			{
				onStreamChunk: vi.fn(),
				onToolResult,
				messageId: "message-1",
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ id: "call-err", name: "BOOM", params: {} },
				),
		);

		expect(result.success).toBe(false);
		expect(onToolResult).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId: "message-1",
				toolCallId: "call-err",
				status: "failed",
				result: expect.objectContaining({
					success: false,
					error: "handler failed",
				}),
			}),
		);
	});

	it("emits context events appended by the sub-planner", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
		});
		const runtime = makeRuntime(
			[
				JSON.stringify({
					thought: "No child tool needed.",
					toolCalls: [],
					messageToUser: "Done.",
				}),
			],
			[parent, child],
		);
		const onContextEvent = vi.fn();

		await runWithStreamingContext(
			{
				onStreamChunk: vi.fn(),
				onContextEvent,
			},
			() =>
				runSubPlanner({
					runtime: runtime as IAgentRuntime & {
						useModel: IAgentRuntime["useModel"];
					},
					action: parent,
					context: { id: "ctx", events: [] },
					ctx: { message: makeMessage() },
				}),
		);

		expect(onContextEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "sub-planner:PARENT:tool:CHILD",
				type: "tool",
				tool: expect.objectContaining({ name: "CHILD" }),
			}),
		);
	});
});
