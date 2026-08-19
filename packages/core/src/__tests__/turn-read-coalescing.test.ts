/**
 * Turn-scoped single-flight DB read coalescing: one compose fan-out issues the
 * same room lookup and room messages-scan from several providers; the runtime
 * memo must collapse those into one adapter round-trip each, slice the shared
 * window exactly like a direct adapter query, and self-invalidate on every
 * write so a compose immediately after message intake can never see a stale
 * window. Real AgentRuntime + InMemoryDatabaseAdapter (which mirrors
 * plugin-sql's newest-first ordering) with counting delegates that still run
 * the real adapter queries; real RECENT_MESSAGES/ATTACHMENTS/FACTS providers
 * for the compose-level proof; no model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { factsProvider } from "../features/advanced-capabilities/providers/facts";
import { attachmentsProvider } from "../features/basic-capabilities/providers/attachments";
import { recentMessagesProvider } from "../features/basic-capabilities/providers/recentMessages";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, Room, UUID } from "../types";
import { ChannelType } from "../types";

const WORLD_ID = "33333333-3333-3333-3333-333333333330" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333331" as UUID;
const SENDER_ID = "44444444-4444-4444-4444-444444444441" as UUID;

type AdapterCallCounts = {
	getRoomsByIds: number;
	messagesScans: number;
};

/**
 * Count adapter reads while still executing the real query — a counting
 * delegate, not a stub: results come from the actual in-memory store.
 */
function instrumentAdapter(
	adapter: InMemoryDatabaseAdapter,
): AdapterCallCounts {
	const counts: AdapterCallCounts = { getRoomsByIds: 0, messagesScans: 0 };
	const realGetRoomsByIds = adapter.getRoomsByIds.bind(adapter);
	adapter.getRoomsByIds = async (roomIds: UUID[]) => {
		counts.getRoomsByIds += 1;
		return realGetRoomsByIds(roomIds);
	};
	const realGetMemories = adapter.getMemories.bind(adapter);
	adapter.getMemories = async (
		params: Parameters<InMemoryDatabaseAdapter["getMemories"]>[0],
	) => {
		if (params.tableName === "messages") counts.messagesScans += 1;
		return realGetMemories(params);
	};
	return counts;
}

async function makeRuntime(): Promise<{
	runtime: AgentRuntime;
	adapter: InMemoryDatabaseAdapter;
	counts: AdapterCallCounts;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: { name: "coalescing-test" } as Character,
		adapter,
		logLevel: "fatal",
	});
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: runtime.agentId,
			name: "test world",
			metadata: { roles: {} },
		},
	]);
	await adapter.createRooms([
		{
			id: ROOM_ID,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.DM,
			worldId: WORLD_ID,
		},
	]);
	const counts = instrumentAdapter(adapter);
	return { runtime, adapter, counts };
}

function makeMessageRow(index: number, text?: string): Memory {
	const suffix = index.toString(16).padStart(12, "0");
	return {
		id: `55555555-5555-5555-5555-${suffix}` as UUID,
		entityId: SENDER_ID,
		agentId: undefined as unknown as UUID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		createdAt: 1_000 + index,
		content: { text: text ?? `message ${index}`, source: "test" },
	} as Memory;
}

