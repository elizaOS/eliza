/**
 * Exercises the in-memory adapter's lifecycle and unmocked batch storage paths
 * for agents, caches, components, pending tasks, and room participants.
 */
import { describe, expect, it } from "vitest";
import type { Agent, Component, Memory, Task, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OTHER_AGENT_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ENTITY_ID = "10000000-0000-0000-0000-000000000001" as UUID;
const OTHER_ENTITY_ID = "10000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "20000000-0000-0000-0000-000000000001" as UUID;
const OTHER_ROOM_ID = "20000000-0000-0000-0000-000000000002" as UUID;
const WORLD_ID = "30000000-0000-0000-0000-000000000001" as UUID;
const OTHER_WORLD_ID = "30000000-0000-0000-0000-000000000002" as UUID;
const COMPONENT_ID = "40000000-0000-0000-0000-000000000001" as UUID;
const TASK_ID = "50000000-0000-0000-0000-000000000001" as UUID;
const OTHER_TASK_ID = "50000000-0000-0000-0000-000000000002" as UUID;
const MISSING_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff" as UUID;
const MEMORY_ID = "60000000-0000-0000-0000-000000000001" as UUID;
const OTHER_MEMORY_ID = "60000000-0000-0000-0000-000000000002" as UUID;

function component(overrides: Partial<Component> = {}): Component {
	return {
		id: COMPONENT_ID,
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		sourceEntityId: AGENT_ID,
		type: "profile",
		createdAt: 1,
		data: { label: "original" },
		...overrides,
	};
}

describe("InMemoryDatabaseAdapter", () => {
	it("deletes a logical multi-row memory record through its atomic capability", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const memories: Memory[] = [MEMORY_ID, OTHER_MEMORY_ID].map((id) => ({
			id,
			agentId: AGENT_ID,
			entityId: ENTITY_ID,
			roomId: ROOM_ID,
			content: { text: `logical record ${id}` },
		}));
		await adapter.createMemories(
			memories.map((memory) => ({ memory, tableName: "facts" })),
		);

		await adapter.deleteMemoriesAtomically([MEMORY_ID, OTHER_MEMORY_ID]);

		await expect(
			adapter.getMemoriesByIds([MEMORY_ID, OTHER_MEMORY_ID]),
		).resolves.toEqual([]);
		await expect(
			adapter.getMemories({ roomId: ROOM_ID, tableName: "facts" }),
		).resolves.toEqual([]);
	});

	it("tracks lifecycle state and passes the real adapter through transactions", async () => {
		const adapter = new InMemoryDatabaseAdapter();

		await expect(adapter.isReady()).resolves.toBe(false);
		await adapter.initialize({ mode: "test" });
		await expect(adapter.isReady()).resolves.toBe(true);
		await expect(adapter.getConnection()).resolves.toBe(adapter.db);
		await expect(
			adapter.transaction(async (transactionAdapter) => {
				expect(transactionAdapter).toBe(adapter);
				return "committed";
			}),
		).resolves.toBe("committed");

		await expect(adapter.runMigrations()).resolves.toBeUndefined();
		await expect(adapter.runPluginMigrations()).resolves.toBeUndefined();
		await adapter.close();
		await expect(adapter.isReady()).resolves.toBe(false);
		await adapter.init();
		await expect(adapter.isReady()).resolves.toBe(true);
	});

	it("handles agent batch creation, ordered lookup, replacement, and missing deletion", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const withoutId = { name: "ignored" } satisfies Partial<Agent>;

		await expect(
			adapter.createAgents([
				{ id: AGENT_ID, name: "first", username: "first-user" },
				withoutId,
			]),
		).resolves.toEqual([AGENT_ID]);
		await expect(adapter.countAgents()).resolves.toBe(1);

		await adapter.updateAgents([
			{ agentId: AGENT_ID, agent: { name: "updated" } },
			{ agentId: OTHER_AGENT_ID, agent: { name: "created by update" } },
		]);
		const ordered = await adapter.getAgentsByIds([
			OTHER_AGENT_ID,
			MISSING_ID,
			AGENT_ID,
		]);
		expect(ordered.map((agent) => agent.id)).toEqual([
			OTHER_AGENT_ID,
			AGENT_ID,
		]);
		expect(ordered[1]).toMatchObject({
			name: "updated",
			username: "first-user",
		});

		await adapter.upsertAgents([{ id: AGENT_ID, name: "replacement" }]);
		await expect(adapter.getAgentsByIds([AGENT_ID])).resolves.toEqual([
			{ id: AGENT_ID, name: "replacement" },
		]);
		await expect(
			adapter.deleteAgents([MISSING_ID, OTHER_AGENT_ID]),
		).resolves.toBe(true);
		await expect(adapter.getAgents()).resolves.toEqual([
			{ id: AGENT_ID, name: "replacement" },
		]);
	});

	it("serializes cache values and safely ignores missing keys during reads and deletion", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const source = { count: 1, labels: ["stored"] };

		await expect(
			adapter.setCaches([
				{ key: "first", value: source },
				{ key: "second", value: { count: 2, labels: ["other"] } },
			]),
		).resolves.toBe(true);
		source.count = 99;

		const values = await adapter.getCaches<typeof source>([
			"missing",
			"second",
			"first",
		]);
		expect([...values.keys()]).toEqual(["second", "first"]);
		expect(values.get("first")).toEqual({ count: 1, labels: ["stored"] });

		values.get("first")?.labels.push("caller mutation");
		await expect(adapter.getCaches(["first"])).resolves.toEqual(
			new Map([["first", { count: 1, labels: ["stored"] }]]),
		);
		await expect(adapter.deleteCaches(["missing", "first"])).resolves.toBe(
			true,
		);
		await expect(adapter.getCaches(["first", "second"])).resolves.toEqual(
			new Map([["second", { count: 2, labels: ["other"] }]]),
		);
	});

	it("maintains component indexes across updates and returns defensive copies", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const original = component();
		await expect(adapter.createComponents([original])).resolves.toEqual([
			COMPONENT_ID,
		]);

		const [returned] = await adapter.getComponentsByIds([COMPONENT_ID]);
		expect(returned.data).toEqual({ label: "original" });
		if (returned.data) returned.data.label = "caller mutation";
		await expect(
			adapter.getComponentsByIds([COMPONENT_ID]),
		).resolves.toMatchObject([{ data: { label: "original" } }]);

		const moved = component({
			entityId: OTHER_ENTITY_ID,
			roomId: OTHER_ROOM_ID,
			worldId: OTHER_WORLD_ID,
			sourceEntityId: OTHER_AGENT_ID,
			type: "preferences",
			data: { label: "moved" },
		});
		await adapter.updateComponents([moved]);
		await expect(
			adapter.getComponentsByNaturalKeys([
				{
					entityId: ENTITY_ID,
					type: "profile",
					worldId: WORLD_ID,
					sourceEntityId: AGENT_ID,
				},
				{
					entityId: OTHER_ENTITY_ID,
					type: "preferences",
					worldId: OTHER_WORLD_ID,
					sourceEntityId: OTHER_AGENT_ID,
				},
			]),
		).resolves.toEqual([null, moved]);
		await expect(
			adapter.getComponentsForEntities([ENTITY_ID]),
		).resolves.toEqual([]);

		await adapter.deleteComponents([MISSING_ID, COMPONENT_ID]);
		await expect(adapter.getComponentsByIds([COMPONENT_ID])).resolves.toEqual(
			[],
		);
	});

	it("updates only queued pending tasks and preserves their stored identity", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const queued = {
			id: TASK_ID,
			name: "queued",
			tags: ["queue"],
		} satisfies Task;
		const completed = {
			id: OTHER_TASK_ID,
			name: "completed",
			tags: ["queue"],
			metadata: { status: "complete" },
		} satisfies Task;
		const notQueuedId = "50000000-0000-0000-0000-000000000003" as UUID;

		await adapter.createTasks([
			queued,
			completed,
			{ id: notQueuedId, name: "not queued", tags: ["other"] },
		]);
		await expect(
			adapter.updatePendingTask(MISSING_ID, { name: "missing" }),
		).resolves.toBe(false);
		await expect(
			adapter.updatePendingTask(OTHER_TASK_ID, { name: "not pending" }),
		).resolves.toBe(false);
		await expect(
			adapter.updatePendingTask(notQueuedId, { name: "not queued" }),
		).resolves.toBe(false);
		await expect(
			adapter.updatePendingTask(TASK_ID, {
				id: OTHER_TASK_ID,
				name: "claimed",
				metadata: { status: "pending" },
			}),
		).resolves.toBe(true);
		await expect(adapter.getTasksByIds([TASK_ID])).resolves.toMatchObject([
			{ id: TASK_ID, name: "claimed", metadata: { status: "pending" } },
		]);
	});

	it("keeps participant indexes in sync and treats removal of a missing pair as success", async () => {
		const adapter = new InMemoryDatabaseAdapter();

		await expect(
			adapter.createRoomParticipants([ENTITY_ID, OTHER_ENTITY_ID], ROOM_ID),
		).resolves.toEqual([
			`${ROOM_ID}:${ENTITY_ID}`,
			`${ROOM_ID}:${OTHER_ENTITY_ID}`,
		]);
		await expect(
			adapter.getParticipantsForRooms([ROOM_ID, OTHER_ROOM_ID]),
		).resolves.toEqual([
			{ roomId: ROOM_ID, entityIds: [ENTITY_ID, OTHER_ENTITY_ID] },
			{ roomId: OTHER_ROOM_ID, entityIds: [] },
		]);
		await expect(
			adapter.getParticipantUserStates([
				{ roomId: ROOM_ID, entityId: ENTITY_ID },
			]),
		).resolves.toEqual([null]);

		await adapter.updateParticipantUserStates([
			{ roomId: ROOM_ID, entityId: ENTITY_ID, state: "MUTED" },
		]);
		await expect(
			adapter.deleteParticipants([
				{ roomId: ROOM_ID, entityId: OTHER_ENTITY_ID },
				{ roomId: OTHER_ROOM_ID, entityId: MISSING_ID },
			]),
		).resolves.toBe(true);
		await expect(
			adapter.areRoomParticipants([
				{ roomId: ROOM_ID, entityId: ENTITY_ID },
				{ roomId: ROOM_ID, entityId: OTHER_ENTITY_ID },
			]),
		).resolves.toEqual([true, false]);
		await expect(
			adapter.getRoomsForParticipants([OTHER_ENTITY_ID, ENTITY_ID]),
		).resolves.toEqual([ROOM_ID]);
		await expect(
			adapter.getParticipantUserStates([
				{ roomId: ROOM_ID, entityId: ENTITY_ID },
				{ roomId: ROOM_ID, entityId: OTHER_ENTITY_ID },
			]),
		).resolves.toEqual(["MUTED", null]);
	});
});
