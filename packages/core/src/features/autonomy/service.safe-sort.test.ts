/**
 * Regression coverage for chronological and reverse-chronological
 * createdAt orderings in AutonomyService.
 *
 * Two sort sites drive prompt assembly: newest-first bucketing of
 * cross-room messages and oldest-first ordering of autonomy thought
 * memories for compacted history. Both previously used raw subtraction,
 * which returns NaN for non-finite stamps and leaves order undefined.
 */
import { describe, expect, it } from "vitest";
import {
	__testCompareMemoryByCreatedAtAsc as asc,
	__testCompareMemoryByCreatedAtDesc as desc,
} from "./service.ts";

function mem(id: string, createdAt: number | undefined) {
	return { id, createdAt } as { id: string; createdAt?: number };
}

describe("autonomy service createdAt ordering", () => {
	it("sorts desc newest-first", () => {
		expect([
			...[mem("a", 10), mem("c", 30), mem("b", 20)].sort(desc).map((m) => m.id),
		]).toEqual(["c", "b", "a"]);
	});
	it("sorts asc oldest-first", () => {
		expect([
			...[mem("c", 30), mem("a", 10), mem("b", 20)].sort(asc).map((m) => m.id),
		]).toEqual(["a", "b", "c"]);
	});
	it("treats NaN as 0 oldest in both directions", () => {
		expect([
			...[mem("c", 30), mem("b", Number.NaN), mem("a", 10)]
				.sort(asc)
				.map((m) => m.id),
		]).toEqual(["b", "a", "c"]);
		expect([
			...[mem("c", 30), mem("b", Number.NaN), mem("a", 10)]
				.sort(desc)
				.map((m) => m.id),
		]).toEqual(["c", "a", "b"]);
	});
	it("breaks ties by id", () => {
		expect([
			...[mem("b", 10), mem("a", 10)].sort(asc).map((m) => m.id),
		]).toEqual(["a", "b"]);
		expect([
			...[mem("a", 10), mem("b", 10)].sort(desc).map((m) => m.id),
		]).toEqual(["b", "a"]);
	});
});
