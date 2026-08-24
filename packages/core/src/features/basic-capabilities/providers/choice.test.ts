/**
 * Unit tests for the CHOICE pending-task picker provider, driving
 * choiceProvider.get against a deterministic mock runtime. Pins the task-store
 * query contract, both "no pending choices" guards, and the exact numbered
 * rendering of legacy string options alongside typed option objects.
 */
import { describe, expect, it } from "vitest";
import {
	createMockRuntime,
	MOCK_AGENT_ID,
} from "../../../testing/mock-runtime";
import type {
	IAgentRuntime,
	Memory,
	State,
	Task,
	TaskMetadata,
	UUID,
} from "../../../types/index.ts";
import choiceProviderDefault, { choiceProvider } from "./choice.ts";

const roomId = "00000000-0000-0000-0000-0000000000bb" as UUID;

const message = {
	agentId: MOCK_AGENT_ID,
	entityId: "00000000-0000-0000-0000-0000000000cc",
	roomId,
	content: { text: "What are my choices?" },
} as unknown as Memory;

const state: State = { values: {}, data: {}, text: "" };

function taskWith(name: string, metadata?: TaskMetadata): Task {
	return { name, roomId, metadata };
}

describe("CHOICE provider contract", () => {
	it("exposes the generated provider contract with turn scope and USER gate", () => {
		expect(choiceProvider).toMatchObject({
			name: "CHOICE",
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
		expect(typeof choiceProvider.description).toBe("string");
	});

	it("is also the default export", () => {
		expect(choiceProviderDefault).toBe(choiceProvider);
	});
});

describe("CHOICE provider.get", () => {
	it("queries the task store for this room, agent, and the AWAITING_CHOICE tag", async () => {
		const calls: Parameters<IAgentRuntime["getTasks"]>[0][] = [];
		const runtime = createMockRuntime({
			getTasks: async (params) => {
				calls.push(params);
				return [];
			},
		});

		await choiceProvider.get(runtime, message, state);

		expect(calls).toEqual([
			{ roomId, tags: ["AWAITING_CHOICE"], agentIds: [MOCK_AGENT_ID] },
		]);
	});

	it("renders the placeholder when the task store returns nothing", async () => {
		const runtime = createMockRuntime({
			getTasks: async () => [] as unknown as Task[],
		});
		const result = await choiceProvider.get(runtime, message, state);

		expect(result).toEqual({
			data: { tasks: [] },
			values: { tasks: "No pending choices for the moment." },
			text: "No pending choices for the moment.",
		});
	});

	it("renders the placeholder when the store reports no pending tasks at all", async () => {
		const runtime = createMockRuntime({
			getTasks: async () => null as unknown as Task[],
		});
		const result = await choiceProvider.get(runtime, message, state);

		expect(result.text).toBe("No pending choices for the moment.");
		expect(result.data.tasks).toEqual([]);
	});

	it("renders the placeholder when awaiting tasks carry no options field at all", async () => {
		const runtime = createMockRuntime({
			getTasks: async () => [taskWith("NO_OPTIONS")],
		});
		const result = await choiceProvider.get(runtime, message, state);

		expect(result.text).toBe("No pending choices for the moment.");
		expect(result.data.tasks).toEqual([]);
	});

	it("still lists a task whose options array is empty, with an empty Options block", async () => {
		const emptyOptions = taskWith("EMPTY_OPTIONS", { options: [] });
		const runtime = createMockRuntime({
			getTasks: async () => [emptyOptions],
		});
		const result = await choiceProvider.get(runtime, message, state);

		expect(result.text).toBe(
			"# Pending Tasks\n\n" +
				"The following tasks are awaiting your selection:\n\n" +
				"1. **EMPTY_OPTIONS**\n" +
				"   Options:\n" +
				"\n" +
				"To select an option, reply with the option name (e.g., 'post' or 'cancel').\n",
		);
		expect(result.data.tasks).toEqual([emptyOptions]);
	});

	it("renders only options-bearing tasks with their full numbered selection list", async () => {
		const pickColor = taskWith("PICK_COLOR", {
			options: ["red", { name: "blue", description: "The blue one" }],
		} as unknown as TaskMetadata);
		const confirmLaunch = {
			name: "CONFIRM_LAUNCH",
			roomId,
			description: "Confirm the launch.",
			metadata: {
				options: [
					{ name: "yes", description: "affirm" },
					{ name: "no", description: "" },
				],
			},
		};
		const ignored = taskWith("NOT_A_CHOICE");
		const runtime = createMockRuntime({
			getTasks: async () => [pickColor, ignored, confirmLaunch],
		});

		const result = await choiceProvider.get(runtime, message, state);

		const rendered =
			"# Pending Tasks\n\n" +
			"The following tasks are awaiting your selection:\n\n" +
			"1. **PICK_COLOR**\n" +
			"   Options:\n" +
			"   - `red` \n" +
			"   - `blue` - The blue one\n" +
			"\n" +
			"2. **CONFIRM_LAUNCH**\n" +
			"   Confirm the launch.\n" +
			"   Options:\n" +
			"   - `yes` - affirm\n" +
			"   - `no` \n" +
			"\n" +
			"To select an option, reply with the option name (e.g., 'post' or 'cancel').\n";
		expect(result.text).toBe(rendered);
		expect(result.values.tasks).toBe(rendered);
		expect(result.data.tasks).toEqual([pickColor, confirmLaunch]);
	});
});
