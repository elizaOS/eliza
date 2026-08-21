/**
 * Verifies the slow provider I/O plans by observing when real provider calls
 * start, without wall-clock thresholds or substituted provider implementations.
 */
import { describe, expect, it, vi } from "vitest";
import { runWithTrajectoryContext } from "../trajectory-context.ts";
import type {
	Entity,
	IAgentRuntime,
	Memory,
	Relationship,
	State,
	UUID,
} from "../types/index.ts";
import { ChannelType, MemoryType } from "../types/index.ts";
import { factsProvider } from "./advanced-capabilities/providers/facts.ts";
import { relationshipsProvider } from "./advanced-capabilities/providers/relationships.ts";
import { worldProvider } from "./basic-capabilities/providers/world.ts";
import { documentsProvider } from "./documents/provider.ts";
import {
	createDocumentProviderRequesterResolver,
	DocumentService,
	resolveDocumentRequester,
} from "./documents/service.ts";

const agentId = "10000000-0000-0000-0000-000000000001" as UUID;
const entityId = "10000000-0000-0000-0000-000000000002" as UUID;
const secondEntityId = "10000000-0000-0000-0000-000000000003" as UUID;
const thirdEntityId = "10000000-0000-0000-0000-000000000004" as UUID;
const roomId = "10000000-0000-0000-0000-000000000005" as UUID;
const worldId = "10000000-0000-0000-0000-000000000006" as UUID;

const state: State = { values: {}, data: {}, text: "" };
const message: Memory = {
	id: "10000000-0000-0000-0000-000000000007" as UUID,
	agentId,
	entityId,
	roomId,
	worldId,
	content: {
		text: "What do we know about the project?",
		senderName: "Alice",
		channelType: ChannelType.DM,
	},
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((fulfill) => {
		resolve = fulfill;
	});
	return { promise, resolve };
}

