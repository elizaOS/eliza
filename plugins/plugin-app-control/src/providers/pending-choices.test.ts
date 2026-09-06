/**
 * Exercises persisted-choice prompt delivery and the registered response-handler
 * boundary with an in-memory task store and a deterministic registered model;
 * no live model or external effects run here.
 */
import { randomUUID } from "node:crypto";
import {
	asUUID,
	ChannelType,
	type IAgentRuntime,
	type Memory,
	type MessageHandlerResult,
	ModelType,
	type State,
	type Task,
	TaskStatus,
	type UUID,
} from "@elizaos/core";
import { createCharacter } from "@elizaos/core/character.js";
import { InMemoryDatabaseAdapter } from "@elizaos/core/database/inMemoryAdapter.js";
import { runResponseHandlerEvaluators } from "@elizaos/core/runtime/response-handler-evaluators.js";
import { AgentRuntime } from "@elizaos/core/runtime.js";
import { DefaultMessageService } from "@elizaos/core/services/message.js";
import { describe, expect, it, vi } from "vitest";
import { appControlPlugin } from "../index.js";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const roomId = "00000000-0000-0000-0000-000000000002" as UUID;
const message: Memory = {
	agentId,
	entityId: agentId,
	roomId,
	content: { text: "cancel", source: "client_chat" },
};
const state = { text: "", values: {}, data: {} } as State;

function runtimeWith(tasks: Task[]): IAgentRuntime {
	return {
		agentId,
		actions: appControlPlugin.actions,
		responseHandlerEvaluators: appControlPlugin.responseHandlerEvaluators,
		getTasks: vi.fn(async ({ tags }: { tags: string[] }) =>
			tasks.filter((task) => tags.every((tag) => task.tags?.includes(tag))),
		),
		reportError: vi.fn(),
		getRoom: vi.fn(async () => null),
		getSetting: vi.fn(() => undefined),
	} as unknown as IAgentRuntime;
}

function pending(kind: "APP" | "VIEWS" | "MODEL_SWITCH", suffix = ""): Task {
	return {
		id: `task-${kind}${suffix}` as UUID,
		agentId,
		name: `Pending ${kind}`,
		...(kind === "MODEL_SWITCH" ? { roomId } : {}),
		tags: [
			kind === "APP"
				? "app-create-intent"
				: kind === "VIEWS"
					? "views-create-intent"
					: "MODEL_SWITCH_TARGET_CHOICE",
		],
		metadata: {
			roomId,
			choiceActionName: kind,
			intent: "Create my complete design",
			choices: [{ key: "cancel", label: "Cancel" }],
			options: [{ name: "local", description: "On this device" }],
		},
	};
}

async function context(runtime: IAgentRuntime, inbound = message) {
	const providers =
		appControlPlugin.providers?.filter(
			(provider) => provider.alwaysInResponseState,
		) ?? [];
	return Promise.all(
		providers.map((provider) => provider.get(runtime, inbound, state)),
	);
}