async function seedMessages(
	adapter: InMemoryDatabaseAdapter,
	count: number,
): Promise<Memory[]> {
	const rows = Array.from({ length: count }, (_, i) => makeMessageRow(i));
	await adapter.createMemories(
		rows.map((memory) => ({ memory, tableName: "messages" })),
	);
	return rows;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("getRoom single-flight coalescing", () => {
	it("shares one adapter query across the compose fan-out's parallel getRoom calls", async () => {
		const { runtime, counts } = await makeRuntime();
		// RECENT_MESSAGES / CHARACTER / PLATFORM_* / WORLD each resolve the room.
		const rooms = await Promise.all([
			runtime.getRoom(ROOM_ID),
			runtime.getRoom(ROOM_ID),
			runtime.getRoom(ROOM_ID),
			runtime.getRoom(ROOM_ID),
		]);
		expect(counts.getRoomsByIds).toBe(1);
		for (const room of rooms) expect(room?.id).toBe(ROOM_ID);
	});

	it("re-queries immediately after a room mutation (compaction-style metadata write)", async () => {
		const { runtime, counts } = await makeRuntime();
		const room = await runtime.getRoom(ROOM_ID);
		expect(room).not.toBeNull();
		await runtime.updateRoom({
			...(room as Room),
			metadata: { ...(room as Room).metadata, lastCompactionAt: 42 },
		});
		const updated = await runtime.getRoom(ROOM_ID);
		expect(updated?.metadata?.lastCompactionAt).toBe(42);
		expect(counts.getRoomsByIds).toBe(2);
	});

	it("does not serve a memoized null after the room is created", async () => {
		const { runtime, counts } = await makeRuntime();
		const missingId = "33333333-3333-3333-3333-333333333339" as UUID;
		expect(await runtime.getRoom(missingId)).toBeNull();
		await runtime.createRoom({
			id: missingId,
			source: "test",
			type: ChannelType.DM,
			worldId: WORLD_ID,
		} as Room);
		const created = await runtime.getRoom(missingId);
		expect(created?.id).toBe(missingId);
		expect(counts.getRoomsByIds).toBe(2);
	});

	it("invalidates the memo when ensureConnection creates the room (bypasses the upsertRooms wrapper)", async () => {
		const { runtime, counts } = await makeRuntime();
		const newRoomId = "33333333-3333-3333-3333-33333333333e" as UUID;
		// A pre-create read memoizes null for the not-yet-existing room.
		expect(await runtime.getRoom(newRoomId)).toBeNull();
		// ensureConnection writes the room through adapter.upsertRooms directly, not
		// this.upsertRooms — so without an explicit invalidation this read would be
		// served the stale memoized null.
		await runtime.ensureConnection({
			entityId: SENDER_ID,
			roomId: newRoomId,
			worldId: WORLD_ID,
			type: ChannelType.DM,
			source: "test",
		});
		const before = counts.getRoomsByIds;
		const created = await runtime.getRoom(newRoomId);
		// The post-ensureConnection read must hit the adapter (memo invalidated) and
		// return the created room, not the stale null.
		expect(counts.getRoomsByIds).toBe(before + 1);
		expect(created?.id).toBe(newRoomId);
	});

	it("re-queries after the TTL lapses (bounds cross-process staleness)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { runtime, counts } = await makeRuntime();
		await runtime.getRoom(ROOM_ID);
		await runtime.getRoom(ROOM_ID);
		expect(counts.getRoomsByIds).toBe(1);
		vi.setSystemTime(Date.now() + 1_001);
		await runtime.getRoom(ROOM_ID);
		expect(counts.getRoomsByIds).toBe(2);
	});
});

