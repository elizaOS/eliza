/**
 * Exercises `ChannelTopicsService`: the per-room LRU of recent channel topics —
 * dedup with move-to-most-recent, FIFO eviction at capacity, persistence to
 * room.metadata, hydration on restart, and missing-room handling. The suite
 * uses AgentRuntime and the real in-memory database adapter.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCharacter } from "../../character.ts";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter.ts";
import { AgentRuntime } from "../../runtime.ts";
import type { Room, UUID } from "../../types/index";
import {
	CHANNEL_TOPICS_LRU_CAPACITY,
	CHANNEL_TOPICS_METADATA_KEY,
	ChannelTopicsService,
} from "../channel-topics";

const ROOM_A = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ROOM_B = "00000000-0000-0000-0000-0000000000bb" as UUID;

const activeRuntimes: AgentRuntime[] = [];

class FailingRoomAdapter extends InMemoryDatabaseAdapter {
	failReads = false;
	failWrites = false;

	override async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
		if (this.failReads) throw new Error("room read unavailable");
		return super.getRoomsByIds(roomIds);
	}

	override async updateRooms(rooms: Room[]): Promise<void> {
		if (this.failWrites) throw new Error("room write unavailable");
		return super.updateRooms(rooms);
	}
}

async function makeRuntime(
	seed: Room[] = [],
	adapter: InMemoryDatabaseAdapter = new InMemoryDatabaseAdapter(),
): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "ChannelTopicsIntegrationAgent" }),
		adapter,
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize();
	if (seed.length > 0) await runtime.createRooms(seed);
	activeRuntimes.push(runtime);
	return runtime;
}

function makeRoom(id: UUID, currentTopics?: string[]): Room {
	return {
		id,
		source: "test",
		type: "GROUP" as Room["type"],
		...(currentTopics
			? { metadata: { [CHANNEL_TOPICS_METADATA_KEY]: currentTopics } }
			: {}),
	};
}

describe("ChannelTopicsService", () => {
	let runtime: AgentRuntime;
	let service: ChannelTopicsService;

	beforeEach(async () => {
		runtime = await makeRuntime([makeRoom(ROOM_A), makeRoom(ROOM_B)]);
		service = await ChannelTopicsService.start(runtime);
	});

	afterEach(async () => {
		await Promise.all(
			activeRuntimes.splice(0).map(async (activeRuntime) => {
				await activeRuntime.stop();
				await activeRuntime.close();
			}),
		);
	});

	it("records topics most-recent-last and returns a defensive copy", async () => {
		await service.recordTopics(ROOM_A, ["billing", "auth"]);
		const got = service.getTopicsForRoom(ROOM_A);
		expect(got).toEqual(["billing", "auth"]);
		// Mutating the returned array must not corrupt internal state.
		got.push("mutated");
		expect(service.getTopicsForRoom(ROOM_A)).toEqual(["billing", "auth"]);
	});

	it("dedupes on insert and refreshes recency (move-to-most-recent)", async () => {
		await service.recordTopics(ROOM_A, ["a", "b", "c"]);
		await service.recordTopics(ROOM_A, ["b"]);
		// 'b' moves to the end; no duplicate.
		expect(service.getTopicsForRoom(ROOM_A)).toEqual(["a", "c", "b"]);
	});

	it("caps the LRU and FIFO-evicts the oldest entries", async () => {
		const overCapacityCount = CHANNEL_TOPICS_LRU_CAPACITY + 5;
		const topics = Array.from({ length: overCapacityCount }, (_, i) => `t${i}`);
		await service.recordTopics(ROOM_A, topics);
		const got = service.getTopicsForRoom(ROOM_A);
		expect(got.length).toBe(CHANNEL_TOPICS_LRU_CAPACITY);
		// Oldest 5 (t0..t4) evicted; the most-recent capacity slots remain.
		expect(got[0]).toBe(`t${overCapacityCount - CHANNEL_TOPICS_LRU_CAPACITY}`);
		expect(got.at(-1)).toBe(`t${overCapacityCount - 1}`);
	});

	it("FIFO-evicts across multiple recordTopics calls", async () => {
		for (let i = 0; i < CHANNEL_TOPICS_LRU_CAPACITY; i++) {
			await service.recordTopics(ROOM_A, [`t${i}`]);
		}
		// One more distinct topic evicts the oldest (t0).
		await service.recordTopics(ROOM_A, ["newest"]);
		const got = service.getTopicsForRoom(ROOM_A);
		expect(got.length).toBe(CHANNEL_TOPICS_LRU_CAPACITY);
		expect(got).not.toContain("t0");
		expect(got).toContain("t1");
		expect(got.at(-1)).toBe("newest");
	});

	it("persists the LRU to room.metadata.currentTopics", async () => {
		await service.recordTopics(ROOM_A, ["billing", "auth"]);
		const persisted = await runtime.getRoom(ROOM_A);
		expect(persisted?.metadata?.[CHANNEL_TOPICS_METADATA_KEY]).toEqual([
			"billing",
			"auth",
		]);
	});

	it("hydrates from room metadata on first access (survives restart)", async () => {
		// Simulate a restart: a fresh service over a runtime whose room already
		// has persisted topics.
		const restarted = await makeRuntime([
			makeRoom(ROOM_A, ["persisted-one", "persisted-two"]),
		]);
		const fresh = await ChannelTopicsService.start(restarted);

		// ensureHydrated pulls metadata into the cache.
		const hydrated = await fresh.ensureHydrated(ROOM_A);
		expect(hydrated).toEqual(["persisted-one", "persisted-two"]);

		// A subsequent record appends onto the hydrated list (no data loss).
		await fresh.recordTopics(ROOM_A, ["new-topic"]);
		expect(fresh.getTopicsForRoom(ROOM_A)).toEqual([
			"persisted-one",
			"persisted-two",
			"new-topic",
		]);
	});

	it("treats each room independently", async () => {
		await service.recordTopics(ROOM_A, ["alpha"]);
		await service.recordTopics(ROOM_B, ["beta", "gamma"]);
		expect(service.getTopicsForRoom(ROOM_A)).toEqual(["alpha"]);
		expect(service.getTopicsForRoom(ROOM_B)).toEqual(["beta", "gamma"]);
		expect(service.getTopicsForAllRooms()).toEqual({
			[ROOM_A]: ["alpha"],
			[ROOM_B]: ["beta", "gamma"],
		});
	});

	it("is a no-op for empty/invalid topic input and does not persist", async () => {
		const before = await runtime.getRoom(ROOM_A);
		await service.recordTopics(ROOM_A, []);
		expect(service.getTopicsForRoom(ROOM_A)).toEqual([]);
		expect(await runtime.getRoom(ROOM_A)).toEqual(before);
	});

	it("never throws when the room is missing (defensive persistence)", async () => {
		const noRoom = await makeRuntime();
		const svc = await ChannelTopicsService.start(noRoom);
		await expect(
			svc.recordTopics(ROOM_A, ["billing"]),
		).resolves.toBeUndefined();
		// Cache still updated even though persistence found no room to write.
		expect(svc.getTopicsForRoom(ROOM_A)).toEqual(["billing"]);
		expect(await noRoom.getRoom(ROOM_A)).toBeNull();
	});

	it("reports hydration failure and retries the unhydrated room", async () => {
		const adapter = new FailingRoomAdapter();
		const failingRuntime = await makeRuntime(
			[makeRoom(ROOM_A, ["persisted"])],
			adapter,
		);
		const svc = await ChannelTopicsService.start(failingRuntime);
		adapter.failReads = true;

		await expect(svc.ensureHydrated(ROOM_A)).rejects.toMatchObject({
			code: "CHANNEL_TOPICS_HYDRATE_FAILED",
			cause: expect.objectContaining({ message: "room read unavailable" }),
		});
		expect(failingRuntime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				scope: "ChannelTopicsService.hydrate",
				code: "CHANNEL_TOPICS_HYDRATE_FAILED",
				context: expect.objectContaining({ roomId: ROOM_A }),
			}),
		);

		adapter.failReads = false;
		expect(await svc.ensureHydrated(ROOM_A)).toEqual(["persisted"]);
	});

	it("reports and propagates a failed room update", async () => {
		const adapter = new FailingRoomAdapter();
		const failingRuntime = await makeRuntime([makeRoom(ROOM_A)], adapter);
		const svc = await ChannelTopicsService.start(failingRuntime);
		adapter.failWrites = true;

		await expect(svc.recordTopics(ROOM_A, ["billing"])).rejects.toMatchObject({
			code: "CHANNEL_TOPICS_PERSIST_FAILED",
			cause: expect.objectContaining({ message: "room write unavailable" }),
		});
		expect(failingRuntime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				scope: "ChannelTopicsService.persist",
				code: "CHANNEL_TOPICS_PERSIST_FAILED",
				context: expect.objectContaining({ roomId: ROOM_A }),
			}),
		);
	});

	it("ignores non-string garbage in persisted metadata on hydrate", async () => {
		const dirty = await makeRuntime([
			{
				id: ROOM_A,
				source: "test",
				type: "GROUP" as Room["type"],
				metadata: {
					[CHANNEL_TOPICS_METADATA_KEY]: ["ok", 42, "", "  ", "ok"],
				},
			},
		]);
		const svc = await ChannelTopicsService.start(dirty);
		expect(await svc.ensureHydrated(ROOM_A)).toEqual(["ok"]);
	});

	it("clears state on stop", async () => {
		await service.recordTopics(ROOM_A, ["billing"]);
		await service.stop();
		expect(service.getTopicsForAllRooms()).toEqual({});
	});
});
