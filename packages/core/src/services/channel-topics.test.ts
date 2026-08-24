/**
 * Unit tests for ChannelTopicsService per-channel topic LRU, hydration, persistence, and cross-channel search.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Room, UUID } from "../types/index.js";
import {
	CHANNEL_TOPICS_LRU_CAPACITY,
	CHANNEL_TOPICS_METADATA_KEY,
	ChannelTopicsService,
	matchTopicRooms,
} from "./channel-topics.js";

function makeMockRuntime(rooms: Map<UUID, Room>): IAgentRuntime {
	return {
		agentId: "test-agent" as UUID,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		reportError: vi.fn(),
		getRoom: vi
			.fn()
			.mockImplementation(async (roomId: UUID) => rooms.get(roomId) ?? null),
		updateRoom: vi.fn().mockImplementation(async (room: Room) => {
			rooms.set(room.id, room);
		}),
	} as unknown as IAgentRuntime;
}

describe("channel-topics", () => {
	it("records topics with LRU deduplication and recency refresh", async () => {
		const roomId = "room-1" as UUID;
		const rooms = new Map<UUID, Room>([
			[
				roomId,
				{ id: roomId, name: "General", metadata: {} } as unknown as Room,
			],
		]);
		const runtime = makeMockRuntime(rooms);
		const service = await ChannelTopicsService.start(runtime);

		await service.recordTopics(roomId, ["typescript", "vitest", "eliza"]);
		expect(service.getTopicsForRoom(roomId)).toEqual([
			"typescript",
			"vitest",
			"eliza",
		]);

		// Re-recording "typescript" moves it to the most recent end
		await service.recordTopics(roomId, ["typescript"]);
		expect(service.getTopicsForRoom(roomId)).toEqual([
			"vitest",
			"eliza",
			"typescript",
		]);

		// Verify room persistence
		const updated = rooms.get(roomId);
		expect(updated?.metadata?.[CHANNEL_TOPICS_METADATA_KEY]).toEqual([
			"vitest",
			"eliza",
			"typescript",
		]);

		await service.stop();
	});

	it("evicts oldest entries when exceeding capacity", async () => {
		const roomId = "room-2" as UUID;
		const rooms = new Map<UUID, Room>([
			[roomId, { id: roomId, name: "Large", metadata: {} } as unknown as Room],
		]);
		const runtime = makeMockRuntime(rooms);
		const service = await ChannelTopicsService.start(runtime);

		const manyTopics = Array.from(
			{ length: CHANNEL_TOPICS_LRU_CAPACITY + 5 },
			(_, i) => `topic-${i}`,
		);

		await service.recordTopics(roomId, manyTopics);
		const topics = service.getTopicsForRoom(roomId);
		expect(topics).toHaveLength(CHANNEL_TOPICS_LRU_CAPACITY);
		// Oldest 5 topics (topic-0 to topic-4) should be evicted
		expect(topics[0]).toBe("topic-5");
		expect(topics[topics.length - 1]).toBe(
			`topic-${CHANNEL_TOPICS_LRU_CAPACITY + 4}`,
		);

		await service.stop();
	});

	it("matches topics across rooms using matchTopicRooms", () => {
		const topicsByRoom = {
			"room-a": ["react", "frontend", "typescript"],
			"room-b": ["backend", "database", "postgres"],
			"room-c": ["frontend", "css", "design"],
		};

		const hits = matchTopicRooms(topicsByRoom, "frontend typescript");
		expect(hits.length).toBeGreaterThanOrEqual(2);
		expect(hits[0].roomId).toBe("room-a"); // 2 matches (frontend, typescript)
		expect(hits[0].matchedTopics).toEqual(["frontend", "typescript"]);

		expect(hits[1].roomId).toBe("room-c"); // 1 match (frontend)
		expect(hits[1].matchedTopics).toEqual(["frontend"]);

		// Empty query returns no hits
		expect(matchTopicRooms(topicsByRoom, "")).toEqual([]);
	});
});
