/**
 * Regression coverage for the chronological `createdAt` ordering used by both
 * evaluators in `memory-items.ts`.
 *
 * The two prepares (`prepareSummary` and `prepareLongTermMemory`) sort
 * dialogue memories oldest-first to drive offset arithmetic and bounded prompt
 * windows. A non-finite `createdAt` reaching the comparator would previously
 * return `NaN` and leave the misplaced row in insertion order, breaking
 * `lastMessageOffset` accounting and prompt determinism. Non-finite stamps
 * therefore collapse to `0` (oldest) and ties break on `id`.
 */
import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { __testCompareMemoryByCreatedAtAsc as compare } from "./memory-items.ts";

function mem(id: string, createdAt: number | undefined): Memory {
	return {
		id: id as unknown as UUID,
		createdAt,
		content: { text: id },
	} as unknown as Memory;
}

describe("memory-items createdAt ordering", () => {
	it("sorts oldest-first", () => {
		const rows = [mem("c", 30), mem("a", 10), mem("b", 20)];
		expect([...rows].sort(compare).map((m) => String(m.id))).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("treats NaN/Infinity/undefined as 0 and sorts them oldest", () => {
		const rows = [
			mem("c", 30),
			mem("b", Number.NaN),
			mem("a", 10),
			mem("d", Number.POSITIVE_INFINITY),
			mem("e", undefined as unknown as number),
		];
		const sorted = [...rows].sort(compare).map((m) => String(m.id));
		expect(sorted).toEqual(["b", "d", "e", "a", "c"]);
	});

	it("breaks equal timestamps deterministically by id", () => {
		const rows = [mem("b", 10), mem("a", 10)];
		expect([...rows].sort(compare).map((m) => String(m.id))).toEqual([
			"a",
			"b",
		]);
	});
});
