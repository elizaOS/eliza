/**
 * Exercises `wrapSingleTurnVisibleCallback` (services/message): action-callback
 * text is rewritten through TEXT_SMALL into natural language, while passive REPLY
 * callbacks pass through untouched. Uses a real AgentRuntime with deterministic
 * registered model handlers so model routing and action lookup remain in-path.
 */
import { describe, expect, it } from "vitest";
import { createCharacter } from "../../character";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import type { Action, Content, HandlerCallback, Memory } from "../../types";
import { ModelType } from "../../types";
import { stringToUuid } from "../../utils";
import { wrapSingleTurnVisibleCallback } from "../message";

interface DeliveredCallback {
	content: Content;
	actionName: string | undefined;
}

function createRuntime(
	modelHandler: Parameters<AgentRuntime["registerModel"]>[1],
	actions: Action[] = [],
): AgentRuntime {
	const runtime = new AgentRuntime({
		character: createCharacter({
			name: "Action callback voice test",
			system: "Speak with crisp, helpful confidence.",
			style: { all: ["clear", "warm"] },
		}),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.registerModel(ModelType.TEXT_SMALL, modelHandler, "voice-test", 100);
	for (const action of actions) {
		runtime.registerAction(action);
	}
	return runtime;
}

function createDeliveryCapture(): {
	deliveries: DeliveredCallback[];
	callback: HandlerCallback;
} {
	const deliveries: DeliveredCallback[] = [];
	return {
		deliveries,
		callback: async (content, actionName) => {
			deliveries.push({ content, actionName });
			return [];
		},
	};
}

function createMessage(): Pick<Memory, "id" | "roomId" | "entityId"> {
	return {
		id: stringToUuid("action-callback-voice-message"),
		roomId: stringToUuid("action-callback-voice-room"),
		entityId: stringToUuid("action-callback-voice-user"),
	};
}

describe("action callback voice rewriting", () => {
	it("rewrites action callback text through TEXT_SMALL and delivers parsed natural language", async () => {
		let receivedPrompt: string | undefined;
		let modelCalls = 0;
		const runtime = createRuntime(async (_runtime, params) => {
			modelCalls += 1;
			if (typeof params.prompt !== "string") {
				throw new TypeError("TEXT_SMALL prompt must be a string");
			}
			receivedPrompt = params.prompt;
			return JSON.stringify({
				response: "I created the task and kept its ID handy: abc123.",
			});
		});
		const { callback, deliveries } = createDeliveryCapture();

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			createMessage(),
			callback,
		);
		await wrapped?.({ text: "stdout: created task id=abc123" }, "CREATE_TASK");

		expect(modelCalls).toBe(1);
		expect(receivedPrompt).toContain("Original action payload");
		expect(receivedPrompt).toContain("stdout: created task id=abc123");
		expect(deliveries).toEqual([
			{
				actionName: "CREATE_TASK",
				content: expect.objectContaining({
					text: "I created the task and kept its ID handy: abc123.",
					data: expect.objectContaining({
						rawActionText: "stdout: created task id=abc123",
						voiceRewritten: true,
					}),
				}),
			},
		]);
	});

	it("does not rewrite passive reply callbacks", async () => {
		let modelCalls = 0;
		const runtime = createRuntime(async () => {
			modelCalls += 1;
			return JSON.stringify({ response: "Unexpected rewrite." });
		});
		const { callback, deliveries } = createDeliveryCapture();

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			createMessage(),
			callback,
		);
		await wrapped?.({ text: "Already model-written." }, "REPLY");

		expect(modelCalls).toBe(0);
		expect(deliveries).toEqual([
			{
				actionName: "REPLY",
				content: { text: "Already model-written." },
			},
		]);
	});

	it("preserves canonical VIEWS callbacks without a TEXT_SMALL rewrite", async () => {
		let modelCalls = 0;
		const runtime = createRuntime(async () => {
			modelCalls += 1;
			return JSON.stringify({ response: "Unexpected rewrite." });
		}, [
			{
				name: "VIEWS",
				description: "Navigate to a registered application view.",
				handler: async () => ({ success: true }),
				validate: async () => true,
				preserveCallbackText: true,
			},
		]);
		const { callback, deliveries } = createDeliveryCapture();

		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			createMessage(),
			callback,
		);
		await wrapped?.({ text: "Navigated to Notes." }, "VIEWS");

		expect(modelCalls).toBe(0);
		expect(deliveries).toEqual([
			{
				actionName: "VIEWS",
				content: { text: "Navigated to Notes." },
			},
		]);
	});

	it.each([
		["unchanged", async () => JSON.stringify({ response: "Exact result." })],
		["malformed", async () => "not json"],
		[
			"failed",
			async () => {
				throw new Error("formatter unavailable");
			},
		],
	])(
		"keeps the original action text when rewriting is %s",
		async (_case, model) => {
			let modelCalls = 0;
			const runtime = createRuntime(async () => {
				modelCalls += 1;
				return model();
			});
			const { callback, deliveries } = createDeliveryCapture();

			const wrapped = wrapSingleTurnVisibleCallback(
				runtime,
				createMessage(),
				callback,
			);
			await wrapped?.({ text: "Exact result." }, "CREATE_TASK");

			expect(modelCalls).toBe(1);
			expect(deliveries).toEqual([
				{
					actionName: "CREATE_TASK",
					content: { text: "Exact result." },
				},
			]);
		},
	);
});
