import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { createTaskClipboardService } from "../features/advanced-capabilities/clipboard/services/taskClipboardService";
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

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function buildTestMessage(
	agentId: string,
	content: Partial<Memory["content"]> = {},
): Memory {
	return {
		id: stringToUuid("message-1"),
		agentId: agentId as ReturnType<typeof stringToUuid>,
		entityId: stringToUuid("user-1"),
		roomId: stringToUuid("room-1"),
		content: { text: "send this out", ...content },
		createdAt: Date.now(),
	};
}

async function buildRuntimeWithClipboard(): Promise<AgentRuntime> {
	const clipboardBasePath = await mkdtemp(
		join(tmpdir(), "runtime-action-clipboard-"),
	);
	tempDirs.push(clipboardBasePath);
	return new AgentRuntime({
		adapter: new InMemoryDatabaseAdapter(),
		character: {
			...TEST_CHARACTER,
			settings: {
				...TEST_CHARACTER.settings,
				CLIPBOARD_BASE_PATH: clipboardBasePath,
			},
		},
		logLevel: "error",
	});
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

	it("copies result-only action output to task clipboard when requested", async () => {
		const runtime = await buildRuntimeWithClipboard();
		const action: Action = {
			name: "REPORT",
			description: "Generate a report.",
			validate: async () => true,
			handler: async () => ({
				success: true,
				text: "Report output",
				data: { actionName: "REPORT" },
			}),
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		vi.spyOn(runtime, "createMemory").mockResolvedValue(
			stringToUuid("memory-4"),
		);
		const callback = vi.fn(async () => []);
		const message = buildTestMessage(runtime.agentId, {
			text: "Run the report and copy result to clipboard",
		});

		await runtime.processActions(
			message,
			[{ content: { actions: ["REPORT"] } }],
			EMPTY_STATE,
			callback,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		const callbackContent = callback.mock.calls[0]?.[0];
		expect(callbackContent?.text).toContain("Report output");
		expect(callbackContent?.text).toContain(
			"Copied REPORT result to clipboard item",
		);
		const items = await createTaskClipboardService(runtime).listItems(
			message.entityId,
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			title: "REPORT result",
			content: "Report output",
			sourceType: "action_result",
			sourceLabel: "REPORT",
		});
	});

	it("appends clipboard status to a handler callback without duplicating result text", async () => {
		const runtime = await buildRuntimeWithClipboard();
		const action: Action = {
			name: "CALLBACK_REPORT",
			description: "Generate a callback report.",
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, callback) => {
				await callback?.({ text: "Visible report" });
				return {
					success: true,
					text: "Structured report",
					data: { actionName: "CALLBACK_REPORT" },
				};
			},
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		vi.spyOn(runtime, "createMemory").mockResolvedValue(
			stringToUuid("memory-5"),
		);
		const callback = vi.fn(async () => []);
		const message = buildTestMessage(runtime.agentId, {
			text: "Run the report and copy it to clipboard",
		});

		await runtime.processActions(
			message,
			[{ content: { actions: ["CALLBACK_REPORT"] } }],
			EMPTY_STATE,
			callback,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		const callbackText = callback.mock.calls[0]?.[0]?.text;
		expect(callbackText).toContain("Visible report");
		expect(callbackText).toContain(
			"Copied CALLBACK_REPORT result to clipboard item",
		);
		expect(callbackText).not.toContain("Structured report");
		const items = await createTaskClipboardService(runtime).listItems(
			message.entityId,
		);
		expect(items[0]?.content).toBe("Structured report");
	});

	it("copies callback-only action output when no result text is returned", async () => {
		const runtime = await buildRuntimeWithClipboard();
		const action: Action = {
			name: "CALLBACK_ONLY_REPORT",
			description: "Generate a callback-only report.",
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, callback) => {
				await callback?.({ text: "Callback-only report" });
				return undefined;
			},
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		vi.spyOn(runtime, "createMemory").mockResolvedValue(
			stringToUuid("memory-7"),
		);
		const callback = vi.fn(async () => []);
		const message = buildTestMessage(runtime.agentId, {
			text: "Run the callback report and copy it to clipboard",
		});

		await runtime.processActions(
			message,
			[{ content: { actions: ["CALLBACK_ONLY_REPORT"] } }],
			EMPTY_STATE,
			callback,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		const callbackText = callback.mock.calls[0]?.[0]?.text;
		expect(callbackText).toContain("Callback-only report");
		expect(callbackText).toContain(
			"Copied CALLBACK_ONLY_REPORT result to clipboard item",
		);
		const items = await createTaskClipboardService(runtime).listItems(
			message.entityId,
		);
		expect(items[0]?.content).toBe("Callback-only report");
	});

	it("does not copy terminal reply action output to task clipboard", async () => {
		const runtime = await buildRuntimeWithClipboard();
		const action: Action = {
			name: "REPLY",
			description: "Reply to the user.",
			validate: async () => true,
			handler: async () => ({
				success: true,
				text: "Plain reply",
				data: { actionName: "REPLY" },
			}),
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		vi.spyOn(runtime, "createMemory").mockResolvedValue(
			stringToUuid("memory-6"),
		);
		const callback = vi.fn(async () => []);
		const message = buildTestMessage(runtime.agentId, {
			text: "Reply and copy result to clipboard",
		});

		await runtime.processActions(
			message,
			[{ content: { actions: ["REPLY"] } }],
			EMPTY_STATE,
			callback,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback.mock.calls[0]?.[0]?.text).toBe("Plain reply");
		const items = await createTaskClipboardService(runtime).listItems(
			message.entityId,
		);
		expect(items).toHaveLength(0);
	});

	it("does not infer clipboard intent from negative wording", async () => {
		const runtime = await buildRuntimeWithClipboard();
		const action: Action = {
			name: "NEGATED_REPORT",
			description: "Generate a report.",
			validate: async () => true,
			handler: async () => ({
				success: true,
				text: "Negated report",
				data: { actionName: "NEGATED_REPORT" },
			}),
		};
		runtime.actions.push(action);
		vi.spyOn(runtime, "composeState").mockResolvedValue(EMPTY_STATE);
		vi.spyOn(runtime, "createMemory").mockResolvedValue(
			stringToUuid("memory-8"),
		);
		const callback = vi.fn(async () => []);
		const message = buildTestMessage(runtime.agentId, {
			text: "Run the report but do not copy it to clipboard",
		});

		await runtime.processActions(
			message,
			[{ content: { actions: ["NEGATED_REPORT"] } }],
			EMPTY_STATE,
			callback,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback.mock.calls[0]?.[0]?.text).toBe("Negated report");
		const items = await createTaskClipboardService(runtime).listItems(
			message.entityId,
		);
		expect(items).toHaveLength(0);
	});
});
