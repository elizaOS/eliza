/**
 * Exercises `ChannelTopicsService`: the per-room LRU of recent channel topics —
 * dedup with move-to-most-recent, FIFO eviction at capacity, persistence to
 * room.metadata, hydration on restart, and defensive handling when rooms or the
 * DB are missing. Backed by a mock runtime over an in-memory room map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { Room, UUID } from "../../types/index";
import type { IAgentRuntime } from "../../types/runtime";
import {
	CHANNEL_TOPICS_LRU_CAPACITY,
	CHANNEL_TOPICS_METADATA_KEY,
	ChannelTopicsService,
} from "../channel-topics";

const ROOM_A = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ROOM_B = "00000000-0000-0000-0000-0000000000bb" as UUID;

interface MockRuntime {
	runtime: IAgentRuntime;
	rooms: Map<UUID, Room>;
	getRoom: ReturnType<typeof vi.fn>;
	updateRoom: ReturnType<typeof vi.fn>;
}

function makeRuntime(seed?: Partial<Record<UUID, Room>>): MockRuntime {
	const rooms = new Map<UUID, Room>();
	for (const [id, room] of Object.entries(seed ?? {})) {
		if (room) rooms.set(id as UUID, room);
	}
	const getRoom = vi.fn(async (roomId: UUID) => rooms.get(roomId) ?? null);
	const updateRoom = vi.fn(async (room: Room) => {
		rooms.set(room.id, room);
	});
	const runtime = createMockRuntime({ getRoom, updateRoom });
	return { runtime, rooms, getRoom, updateRoom };
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
	let mock: MockRuntime;
	let service: ChannelTopicsService;

	beforeEach(async () => {
		mock = makeRuntime({
			[ROOM_A]: makeRoom(ROOM_A),
			[ROOM_B]: makeRoom(ROOM_B),
		});
		service = await ChannelTopicsService.start(mock.runtime);
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

	it("persists the LRU to room.metadata.currentTopics via updateRoom", async () => {
		await service.recordTopics(ROOM_A, ["billing", "auth"]);
		expect(mock.updateRoom).toHaveBeenCalledTimes(1);
		const persisted = mock.rooms.get(ROOM_A);
		expect(persisted?.metadata?.[CHANNEL_TOPICS_METADATA_KEY]).toEqual([
			"billing",
			"auth",
		]);
	});

	it("hydrates from room metadata on first access (survives restart)", async () => {
		// Simulate a restart: a fresh service over a runtime whose room already
		// has persisted topics.
		const restarted = makeRuntime({
			[ROOM_A]: makeRoom(ROOM_A, ["persisted-one", "persisted-two"]),
		});
		const fresh = await ChannelTopicsService.start(restarted.runtime);

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
		await service.recordTopics(ROOM_A, []);
		expect(service.getTopicsForRoom(ROOM_A)).toEqual([]);
		expect(mock.updateRoom).not.toHaveBeenCalled();
	});

	it("never throws when the room is missing (defensive persistence)", async () => {
		const noRoom = makeRuntime();
		const svc = await ChannelTopicsService.start(noRoom.runtime);
		await expect(
			svc.recordTopics(ROOM_A, ["billing"]),
		).resolves.toBeUndefined();
		// Cache still updated even though persistence found no room to write.
		expect(svc.getTopicsForRoom(ROOM_A)).toEqual(["billing"]);
		expect(noRoom.updateRoom).not.toHaveBeenCalled();
	});

	it("never throws when getRoom rejects (defensive hydration)", async () => {
		const failing = makeRuntime();
		failing.getRoom.mockRejectedValue(new Error("db down"));
		const svc = await ChannelTopicsService.start(failing.runtime);
		await expect(
			svc.recordTopics(ROOM_A, ["billing"]),
		).resolves.toBeUndefined();
		// Cache still reflects the recorded topic despite the hydration failure.
		expect(svc.getTopicsForRoom(ROOM_A)).toEqual(["billing"]);
	});

	it("ignores non-string garbage in persisted metadata on hydrate", async () => {
		const dirty = makeRuntime();
		dirty.rooms.set(ROOM_A, {
			id: ROOM_A,
			source: "test",
			type: "GROUP" as Room["type"],
			metadata: {
				[CHANNEL_TOPICS_METADATA_KEY]: ["ok", 42, "", "  ", "ok"],
			},
		});
		const svc = await ChannelTopicsService.start(dirty.runtime);
		expect(await svc.ensureHydrated(ROOM_A)).toEqual(["ok"]);
	});

	it("clears state on stop", async () => {
		await service.recordTopics(ROOM_A, ["billing"]);
		await service.stop();
		expect(service.getTopicsForAllRooms()).toEqual({});
	});
});
