import { describe, expect, it, vi } from "vitest";
import { emitStreamingHook, type StreamingContext } from "../streaming-context";
import type { EvaluationResult } from "../types/components";
import type { ContextEvent } from "../types/context-object";
import type { ToolCall } from "../types/model";

describe("streaming context event hooks", () => {
	it("no-ops when optional hooks are absent", async () => {
		const context: StreamingContext = {
			onStreamChunk: vi.fn(),
		};
		const toolCall: ToolCall = {
			id: "call-1",
			name: "LOOKUP",
			arguments: { query: "status" },
		};

		await expect(
			emitStreamingHook(context, "onToolCall", { toolCall }),
		).resolves.toBeUndefined();
		await expect(
			emitStreamingHook(undefined, "onToolCall", { toolCall }),
		).resolves.toBeUndefined();
	});

	it("forwards tool, result, evaluation, and context event payloads", async () => {
		const onToolCall = vi.fn();
		const onToolResult = vi.fn();
		const onEvaluation = vi.fn();
		const onContextEvent = vi.fn();
		const context: StreamingContext = {
			onStreamChunk: vi.fn(),
			onToolCall,
			onToolResult,
			onEvaluation,
			onContextEvent,
			messageId: "message-1",
		};
		const contextEvent: ContextEvent = {
			id: "event-1",
			type: "tool",
			tool: {
				id: "tool-1",
				name: "LOOKUP",
				metadata: { query: "status" },
			},
		};
		const toolCall: ToolCall = {
			id: "call-1",
			name: "LOOKUP",
			arguments: { query: "status" },
			status: "pending",
		};
		const evaluation: EvaluationResult = {
			success: true,
			decision: "FINISH",
			thought: "Done.",
			messageToUser: "Done.",
		};

		await emitStreamingHook(context, "onToolCall", {
			toolCall,
			contextEvent,
			messageId: "message-1",
		});
		await emitStreamingHook(context, "onToolResult", {
			toolCall: { ...toolCall, status: "completed", result: "ok" },
			toolCallId: "call-1",
			result: "ok",
			status: "completed",
			contextEvent,
			messageId: "message-1",
		});
		await emitStreamingHook(context, "onEvaluation", {
			evaluation,
			contextEvent,
			messageId: "message-1",
		});
		await emitStreamingHook(context, "onContextEvent", contextEvent);

		expect(onToolCall).toHaveBeenCalledWith({
			toolCall,
			contextEvent,
			messageId: "message-1",
		});
		expect(onToolResult).toHaveBeenCalledWith({
			toolCall: { ...toolCall, status: "completed", result: "ok" },
			toolCallId: "call-1",
			result: "ok",
			status: "completed",
			contextEvent,
			messageId: "message-1",
		});
		expect(onEvaluation).toHaveBeenCalledWith({
			evaluation,
			contextEvent,
			messageId: "message-1",
		});
		expect(onContextEvent).toHaveBeenCalledWith(contextEvent);
	});

	it("isolates hook failures from callers", async () => {
		const context: StreamingContext = {
			onStreamChunk: vi.fn(),
			onToolCall: vi.fn(async () => {
				throw new Error("observer failed");
			}),
		};
		const toolCall: ToolCall = {
			id: "call-1",
			name: "LOOKUP",
			arguments: {},
		};

		await expect(
			emitStreamingHook(context, "onToolCall", { toolCall }),
		).resolves.toBeUndefined();
	});
});
