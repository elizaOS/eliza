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
const otherEntityId = "10000000-0000-0000-0000-000000000002" as UUID;

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
	it("filters by entityId while keeping get/count pagination consistent", async () => {
		const adapter = await seed([
			msg("requester-authored", 1),
			{ ...msg("other-authored", 2), entityId: otherEntityId },
		]);

		const mine = await adapter.getMemories({
			entityId,
			agentId,
			tableName: "messages",
		});
		expect(mine.map((memory) => memory.content.text)).toEqual([
			"requester-authored",
		]);

		const theirs = await adapter.getMemories({
			entityId: otherEntityId,
			agentId,
			tableName: "messages",
		});
		expect(theirs.map((memory) => memory.content.text)).toEqual([
			"other-authored",
		]);

		// Pagination stays consistent with the predicate: limit/count and offset apply after filtering.
		const paged = await adapter.getMemories({
			entityId,
			agentId,
			tableName: "messages",
			limit: 1,
			offset: 0,
		});
		expect(paged).toHaveLength(1);
		expect(paged[0].content.text).toBe("requester-authored");

		const offsetPast = await adapter.getMemories({
			entityId,
			agentId,
			tableName: "messages",
			limit: 10,
			offset: 1,
		});
		expect(offsetPast).toHaveLength(0);

		// countMemories must agree with the getMemories predicate so callers paginating by count do not drift.
		const countMine = await adapter.countMemories({
			entityId,
			agentId,
			tableName: "messages",
		});
		expect(countMine).toBe(1);
		const countTheirs = await adapter.countMemories({
			entityId: otherEntityId,
			agentId,
			tableName: "messages",
		});
		expect(countTheirs).toBe(1);
		const countAll = await adapter.countMemories({
			agentId,
			tableName: "messages",
		});
		expect(countAll).toBe(2);
	});

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

	it("uses an exclusive tuple cursor that stays stable across earlier mutations", async () => {
		const ids = [
			"00000000-0000-0000-0000-0000000000a1",
			"00000000-0000-0000-0000-0000000000a2",
			"00000000-0000-0000-0000-0000000000a3",
			"00000000-0000-0000-0000-0000000000a4",
			"00000000-0000-0000-0000-0000000000a5",
		] as UUID[];
		const adapter = await seed(
			ids.map((id, index) => msg(`m${index}`, 1_000, id)),
		);
		const first = await adapter.getMemories({
			roomId,
			tableName: "messages",
			limit: 2,
		});
		expect(first.map((memory) => memory.id)).toEqual([ids[4], ids[3]]);

		await adapter.deleteMemories([ids[4]]);
		await adapter.createMemories([
			{
				memory: msg(
					"inserted ahead",
					2_000,
					"00000000-0000-0000-0000-0000000000ff",
				),
				tableName: "messages",
			},
		]);
		const second = await adapter.getMemories({
			roomId,
			tableName: "messages",
			limit: 2,
			cursor: { createdAt: 1_000, id: ids[3] },
		});
		expect(second.map((memory) => memory.id)).toEqual([ids[2], ids[1]]);

		await expect(
			adapter.getMemories({
				roomId,
				tableName: "messages",
				offset: 0,
				cursor: { createdAt: 1_000, id: ids[3] },
			}),
		).rejects.toThrow("cursor and offset are mutually exclusive");
	});

	it("matches PostgreSQL UUID ordering across hexadecimal case at cursor boundaries", async () => {
		const ids = [
			"A0000000-0000-0000-0000-000000000001",
			"a0000000-0000-0000-0000-000000000002",
			"A0000000-0000-0000-0000-000000000003",
			"a0000000-0000-0000-0000-000000000004",
		] as UUID[];
		const adapter = await seed(
			ids.map((id, index) => msg(`case ${index}`, 1_000, id)),
		);

		const first = await adapter.getMemories({
			roomId,
			tableName: "messages",
			limit: 2,
		});
		expect(first.map((memory) => memory.id)).toEqual([ids[3], ids[2]]);

		const second = await adapter.getMemories({
			roomId,
			tableName: "messages",
			limit: 2,
			cursor: { createdAt: 1_000, id: ids[2] },
		});
		expect(second.map((memory) => memory.id)).toEqual([ids[1], ids[0]]);
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

	it("preserves batch uniqueness overrides and defaults unspecified memories to unique", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await adapter.createMemories([
			{
				memory: { ...msg("entry wins true", 1), unique: false },
				tableName: "messages",
				unique: true,
			},
			{
				memory: { ...msg("entry wins false", 2), unique: true },
				tableName: "messages",
				unique: false,
			},
			{
				memory: { ...msg("memory stays false", 3), unique: false },
				tableName: "messages",
			},
			{
				memory: msg("default is unique", 4),
				tableName: "messages",
			},
		]);

		const all = await adapter.getMemories({ roomId, tableName: "messages" });
		expect(
			Object.fromEntries(
				all.map((memory) => [
					(memory.content as { text: string }).text,
					memory.unique,
				]),
			),
		).toEqual({
			"entry wins true": true,
			"entry wins false": false,
			"memory stays false": false,
			"default is unique": true,
		});

		const unique = await adapter.getMemories({
			roomId,
			tableName: "messages",
			unique: true,
		});
		expect(
			unique.map((memory) => (memory.content as { text: string }).text),
		).toEqual(["default is unique", "entry wins true"]);
	});
});
