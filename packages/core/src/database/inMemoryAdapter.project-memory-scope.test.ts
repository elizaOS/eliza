/**
 * Real-adapter roundtrip for per-project memory scoping (#13776 item 4, D3).
 *
 * Proves the worldId-mapping isolation END-TO-END against the real
 * `InMemoryDatabaseAdapter` (no mock of the store), using the exact partition
 * mechanism the design specifies: each Project maps to a dedicated World; a
 * project's task rooms live under that World; memories written in those rooms
 * are retrieved via `getMemoriesByWorldId` (world → rooms → memories).
 *
 * The scoping helpers under test (`projectWorldId`, `scopeMemoryToProject`,
 * `assertMemoriesInProject`) drive the write side; the real adapter drives the
 * store side. Covers:
 *   (a) scoped write → scoped read roundtrip,
 *   (b) cross-project isolation (a read scoped to A never returns B),
 *   (c) legacy unscoped memories (no worldId, in a world-less room) remain
 *       retrievable via a plain roomId read and are NOT surfaced in a
 *       project-scoped world read.
 */

import { describe, expect, it } from "vitest";
import type { Memory, Room, UUID, World } from "../types";
import { ChannelType } from "../types";
import {
	assertMemoriesInProject,
	projectWorldId,
	scopeMemoryFilterToProject,
	scopeMemoryToProject,
} from "../utils/project-memory-scope.ts";
import { stringToUuid } from "../utils.ts";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter.ts";

const AGENT = stringToUuid("agent-roundtrip");
const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";
const TABLE = "memories";

async function setup() {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.init?.();

	const worldA = projectWorldId(AGENT, PROJECT_A);
	const worldB = projectWorldId(AGENT, PROJECT_B);
	const roomA = stringToUuid("room-a") as UUID;
	const roomB = stringToUuid("room-b") as UUID;

	const worlds: World[] = [
		{
			id: worldA,
			agentId: AGENT,
			name: "A",
			metadata: { kind: "project", projectId: PROJECT_A },
		},
		{
			id: worldB,
			agentId: AGENT,
			name: "B",
			metadata: { kind: "project", projectId: PROJECT_B },
		},
	];
	await adapter.createWorlds(worlds);

	const rooms: Room[] = [
		{
			id: roomA,
			agentId: AGENT,
			source: "test",
			type: ChannelType.GROUP,
			worldId: worldA,
		},
		{
			id: roomB,
			agentId: AGENT,
			source: "test",
			type: ChannelType.GROUP,
			worldId: worldB,
		},
	];
	await adapter.createRooms(rooms);

	const writeInProject = async (
		roomId: UUID,
		projectId: string,
		text: string,
	) => {
		const base: Memory = {
			entityId: stringToUuid(`e-${text}`) as UUID,
			roomId,
			content: { text },
		};
		const memory = scopeMemoryToProject(base, { agentId: AGENT, projectId });
		await adapter.createMemories([{ memory, tableName: TABLE }]);
	};

	return { adapter, worldA, worldB, roomA, roomB, writeInProject };
}