describe("model-owned app-control choices", () => {
	it("includes only the current room's choices in the production Stage-1 model input", async () => {
		const ownerId = asUUID(randomUUID());
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "AppChoiceStage1" }),
			adapter: new InMemoryDatabaseAdapter(),
			settings: { ELIZA_ADMIN_ENTITY_ID: ownerId },
			logLevel: "fatal",
			enableAutonomy: false,
		});
		try {
			await runtime.initialize();
			for (const action of appControlPlugin.actions ?? [])
				runtime.registerAction(action);
			const provider = appControlPlugin.providers?.find(
				(entry) => entry.name === "app_control_choices",
			);
			if (!provider)
				throw new Error("app_control_choices is not registered by app-control");
			runtime.registerProvider(provider);
			const rooms = [asUUID(randomUUID()), asUUID(randomUUID())];
			for (const currentRoom of rooms) {
				await runtime.ensureConnection({
					entityId: ownerId,
					roomId: currentRoom,
					worldId: asUUID(randomUUID()),
					userName: "owner",
					name: "owner",
					source: "client_chat",
					type: ChannelType.DM,
				});
			}
			const roomATask = await runtime.createTask({
				...pending("APP"),
				id: asUUID(randomUUID()),
				agentId: runtime.agentId,
				metadata: {
					...pending("APP").metadata,
					roomId: rooms[0],
					intent: "STAGE1_ROOM_A_PRIVATE_CHOICE",
				},
			});
			await runtime.createTask({
				...pending("VIEWS"),
				id: asUUID(randomUUID()),
				agentId: runtime.agentId,
				roomId: rooms[1],
				metadata: {
					...pending("VIEWS").metadata,
					roomId: rooms[1],
					intent: "STAGE1_ROOM_B_PRIVATE_CHOICE",
				},
			});
			await runtime.createTask({
				...pending("MODEL_SWITCH"),
				id: asUUID(randomUUID()),
				agentId: asUUID(randomUUID()),
				roomId: rooms[0],
				metadata: {
					...pending("MODEL_SWITCH").metadata,
					roomId: rooms[0],
					intent: "STAGE1_OTHER_AGENT_PRIVATE_CHOICE",
				},
			});
			const modelInputs: string[] = [];
			// Only the model is deterministic. Stage-1 selection, state composition,
			// task reads, role resolution, and message delivery are production code.
			runtime.registerModel(
				ModelType.RESPONSE_HANDLER,
				async (_runtime, params) => {
					modelInputs.push(JSON.stringify(params));
					return {
						text: "",
						finishReason: "tool_calls",
						toolCalls: [
							{
								id: `stage1-${modelInputs.length}`,
								name: "HANDLE_RESPONSE",
								arguments: {
									shouldRespond: "RESPOND",
									thought: "Clarify without taking an action.",
									contexts: ["simple"],
									intents: [],
									candidateActionNames: [],
									replyText: "Which choice would you like to discuss?",
									facts: [],
									relationships: [],
									addressedTo: [],
								},
							},
						],
					};
				},
				"deterministic-stage1-test",
			);
			const service = new DefaultMessageService();
			for (const currentRoom of rooms) {
				const result = await service.handleMessage(
					runtime,
					{
						id: asUUID(randomUUID()),
						agentId: runtime.agentId,
						entityId: ownerId,
						roomId: currentRoom,
						createdAt: Date.now(),
						content: {
							text: "Can we discuss the pending choice?",
							source: "client_chat",
							channelType: ChannelType.DM,
						},
					},
					async () => [],
				);
				expect(result.didRespond).toBe(true);
				expect(result.mode).toBe("simple");
			}
			expect(modelInputs).toHaveLength(2);
			expect(modelInputs[0]).toContain("Pending app-control choices");
			expect(modelInputs[0]).toContain("STAGE1_ROOM_A_PRIVATE_CHOICE");
			expect(modelInputs[0]).not.toContain("STAGE1_ROOM_B_PRIVATE_CHOICE");
			expect(modelInputs[1]).toContain("STAGE1_ROOM_B_PRIVATE_CHOICE");
			expect(modelInputs[1]).not.toContain("STAGE1_ROOM_A_PRIVATE_CHOICE");
			expect(modelInputs.join("\n")).not.toContain(
				"STAGE1_OTHER_AGENT_PRIVATE_CHOICE",
			);
			// Neither the provider nor Stage 1 silently consumed the pending pick.
			expect(await runtime.getTask(roomATask)).not.toBeNull();
		} finally {
			await runtime.stop();
			await runtime.close();
		}
	}, 30_000);

	it("does not replace a model decision with an exact-token action dispatch", async () => {
		const runtime = runtimeWith([pending("APP")]);
		// This caller has app creation but no GUI navigation surface.
		runtime.actions = runtime.actions.filter((action) => action.name === "APP");
		const handler = {
			processMessage: "RESPOND",
			thought: "Ask about the current request",
			plan: {
				contexts: ["general"],
				requiresTool: false,
				reply: "Do you want to stop this request or cancel the app creation?",
			},
		} as MessageHandlerResult;
		const original = structuredClone(handler);
		await runResponseHandlerEvaluators({
			runtime,
			message,
			state,
			messageHandler: handler,
			availableContexts: [{ id: "general" }],
		});
		expect(handler).toEqual(original);
	});

	it("delivers every room-scoped pending owner choice before action selection without picking one", async () => {
		const tasks = [pending("APP"), pending("VIEWS"), pending("MODEL_SWITCH")];
		const results = await context(runtimeWith(tasks));
		const text = results.map((result) => result.text).join("\n");
		for (const task of tasks) {
			expect(text).toContain(task.id);
			expect(text).toContain(task.name);
		}
		expect(text).toContain("MODEL_SWITCH");
		expect(text).toContain("Create my complete design");
	});

	it("keeps complete long choices and later tasks, then stops exposing consumed tasks", async () => {
		const tasks = Array.from({ length: 35 }, (_, index) =>
			pending("VIEWS", String(index)),
		);
		const completeIntent = `begin-${"full context ".repeat(3000)}-end`;
		tasks[34].metadata = { ...tasks[34].metadata, intent: completeIntent };
		const runtime = runtimeWith(tasks);
		const results = await context(runtime);
		expect(results.map((result) => result.text).join("\n")).toContain(
			completeIntent,
		);
		tasks.splice(0);
		expect((await context(runtime)).every((result) => result.text === "")).toBe(
			true,
		);
	});

	it("does not expose choices from other rooms or agents, even if the store returns them", async () => {
		const wrongRoom = pending("APP");
		wrongRoom.metadata = { ...wrongRoom.metadata, roomId: "other-room" };
		const wrongAgent = { ...pending("VIEWS"), agentId: "other-agent" as UUID };
		const runtime = runtimeWith([wrongRoom, wrongAgent]);
		expect((await context(runtime)).every((result) => result.text === "")).toBe(
			true,
		);
	});

	it("excludes another entity's explicitly bound task while keeping legacy unbound tasks readable", async () => {
		const otherEntityTask = {
			...pending("APP", "other-entity"),
			entityId: asUUID(randomUUID()),
		};
		const legacyTask = pending("VIEWS", "legacy-unbound");
		const text = (await context(runtimeWith([otherEntityTask, legacyTask])))
			.map((result) => result.text)
			.join("\n");
		expect(text).not.toContain(otherEntityTask.id);
		expect(text).toContain(legacyTask.id);
	});

	it.each(["APP", "VIEWS", "MODEL_SWITCH"] as const)(
		"exposes only pending and legacy unspecified %s tasks",
		async (kind) => {
			const readableTasks = [
				pending(kind, "status-absent"),
				{ ...pending(kind, "status-pending"), status: TaskStatus.PENDING },
				{
					...pending(kind, "status-unspecified"),
					status: TaskStatus.UNSPECIFIED,
				},
			];
			const excludedTasks = [
				TaskStatus.IN_PROGRESS,
				TaskStatus.COMPLETED,
				TaskStatus.FAILED,
				TaskStatus.CANCELLED,
			].map((status) => ({ ...pending(kind, `status-${status}`), status }));
			const text = (
				await context(runtimeWith([...readableTasks, ...excludedTasks]))
			)
				.map((result) => result.text)
				.join("\n");
			for (const task of readableTasks) expect(text).toContain(task.id);
			for (const task of excludedTasks) expect(text).not.toContain(task.id);
		},
	);

	it.each(["APP", "VIEWS", "MODEL_SWITCH"] as const)(
		"rejects conflicting %s room bindings without losing either supported legacy binding",
		async (kind) => {
			const base = pending(kind);
			const contradictoryTask = {
				...pending(kind, "contradictory-room"),
				roomId,
				metadata: { ...base.metadata, roomId: asUUID(randomUUID()) },
			};
			const readableTasks = [
				{ ...pending(kind, "metadata-room-only"), roomId: undefined },
				{
					...pending(kind, "top-level-room-only"),
					roomId,
					metadata: { ...base.metadata, roomId: undefined },
				},
				{ ...pending(kind, "matching-room-bindings"), roomId },
			];
			const text = (
				await context(runtimeWith([contradictoryTask, ...readableTasks]))
			)
				.map((result) => result.text)
				.join("\n");
			expect(text).not.toContain(contradictoryTask.id);
			for (const task of readableTasks) expect(text).toContain(task.id);
		},
	);

	it.each(["roomId", "entityId"] as const)(
		"does not query private tasks without %s",
		async (missing) => {
			const runtime = runtimeWith([pending("APP")]);
			const inbound = { ...message, [missing]: undefined } as Memory;
			await context(runtime, inbound);
			expect(runtime.getTasks).not.toHaveBeenCalled();
		},
	);

	it("fails closed for an unresolved external sender and does not query private tasks", async () => {
		const runtime = runtimeWith([pending("APP")]);
		const inbound = {
			...message,
			entityId: "00000000-0000-0000-0000-000000000003" as UUID,
			content: { text: "cancel", source: "discord" },
		};
		await context(runtime, inbound);
		expect(runtime.getTasks).not.toHaveBeenCalled();
	});

	it("surfaces task-store failure instead of claiming there are no pending choices", async () => {
		const runtime = runtimeWith([]);
		vi.mocked(runtime.getTasks).mockRejectedValue(
			new Error("task store unavailable"),
		);
		await expect(context(runtime)).rejects.toThrow("task store unavailable");
	});
});
