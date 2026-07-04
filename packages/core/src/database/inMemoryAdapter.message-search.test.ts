/**
 * Tests `InMemoryDatabaseAdapter.getMemories` keyword filtering (`textContains`)
 * and ordering — case-insensitive literal match (`%`/`_` are not wildcards),
 * `orderDirection` paging, and a bounded large-room scan. Runs against the real
 * in-memory adapter, mirroring plugin-sql ILIKE semantics.
 */
import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const roomId = "20000000-0000-0000-0000-000000000001" as UUID;
const entityId = "10000000-0000-0000-0000-000000000001" as UUID;

function msg(text: string, createdAt: number, id?: string): Memory {
	return {
		id: id as UUID | undefined,
		entityId,
		agentId,
		roomId,
		content: { text },
		createdAt,
	};
}

async function seed(messages: Memory[]): Promise<InMemoryDatabaseAdapter> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	await adapter.createMemories(
		messages.map((memory) => ({ memory, tableName: "messages" })),
	);
	return adapter;
}

describe("InMemoryDatabaseAdapter — textContains", () => {
	it("filters to messages whose text contains the keyword (case-insensitive)", async () => {
		const adapter = await seed([
			msg("Let's ship the WebXR runtime today", 1),
			msg("standup at 10:00", 2),
			msg("the webxr panels render now", 3),
		]);
		const hits = await adapter.getMemories({
			roomId,
			tableName: "messages",
			textContains: "WEBXR",
		});
		const texts = hits.map((m) => (m.content as { text: string }).text);
		expect(texts).toHaveLength(2);
		expect(texts).toContain("Let's ship the WebXR runtime today");
		expect(texts).toContain("the webxr panels render now");
		expect(texts).not.toContain("standup at 10:00");
	});

	it("matches the keyword literally — `%`/`_` are not wildcards", async () => {
		const adapter = await seed([
			msg("discount is 50% off", 1),
			msg("50x faster now", 2),
		]);
		const hits = await adapter.getMemories({
			roomId,
			tableName: "messages",
			textContains: "50%",
		});
		expect(hits.map((m) => (m.content as { text: string }).text)).toEqual([
			"discount is 50% off",
		]);
	});

	it("honors orderDirection for around-message paging (asc = oldest first)", async () => {
		const adapter = await seed([
			msg("a", 1, "00000000-0000-0000-0000-0000000000a1"),
			msg("b", 2, "00000000-0000-0000-0000-0000000000a2"),
			msg("c", 3, "00000000-0000-0000-0000-0000000000a3"),
		]);
		const desc = await adapter.getMemories({ roomId, tableName: "messages" });
		const asc = await adapter.getMemories({
			roomId,
			tableName: "messages",
			orderDirection: "asc",
		});
		expect(desc.map((m) => (m.content as { text: string }).text)).toEqual([
			"c",
			"b",
			"a",
		]);
		expect(asc.map((m) => (m.content as { text: string }).text)).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("stays bounded: a keyword scan over many messages returns only matches, quickly", async () => {
		const many: Memory[] = [];
		for (let i = 0; i < 20000; i++) {
			// 1 in 100 carries the needle.
			many.push(msg(i % 100 === 0 ? `needle ${i}` : `filler ${i}`, i + 1));
		}
		const adapter = await seed(many);
		const start = performance.now();
		const hits = await adapter.getMemories({
			roomId,
			tableName: "messages",
			textContains: "needle",
			limit: 50,
		});
		const elapsed = performance.now() - start;
		expect(hits.length).toBe(50); // limit applied after filtering
		expect(
			hits.every((m) =>
				(m.content as { text: string }).text.includes("needle"),
			),
		).toBe(true);
		expect(elapsed).toBeLessThan(1000); // bounded — no pathological blowup
	});
});
