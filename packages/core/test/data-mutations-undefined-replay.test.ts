/**
 * Real-storage probe (PGlite jsonb): an exact replay of createMessageMemory
 * must reuse the stored id when the only difference from the stored row is
 * an undefined content property that JSON storage drops on the round-trip
 * (same root cause as #37496, different code path:
 * RuntimeDataMutations.sameEvidence in data-mutations.ts).
 *
 * Note: the SQLite adapter preserves undefined keys through its devalue
 * record codec, so this defect does not reproduce on SQLite — only on
 * Postgres/PGlite jsonb, where JSON.stringify drops the key.
 */
import { createTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ROOM_ID = "33333333-3333-4333-8333-333333333333" as UUID;
const ENTITY_ID = "44444444-4444-4444-8444-444444444444" as UUID;

describe("createMessageMemory exact replay (real PGlite)", () => {
	it("reuses the id when routed content has an undefined property dropped by JSON storage", async () => {
		const f = await createTestRuntime({ characterName: "UndefinedReplay" });
		try {
			const runtime = f.runtime;
			const agentId = runtime.agentId;
			await runtime.ensureRoomExists({
				id: ROOM_ID,
				name: "replay-room",
				source: "test",
				type: "GROUP",
				channelId: "replay-room",
				serverId: "test-server",
				worldId: "55555555-5555-4555-8555-555555555555" as UUID,
			});
			await runtime.adapter.createEntities([
				{ id: ENTITY_ID, agentId, names: ["Sender"] } as never,
			]);
			await runtime.adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
			const memory = {
				id: MESSAGE_ID,
				agentId,
				roomId: ROOM_ID,
				entityId: ENTITY_ID,
				createdAt: 1_700_000_000_000,
				content: {
					text: "hi",
					source: "discord",
					inReplyTo: undefined,
				},
				metadata: { type: "message", scope: "room" },
			} as Memory;

			const first = await runtime.createMessageMemory(memory);
			expect(first).toBe(MESSAGE_ID);

			// The stored row lost the undefined key in jsonb storage.
			const stored = await runtime.adapter.getMemoriesByIds(
				[MESSAGE_ID],
				"messages",
			);
			expect(stored[0]).toBeDefined();
			expect("inReplyTo" in (stored[0]?.content ?? {})).toBe(false);

			// Exact replay of the same routed content must reuse the id, not conflict.
			const second = await runtime.createMessageMemory(memory);
			expect(second).toBe(MESSAGE_ID);
		} finally {
			await f.cleanup();
		}
	});

	it("still conflicts when the replay carries different text", async () => {
		const f = await createTestRuntime({ characterName: "UndefinedReplay2" });
		try {
			const runtime = f.runtime;
			const agentId = runtime.agentId;
			await runtime.ensureRoomExists({
				id: ROOM_ID,
				name: "replay-room",
				source: "test",
				type: "GROUP",
				channelId: "replay-room",
				serverId: "test-server",
				worldId: "55555555-5555-4555-8555-555555555555" as UUID,
			});
			await runtime.adapter.createEntities([
				{ id: ENTITY_ID, agentId, names: ["Sender"] } as never,
			]);
			await runtime.adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
			const memory = {
				id: MESSAGE_ID,
				agentId,
				roomId: ROOM_ID,
				entityId: ENTITY_ID,
				createdAt: 1_700_000_000_000,
				content: { text: "hi", source: "discord" },
				metadata: { type: "message", scope: "room" },
			} as Memory;
			await runtime.createMessageMemory(memory);
			await expect(
				runtime.createMessageMemory({
					...memory,
					content: { text: "different", source: "discord" },
				}),
			).rejects.toMatchObject({
				code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
			});
		} finally {
			await f.cleanup();
		}
	});
});
