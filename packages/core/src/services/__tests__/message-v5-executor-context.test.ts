/**
 * Regression coverage for the v5 planner action-execution context. Interactive
 * actions emit widgets through the action callback, so every v5 planned-tool
 * path must preserve the message-service callback when it invokes handlers.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { executePlannedToolCall } from "../../runtime/execute-planned-tool-call";
import type {
	Action,
	ActionResult,
	AgentContext,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "../../types";
import { __buildV5ExecutorContextForTests } from "../message";

describe("v5 planner executor context", () => {
	it("preserves the visible action callback and previous planner results", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const previousResults: ActionResult[] = [
			{ success: true, text: "selected app candidate" },
		];
		const message = {
			id: "message",
			roomId: "room",
			entityId: "user",
			content: { text: "create a notes app" },
		} as unknown as Memory;

		const ctx = __buildV5ExecutorContextForTests({
			message,
			state: { values: {}, data: {}, text: "" },
			selectedContexts: ["apps" as AgentContext],
			senderRole: "USER",
			previousResults,
			callback,
		});

		expect(ctx.message).toBe(message);
		expect(ctx.activeContexts).toEqual(["apps"]);
		expect(ctx.userRoles).toEqual(["USER"]);
		expect(ctx.previousResults).toBe(previousResults);

		await ctx.callback?.(
			{ text: "[CHOICE:app-create id=abc]\nnew=New app\n[/CHOICE]" },
			"APP",
		);

		expect(callback).toHaveBeenCalledWith(
			{ text: "[CHOICE:app-create id=abc]\nnew=New app\n[/CHOICE]" },
			"APP",
		);
	});

	it("lets planned-tool handlers emit visible widget callbacks", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const widgetText = "[CHOICE:app-create id=abc]\nnew=New app\n[/CHOICE]";
		const action: Action = {
			name: "APP",
			description: "Application manager",
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: widgetText });
				return { success: true, text: "choice emitted" };
			},
		};
		const runtime = {
			actions: [action],
			logger: {
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as unknown as IAgentRuntime;
		const message = {
			id: "message",
			roomId: "room",
			entityId: "user",
			content: { text: "create a notes app" },
		} as unknown as Memory;

		const result = await executePlannedToolCall(
			runtime,
			__buildV5ExecutorContextForTests({
				message,
				state: { values: {}, data: {}, text: "" },
				selectedContexts: ["apps" as AgentContext],
				senderRole: "USER",
				previousResults: [],
				callback,
			}),
			{ name: "APP", params: {} },
			{ actions: [action] },
		);

		expect(result.success).toBe(true);
		expect(callback).toHaveBeenCalledWith({ text: widgetText }, "APP");
	});

	it("keeps both v5 executeV5PlannedToolCall call sites on the shared context builder", () => {
		const source = readFileSync(
			new URL("../message.ts", import.meta.url),
			"utf8",
		);
		expect(source.match(/executorCtx:\s*buildV5ExecutorContext/g)).toHaveLength(
			2,
		);
	});
});
