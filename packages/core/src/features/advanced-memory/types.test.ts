/**
 * Runtime contract coverage for the advanced-memory type module's only
 * runtime export: the LongTermMemoryCategory enum.
 *
 * MemoryStorageProvider persists memories with the enum's serialized value as
 * the category discriminator and extraction pipelines compare raw model output
 * strings against it, so these tests pin the storage/wire boundary: exact
 * serialized values, discriminator uniqueness, JSON round-trip validity of a
 * persisted record, member lookup by key name, and rejection of unknown or
 * case-mutated category strings at the validation boundary.
 */
import { describe, expect, it } from "vitest";
import type { LongTermMemory } from "./types.ts";
import { LongTermMemoryCategory } from "./types.ts";

const ALL_CATEGORIES = [
	LongTermMemoryCategory.EPISODIC,
	LongTermMemoryCategory.SEMANTIC,
	LongTermMemoryCategory.PROCEDURAL,
] as const;

function makeMemory(category: LongTermMemoryCategory): LongTermMemory {
	const now = new Date("2026-08-24T00:00:00.000Z");
	return {
		id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
		agentId: "550e8400-e29b-41d4-a716-446655440000",
		entityId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		category,
		content: "User prefers concise answers about deployment.",
		metadata: { origin: "conversation", score: 0.75, tags: [true, null] },
		createdAt: now,
		updatedAt: now,
	};
}

describe("LongTermMemoryCategory runtime contract", () => {
	it("serializes members to their exact persisted discriminator values", () => {
		expect(LongTermMemoryCategory.EPISODIC).toBe("episodic");
		expect(LongTermMemoryCategory.SEMANTIC).toBe("semantic");
		expect(LongTermMemoryCategory.PROCEDURAL).toBe("procedural");
	});

	it("exposes exactly three unique non-empty string values", () => {
		const values = Object.values(LongTermMemoryCategory);
		expect(values).toHaveLength(3);
		expect(new Set(values).size).toBe(3);
		for (const value of values) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
			expect(new Set([...ALL_CATEGORIES]).has(value as never)).toBe(true);
		}
		expect([...values].sort()).toEqual(["episodic", "procedural", "semantic"]);
	});

	it("resolves every member by its key name", () => {
		for (const key of Object.keys(LongTermMemoryCategory)) {
			expect(
				LongTermMemoryCategory[key as keyof typeof LongTermMemoryCategory],
			).toBeDefined();
		}
		expect(Object.keys(LongTermMemoryCategory).sort()).toEqual([
			"EPISODIC",
			"PROCEDURAL",
			"SEMANTIC",
		]);
	});

	it("keeps a stored memory's category valid through a JSON round-trip", () => {
		const original = makeMemory(LongTermMemoryCategory.SEMANTIC);
		const rehydrated = JSON.parse(JSON.stringify(original)) as LongTermMemory;
		expect(
			Object.values(LongTermMemoryCategory).includes(rehydrated.category),
		).toBe(true);
		expect(rehydrated.category).toBe(original.category);
		expect(rehydrated.metadata).toEqual(original.metadata);
		expect(new Date(rehydrated.createdAt).getTime()).toBe(
			new Date(original.createdAt).getTime(),
		);
	});

	it("round-trips all three categories through the same boundary", () => {
		for (const category of ALL_CATEGORIES) {
			const rehydrated = JSON.parse(
				JSON.stringify(makeMemory(category)),
			) as LongTermMemory;
			expect(rehydrated.category).toBe(category);
		}
	});

	it("rejects unknown and case-mutated category strings at the validation boundary", () => {
		const known = new Set<string>(Object.values(LongTermMemoryCategory));
		for (const candidate of [
			"Episodic",
			"EPISODIC",
			"",
			"procedura",
			"relational",
		]) {
			expect(known.has(candidate)).toBe(false);
		}
	});
});