function requesterRuntime(
	getRoomsForParticipants: IAgentRuntime["getRoomsForParticipants"],
): IAgentRuntime {
	return {
		agentId,
		getRoom: vi.fn(async () => ({ id: roomId, worldId })),
		getWorld: vi.fn(async () => ({
			id: worldId,
			name: "test world",
			metadata: {},
		})),
		getRoomsForParticipants,
		getSetting: vi.fn(() => undefined),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
}

describe("provider database I/O concurrency", () => {
	it("coalesces document authorization only inside a caller-owned read composition", async () => {
		const getRoomsForParticipants = vi.fn(async () => [roomId, roomId]);
		const runtime = requesterRuntime(getRoomsForParticipants);

		const [first, second] = await runWithTrajectoryContext(
			{ turnMemo: new Map<string, Promise<unknown>>() },
			() => {
				const resolveRequester = createDocumentProviderRequesterResolver(
					runtime,
					message,
				);
				return Promise.all([resolveRequester(), resolveRequester()]);
			},
		);

		expect(first).toEqual(second);
		expect(first.roomIds).toEqual([roomId]);
		expect(getRoomsForParticipants).toHaveBeenCalledOnce();

		await resolveDocumentRequester(runtime, message);
		expect(getRoomsForParticipants).toHaveBeenCalledTimes(2);
	});

	it("evicts rejected document requester work before a local retry", async () => {
		const failure = new Error("membership read failed");
		const getRoomsForParticipants = vi
			.fn<IAgentRuntime["getRoomsForParticipants"]>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce([roomId]);
		const runtime = requesterRuntime(getRoomsForParticipants);
		const resolveRequester = createDocumentProviderRequesterResolver(
			runtime,
			message,
		);

		await expect(
			Promise.all([resolveRequester(), resolveRequester()]),
		).rejects.toMatchObject({
			code: "DOCUMENT_ROOM_LOOKUP_FAILED",
			cause: failure,
		});
		await expect(resolveRequester()).resolves.toMatchObject({
			roomIds: [roomId],
		});
		expect(getRoomsForParticipants).toHaveBeenCalledTimes(2);
	});

	it("creates an independent document requester snapshot for each turn", async () => {
		const getRoomsForParticipants = vi
			.fn<IAgentRuntime["getRoomsForParticipants"]>()
			.mockResolvedValueOnce([roomId])
			.mockResolvedValueOnce([]);
		const runtime = requesterRuntime(getRoomsForParticipants);

		const first = await runWithTrajectoryContext(
			{ turnMemo: new Map<string, Promise<unknown>>() },
			() => createDocumentProviderRequesterResolver(runtime, message)(),
		);
		const second = await runWithTrajectoryContext(
			{ turnMemo: new Map<string, Promise<unknown>>() },
			() => createDocumentProviderRequesterResolver(runtime, message)(),
		);

		expect(first.roomIds).toEqual([roomId]);
		expect(second.roomIds).toEqual([]);
		expect(getRoomsForParticipants).toHaveBeenCalledTimes(2);
	});

	it("starts FACTS history and identity reads together, then starts every candidate pool together", async () => {
		const history = deferred<Memory[]>();
		const identities = deferred<UUID[]>();
		const candidatePools = new Map<
			string,
			ReturnType<typeof deferred<Memory[]>>
		>();
		const started: string[] = [];
		const getMemories = vi.fn(
			(params: { tableName: string; roomId?: UUID; entityId?: UUID }) => {
				if (params.tableName === "messages") {
					started.push("history");
					return history.promise;
				}
				const key = params.roomId
					? `room:${params.roomId}`
					: `entity:${params.entityId}`;
				started.push(key);
				const pending = deferred<Memory[]>();
				candidatePools.set(key, pending);
				return pending.promise;
			},
		);
		const getMemberEntityIds = vi.fn(() => {
			started.push("identities");
			return identities.promise;
		});
		const runtime = {
			agentId,
			character: { name: "Eliza" },
			getService: vi.fn((serviceType: string) =>
				serviceType === "relationships" ? { getMemberEntityIds } : null,
			),
			getMemories,
		} as unknown as IAgentRuntime;

		const resultPromise = factsProvider.get(runtime, message, state);
		await Promise.resolve();
		expect(started).toEqual(["history", "identities"]);

		history.resolve([]);
		identities.resolve([secondEntityId]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(started).toEqual(
			expect.arrayContaining([
				`room:${roomId}`,
				`entity:${entityId}`,
				`entity:${secondEntityId}`,
			]),
		);
		expect(candidatePools).toHaveLength(3);

		for (const pending of candidatePools.values()) pending.resolve([]);
		await expect(resultPromise).resolves.toMatchObject({
			text: "No facts available.",
		});
	});

	it("surfaces FACTS database failures instead of fabricating empty context", async () => {
		const failure = new Error("facts database unavailable");
		const runtime = {
			agentId,
			getService: vi.fn(() => null),
			getMemories: vi.fn(async () => {
				throw failure;
			}),
		} as unknown as IAgentRuntime;

		await expect(
			factsProvider.get(runtime, message, state),
		).rejects.toMatchObject({
			code: "FACTS_PROVIDER_READ_FAILED",
			cause: failure,
		});
	});

	it("loads every RELATIONSHIPS counterpart with one batch query", async () => {
		const relationships: Relationship[] = [
			{
				sourceEntityId: entityId,
				targetEntityId: secondEntityId,
				tags: ["friend"],
				metadata: { interactions: 3 },
			},
			{
				sourceEntityId: entityId,
				targetEntityId: thirdEntityId,
				tags: ["coworker"],
				metadata: { interactions: 2 },
			},
		];
		const entities: Entity[] = [
			{ id: secondEntityId, names: ["Bob"], metadata: {} },
			{ id: thirdEntityId, names: ["Carol"], metadata: {} },
		];
		const getEntitiesByIds = vi.fn(async () => entities);
		const getEntityById = vi.fn(async () => null);
		const runtime = {
			agentId,
			character: { name: "Eliza" },
			getService: vi.fn(() => null),
			getRelationships: vi.fn(async () => relationships),
			getEntitiesByIds,
			getEntityById,
		} as unknown as IAgentRuntime;

		const result = await relationshipsProvider.get(runtime, message, state);

		expect(getEntitiesByIds).toHaveBeenCalledOnce();
		expect(getEntitiesByIds).toHaveBeenCalledWith([
			secondEntityId,
			thirdEntityId,
		]);
		expect(getEntityById).not.toHaveBeenCalled();
		expect(result.text).toContain("Bob");
		expect(result.text).toContain("Carol");
	});

	it("does not send an empty RELATIONSHIPS batch for self-only records", async () => {
		const getEntitiesByIds = vi.fn(async () => []);
		const runtime = {
			agentId,
			character: { name: "Eliza" },
			getService: vi.fn(() => null),
			getRelationships: vi.fn(async () => [
				{
					sourceEntityId: entityId,
					targetEntityId: entityId,
					tags: ["self"],
					metadata: {},
				},
			]),
			getEntitiesByIds,
		} as unknown as IAgentRuntime;

		await relationshipsProvider.get(runtime, message, state);
		expect(getEntitiesByIds).not.toHaveBeenCalled();
	});

	it("starts WORLD room-list and participant reads together after the authoritative world exists", async () => {
		const world = deferred<{ id: UUID; name: string }>();
		const rooms =
			deferred<Array<{ id: UUID; name: string; type: ChannelType }>>();
		const participants = deferred<UUID[]>();
		const started: string[] = [];
		const runtime = {
			agentId,
			getRoom: vi.fn(async () => ({
				id: roomId,
				name: "general",
				type: ChannelType.GROUP,
				worldId,
			})),
			getWorld: vi.fn(() => {
				started.push("world");
				return world.promise;
			}),
			getRooms: vi.fn(() => {
				started.push("rooms");
				return rooms.promise;
			}),
			getParticipantsForRoom: vi.fn(() => {
				started.push("participants");
				return participants.promise;
			}),
		} as unknown as IAgentRuntime;

		const resultPromise = worldProvider.get(runtime, message, state);
		await Promise.resolve();
		await Promise.resolve();
		expect(started).toEqual(["world"]);

		world.resolve({ id: worldId, name: "test world" });
		await Promise.resolve();
		expect(started).toEqual(["world", "rooms", "participants"]);
		rooms.resolve([{ id: roomId, name: "general", type: ChannelType.GROUP }]);
		participants.resolve([entityId]);
		await expect(resultPromise).resolves.toMatchObject({
			data: { world: { name: "test world" } },
		});
	});

	it("does not start dependent WORLD reads when the world does not exist", async () => {
		const runtime = {
			agentId,
			getRoom: vi.fn(async () => ({
				id: roomId,
				name: "general",
				type: ChannelType.GROUP,
				worldId,
			})),
			getWorld: vi.fn(async () => null),
			getRooms: vi.fn(),
			getParticipantsForRoom: vi.fn(),
		} as unknown as IAgentRuntime;

		await expect(
			worldProvider.get(runtime, message, state),
		).resolves.toMatchObject({
			text: "Unable to retrieve world information - world not found",
		});
		expect(runtime.getRooms).not.toHaveBeenCalled();
		expect(runtime.getParticipantsForRoom).not.toHaveBeenCalled();
	});

	it("uses the DOCUMENTS service's bounded concurrent read composition", async () => {
		const composition = deferred<{
			relevantFragments: Memory[];
			documents: Memory[];
			pinnedDocuments: Memory[];
		}>();
		const service = {
			composeProviderDocuments: vi.fn(() => composition.promise),
		};
		const runtime = {
			getService: vi.fn((serviceType: string) =>
				serviceType === DocumentService.serviceType ? service : null,
			),
		} as unknown as IAgentRuntime;

		const resultPromise = documentsProvider.get(runtime, message, state);
		await Promise.resolve();
		expect(service.composeProviderDocuments).toHaveBeenCalledWith(message, {
			limit: 25,
		});

		composition.resolve({
			relevantFragments: [],
			pinnedDocuments: [],
			documents: [
				{
					id: "10000000-0000-0000-0000-000000000008" as UUID,
					agentId,
					entityId,
					roomId,
					content: { text: "Project notes" },
					metadata: { type: MemoryType.DOCUMENT, title: "Project" },
				},
			],
		});
		await expect(resultPromise).resolves.toMatchObject({
			values: { documentsAvailable: true, documentsCount: 1 },
		});
	});
});
