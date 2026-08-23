/**
 * Regression coverage for newest-first recency ordering in the MESSAGE
 * action's read_channel path (message.ts:3365/3425).
 *
 * Both the single-connector and fan-out branches sort connector memories
 * newest-first before slicing to the requested limit. A non-finite createdAt
 * previously returned NaN and left the slice in insertion order, surfacing
 * stale turns at the top of the read.
 */
import { describe, expect, it } from "vitest";
import { __testCompareMemoryByCreatedAtDesc as cmp } from "./message.ts";

function mem(id: string, createdAt: number | undefined) {
	return { id, createdAt } as { id: string; createdAt?: number };
}

describe("message read_channel recency ordering", () => {
	it("sorts newest-first", () => {
		expect([
			...[mem("a", 10), mem("c", 30), mem("b", 20)].sort(cmp).map((m) => m.id),
		]).toEqual(["c", "b", "a"]);
	});
	it("treats NaN/Infinity/undefined as 0 oldest", () => {
		expect([
			...[mem("b", Number.NaN), mem("c", 30), mem("a", 10)]
				.sort(cmp)
				.map((m) => m.id),
		]).toEqual(["c", "a", "b"]);
	});
	it("breaks ties by descending id", () => {
		expect([
			...[mem("a", 10), mem("b", 10)].sort(cmp).map((m) => m.id),
		]).toEqual(["b", "a"]);
	});
});
