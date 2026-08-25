/**
 * Exercises the core first-party in-memory adapter's stable vector cursor on
 * real stored memories so every adapter family shares the same page contract.
 */

import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "25150000-0000-4000-8000-000000000301" as UUID;
const ROOM_ID = "25150000-0000-4000-8000-000000000302" as UUID;
const ENTITY_ID = "25150000-0000-4000-8000-000000000303" as UUID;

describe("issue #25150 core stable search cursor", () => {
	it("returns each stored vector memory once across keyset pages", async () => {
		const adapter = new InMemoryDatabaseAdapter(AGENT_ID);
		const memories: Memory[] = [0, 1, 2, 3, 4].map((index) => ({
			id: `25150000-0000-4000-8000-${String(304 + index).padStart(12, "0")}` as UUID,
			agentId: AGENT_ID,
			roomId: ROOM_ID,
			entityId: ENTITY_ID,
			createdAt: 100 - index,
			content: { text: `memory ${index}` },
			embedding: index === 3 ? [0, 1] : index === 4 ? [-1, 0] : [1, index / 10],
		}));
		await adapter.createMemories(
			memories.map((memory) => ({ memory, tableName: "messages" })),
		);

		const first = await adapter.searchMemoriesPage({
			tableName: "messages",
			embedding: [1, 0],
			limit: 1,
		});
		expect(first.nextCursor).toBeDefined();
		const second = await adapter.searchMemoriesPage({
			tableName: "messages",
			embedding: [1, 0],
			limit: 1,
			cursor: first.nextCursor,
		});

		expect(first.items[0]?.id).toBe(memories[0]?.id);
		expect(second.items[0]?.id).toBe(memories[1]?.id);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
		const seen = [...first.items, ...second.items];
		let cursor = second.nextCursor;
		while (cursor) {
			const page = await adapter.searchMemoriesPage({
				tableName: "messages",
				embedding: [1, 0],
				limit: 1,
				cursor,
			});
			seen.push(...page.items);
			cursor = page.nextCursor;
		}
		expect(seen.map((memory) => memory.id)).toEqual(
			memories.map((memory) => memory.id),
		);
		const zeroThreshold = await adapter.searchMemoriesPage({
			tableName: "messages",
			embedding: [1, 0],
			match_threshold: 0,
			limit: 10,
		});
		expect(zeroThreshold.items.map((memory) => memory.id)).toEqual(
			memories.slice(0, 4).map((memory) => memory.id),
		);
	});
});