describe("room messages-scan coalescing", () => {
	it("serves concurrent scans at different limits from one superset fetch, sliced exactly", async () => {
		const { runtime, adapter, counts } = await makeRuntime();
		const rows = await seedMessages(adapter, 60);
		// RECENT_MESSAGES (conversationLength) / FACTS (10) / ATTACHMENTS (50).
		const [big, ten, fifty] = await Promise.all([
			runtime.getMemories({
				tableName: "messages",
				roomId: ROOM_ID,
				limit: runtime.getConversationLength(),
				unique: false,
			}),
			runtime.getMemories({
				tableName: "messages",
				roomId: ROOM_ID,
				limit: 10,
				unique: false,
			}),
			runtime.getMemories({
				tableName: "messages",
				roomId: ROOM_ID,
				count: 50,
				unique: false,
			}),
		]);
		expect(counts.messagesScans).toBe(1);
		// Newest-first, byte-identical to a direct limit-bounded adapter query.
		expect(big).toHaveLength(60);
		expect(ten).toHaveLength(10);
		expect(fifty).toHaveLength(50);
		expect(ten[0]?.id).toBe(rows[59]?.id);
		expect(ten[9]?.id).toBe(rows[50]?.id);
		expect(fifty.map((m) => m.id)).toEqual(big.slice(0, 50).map((m) => m.id));
	});

	it("reproduces a start-bounded (compaction cutoff) query from the shared window", async () => {
		const { runtime, adapter, counts } = await makeRuntime();
		const rows = await seedMessages(adapter, 30);
		// Prime the shared window, then ask for the post-compaction slice.
		await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 50,
			unique: false,
		});
		const cutoff = rows[20]?.createdAt as number;
		const bounded = await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 50,
			unique: false,
			start: cutoff,
		});
		expect(counts.messagesScans).toBe(1);
		expect(bounded).toHaveLength(10); // rows 20..29 inclusive
		expect(bounded[0]?.id).toBe(rows[29]?.id);
		expect(bounded[9]?.id).toBe(rows[20]?.id);
	});

	it("busts the window on createMemory so a compose right after intake sees the new message", async () => {
		const { runtime, adapter, counts } = await makeRuntime();
		await seedMessages(adapter, 5);
		await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 10,
			unique: false,
		});
		expect(counts.messagesScans).toBe(1);
		// The intake sequence: persist the user message, then compose reads.
		const incoming = makeMessageRow(99, "what did I just say?");
		await runtime.createMemory(incoming, "messages");
		const window = await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 10,
			unique: false,
		});
		expect(counts.messagesScans).toBe(2);
		expect(window[0]?.id).toBe(incoming.id);
	});

	it("passes filtered/ordered/scoped query shapes through to the adapter untouched", async () => {
		const { runtime, adapter, counts } = await makeRuntime();
		const rows = await seedMessages(adapter, 20);
		// Prime an eligible window first — the variants below must not be
		// served from it.
		await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 10,
			unique: false,
		});
		const ascending = await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 5,
			unique: false,
			orderBy: "createdAt",
			orderDirection: "asc",
		});
		const keyword = await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 5,
			unique: false,
			textContains: "message 3",
		});
		const cursor = await runtime.getMemories({
			tableName: "messages",
			roomId: ROOM_ID,
			limit: 5,
			unique: false,
			cursor: {
				createdAt: rows[15]?.createdAt as number,
				id: rows[15]?.id as UUID,
			},
		});
		expect(counts.messagesScans).toBe(4);
		expect(ascending[0]?.id).toBe(rows[0]?.id); // oldest-first honored
		expect(keyword.every((m) => m.content.text?.includes("message 3"))).toBe(
			true,
		);
		expect(cursor.map((memory) => memory.id)).toEqual(
			rows
				.slice(10, 15)
				.reverse()
				.map((memory) => memory.id),
		);
	});
});

describe("composeState over real providers", () => {
	it("runs RECENT_MESSAGES + ATTACHMENTS + FACTS with a single room messages-scan", async () => {
		const { runtime, adapter, counts } = await makeRuntime();
		await seedMessages(adapter, 12);
		runtime.registerProvider(recentMessagesProvider);
		runtime.registerProvider(attachmentsProvider);
		runtime.registerProvider(factsProvider);
		// Text references + asks to inspect an attachment, so ATTACHMENTS pays
		// its history fetch — which must coalesce with RECENT_MESSAGES/FACTS.
		const message = makeMessageRow(97, "what does the attached image show?");
		await runtime.createMemory(message, "messages");
		const countsAfterIntake = counts.messagesScans;
		const state = await runtime.composeState(
			message,
			["RECENT_MESSAGES", "ATTACHMENTS", "FACTS"],
			true,
			true,
		);
		expect(counts.messagesScans - countsAfterIntake).toBe(1);
		// Correctness gate: the just-persisted message is in the rendered window.
		expect(state.text).toContain("what does the attached image show?");
	});

	it("skips the ATTACHMENTS history fetch entirely on a text-only turn", async () => {
		const { runtime, adapter } = await makeRuntime();
		await seedMessages(adapter, 3);
		let providerFetches = 0;
		const realGetMemories = runtime.getMemories.bind(runtime);
		runtime.getMemories = async (
			params: Parameters<AgentRuntime["getMemories"]>[0],
		) => {
			providerFetches += 1;
			return realGetMemories(params);
		};
		const result = await attachmentsProvider.get(
			runtime,
			makeMessageRow(98, "gm, how are you?"),
			{ values: {}, data: {}, text: "" },
		);
		expect(providerFetches).toBe(0);
		expect(result.text).toBe("");
	});
});