describe("per-project memory scoping — real InMemoryDatabaseAdapter roundtrip", () => {
	it("(a): a memory written under project A's world is retrievable by that world", async () => {
		const { adapter, worldA, roomA, writeInProject } = await setup();
		await writeInProject(roomA, PROJECT_A, "A note");

		const rows = await adapter.getMemoriesByWorldId({
			worldIds: [worldA],
			tableName: TABLE,
		});
		const scoped = assertMemoriesInProject(rows, {
			agentId: AGENT,
			projectId: PROJECT_A,
		});
		expect(scoped.map((m) => m.content.text)).toEqual(["A note"]);
		// The stamped worldId is exactly the project world.
		expect(scoped[0]?.worldId).toBe(worldA);
	});

	it("(b): a read scoped to project A never returns project B's memories", async () => {
		const { adapter, worldA, worldB, roomA, roomB, writeInProject } =
			await setup();
		await writeInProject(roomA, PROJECT_A, "A secret");
		await writeInProject(roomB, PROJECT_B, "B secret");

		const rowsA = assertMemoriesInProject(
			await adapter.getMemoriesByWorldId({
				worldIds: [worldA],
				tableName: TABLE,
			}),
			{ agentId: AGENT, projectId: PROJECT_A },
		);
		expect(rowsA.map((m) => m.content.text)).toEqual(["A secret"]);
		expect(rowsA.some((m) => m.content.text === "B secret")).toBe(false);

		const rowsB = assertMemoriesInProject(
			await adapter.getMemoriesByWorldId({
				worldIds: [worldB],
				tableName: TABLE,
			}),
			{ agentId: AGENT, projectId: PROJECT_B },
		);
		expect(rowsB.map((m) => m.content.text)).toEqual(["B secret"]);
	});

	it("(b2): getMemories honors a scoped worldId filter for same-room rows", async () => {
		const { adapter, roomA } = await setup();
		const projectAMemory = scopeMemoryToProject(
			{
				entityId: stringToUuid("e-a-same-room") as UUID,
				roomId: roomA,
				content: { text: "A same-room note" },
			} as Memory,
			{ agentId: AGENT, projectId: PROJECT_A },
		);
		const projectBMemory = scopeMemoryToProject(
			{
				entityId: stringToUuid("e-b-same-room") as UUID,
				roomId: roomA,
				content: { text: "B same-room note" },
			} as Memory,
			{ agentId: AGENT, projectId: PROJECT_B },
		);
		await adapter.createMemories([
			{ memory: projectAMemory, tableName: TABLE },
			{ memory: projectBMemory, tableName: TABLE },
		]);

		const rows = assertMemoriesInProject(
			await adapter.getMemories(
				scopeMemoryFilterToProject(
					{ tableName: TABLE, roomId: roomA },
					{ agentId: AGENT, projectId: PROJECT_A },
				),
			),
			{ agentId: AGENT, projectId: PROJECT_A },
		);

		expect(rows.map((m) => m.content.text)).toEqual(["A same-room note"]);
		expect(rows.some((m) => m.content.text === "B same-room note")).toBe(false);
	});

	it("(c): legacy unscoped memory stays retrievable and is not in any project world", async () => {
		const { adapter, worldA, roomA, writeInProject } = await setup();

		// A legacy memory: written with NO projectId (no worldId), in a world-less room.
		const legacyRoom = stringToUuid("legacy-room") as UUID;
		await adapter.createRooms([
			{
				id: legacyRoom,
				agentId: AGENT,
				source: "test",
				type: ChannelType.GROUP,
			},
		]);
		const legacy = scopeMemoryToProject(
			{
				entityId: stringToUuid("e-legacy") as UUID,
				roomId: legacyRoom,
				content: { text: "legacy note" },
			} as Memory,
			{ agentId: AGENT },
		);
		expect(legacy.worldId).toBeUndefined();
		await adapter.createMemories([{ memory: legacy, tableName: TABLE }]);

		// Also a scoped memory in project A.
		await writeInProject(roomA, PROJECT_A, "A note");

		// Legacy memory is still retrievable via a plain room read (global path).
		const legacyRows = await adapter.getMemories({
			tableName: TABLE,
			roomId: legacyRoom,
		});
		expect(legacyRows.map((m) => m.content.text)).toEqual(["legacy note"]);

		// Project A's world read returns only A's memory — legacy is NOT surfaced.
		const projARows = await adapter.getMemoriesByWorldId({
			worldIds: [worldA],
			tableName: TABLE,
		});
		expect(projARows.map((m) => m.content.text)).toEqual(["A note"]);
		expect(projARows.some((m) => m.content.text === "legacy note")).toBe(false);
	});
});
