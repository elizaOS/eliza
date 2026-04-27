import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Action, Character, Memory, State } from "../types";
import { stringToUuid } from "../utils";

const TEST_CHARACTER: Character = {
	id: stringToUuid("runtime-action-validation"),
	name: "Runtime Action Validation",
	bio: ["Test runtime"],
	templates: {},
	plugins: [],
	knowledge: [],
	secrets: {},
	settings: {},
	messageExamples: [],
	postExamples: [],
	topics: [],
	adjectives: [],
	style: { all: [], chat: [], post: [] },
};

function buildTestMessage(agentId: string): Memory {
	return {
		id: stringToUuid("message-1"),
		agentId: agentId as ReturnType<typeof stringToUuid>,
		entityId: stringToUuid("user-1"),
		roomId: stringToUuid("room-1"),
		content: { text: "send this out" },
		createdAt: Date.now(),
	};
}

const EMPTY_STATE: State = {
	values: {},
	data: {},
};

describe("AgentRuntime.processActions parameter validation", () => {
	it("skips handlers when extracted action parameters fail validation", async () => {
		const runtime = new AgentRuntime({
			adapter: new InMemoryDatabaseAdapter(),
			character: TEST_CHARACTER,
			logLevel: "error",
		});
		const handler = vi.fn(async () => undefined);
		const action: Action = {
			name: "CROSS_CHANNEL_SEND",
			description: "Send a message across channels.",
			handler,
			validate: async () => true,
			parameters: [
				{
					name: "channel",
					description: "Target channel.",
					required: true,
					schema: { type: "string", enum: ["email", "sms"] },
				},
			],
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		vi.spyOn(runtime, "createMemory").mockResolvedValue(
			stringToUuid("memory-1"),
		);

		await runtime.processActions(
			buildTestMessage(runtime.agentId),
			[
				{
					content: {
						actions: ["CROSS_CHANNEL_SEND"],
						params:
							"<CROSS_CHANNEL_SEND><channel>gmail</channel></CROSS_CHANNEL_SEND>",
					},
				},
			],
			EMPTY_STATE,
		);

		expect(handler).not.toHaveBeenCalled();
	});

	it("passes validated parameters through to the action handler", async () => {
		const runtime = new AgentRuntime({
			adapter: new InMemoryDatabaseAdapter(),
			character: TEST_CHARACTER,
			logLevel: "error",
		});
		const handler = vi.fn(async () => undefined);
		const action: Action = {
			name: "CROSS_CHANNEL_SEND",
			description: "Send a message across channels.",
			handler,
			validate: async () => true,
			parameters: [
				{
					name: "channel",
					description: "Target channel.",
					required: true,
					schema: { type: "string", enum: ["email", "sms"] },
				},
			],
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		vi.spyOn(runtime, "createMemory").mockResolvedValue(
			stringToUuid("memory-2"),
		);

		await runtime.processActions(
			buildTestMessage(runtime.agentId),
			[
				{
					content: {
						actions: ["CROSS_CHANNEL_SEND"],
						params:
							"<CROSS_CHANNEL_SEND><channel>email</channel></CROSS_CHANNEL_SEND>",
					},
				},
			],
			EMPTY_STATE,
		);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0]?.[3]).toMatchObject({
			parameters: {
				channel: "email",
			},
		});
	});

	it("keeps suppressed action result text available for prompts without visible callback", async () => {
		const runtime = new AgentRuntime({
			adapter: new InMemoryDatabaseAdapter(),
			character: TEST_CHARACTER,
			logLevel: "error",
		});
		const action: Action = {
			name: "SHELL_COMMAND",
			description: "Run a shell command.",
			validate: async () => true,
			handler: async () => ({
				success: true,
				text: "Command output for the follow-up LLM response.",
				data: {
					actionName: "SHELL_COMMAND",
					suppressVisibleCallback: true,
				},
			}),
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		const createMemory = vi
			.spyOn(runtime, "createMemory")
			.mockResolvedValue(stringToUuid("memory-3"));
		const callback = vi.fn(async () => []);
		const message = buildTestMessage(runtime.agentId);

		await runtime.processActions(
			message,
			[
				{
					content: {
						actions: ["SHELL_COMMAND"],
					},
				},
			],
			EMPTY_STATE,
			callback,
		);

		expect(callback).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
		expect(runtime.getActionResults(message.id)).toEqual([
			expect.objectContaining({
				success: true,
				text: "Command output for the follow-up LLM response.",
				data: expect.objectContaining({
					actionName: "SHELL_COMMAND",
					suppressVisibleCallback: true,
				}),
			}),
		]);
	});
});
