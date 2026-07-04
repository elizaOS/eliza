/**
 * Exercises `wrapSingleTurnVisibleCallback` (services/message): action-callback
 * text is rewritten through TEXT_SMALL into natural language, while passive REPLY
 * callbacks pass through untouched. Runs against a mock runtime with a stubbed model.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { HandlerCallback, Memory } from "../../types";
import { ModelType } from "../../types";
import { wrapSingleTurnVisibleCallback } from "../message";

describe("action callback voice rewriting", () => {
	it("rewrites action callback text through TEXT_SMALL and delivers parsed natural language", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			agentId: "agent",
			character: {
				name: "Example",
				system: "Speak with crisp, helpful confidence.",
				style: { all: ["clear", "warm"] },
			},
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
			useModel: vi.fn(
				async (modelType: ModelType, params: { prompt: string }) => {
					expect(modelType).toBe(ModelType.TEXT_SMALL);
					expect(params.prompt).toContain("Original action payload");
					expect(params.prompt).toContain("stdout: created task id=abc123");
					return JSON.stringify({
						response: "I created the task and kept its ID handy: abc123.",
					});
				},
			),
		});
		const message = {
			id: "message",
			roomId: "room",
			entityId: "user",
		} as unknown as Memory;

		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({ text: "stdout: created task id=abc123" }, "CREATE_TASK");

		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "I created the task and kept its ID handy: abc123.",
				data: expect.objectContaining({
					rawActionText: "stdout: created task id=abc123",
					voiceRewritten: true,
				}),
			}),
			"CREATE_TASK",
		);
	});

	it("does not rewrite passive reply callbacks", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const runtime = createMockRuntime({
			agentId: "agent",
			character: { name: "Example" },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(),
		});
		const message = {
			id: "message",
			roomId: "room",
			entityId: "user",
		} as unknown as Memory;

		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({ text: "Already model-written." }, "REPLY");

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(callback).toHaveBeenCalledWith(
			{ text: "Already model-written." },
			"REPLY",
		);
	});
});
