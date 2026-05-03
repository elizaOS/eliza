import { describe, expect, it } from "vitest";
import { sliceToFitBudget } from "./slice-to-fit-budget";

describe("sliceToFitBudget", () => {
	const items = ["one", "two", "three", "four"];
	const estimateChars = (s: string) => s.length;

	it("handles empty array input", () => {
		expect(sliceToFitBudget([], estimateChars, 100)).toEqual([]);
	});

	it("handles zero or negative budget", () => {
		expect(sliceToFitBudget(items, estimateChars, 0)).toEqual([]);
		expect(sliceToFitBudget(items, estimateChars, -10)).toEqual([]);
	});

	it("slices from start by default", () => {
		const result = sliceToFitBudget(items, estimateChars, 6);
		expect(result).toEqual(["one", "two"]); // 'one' (3) + 'two' (3) = 6 chars
	});

	it("slices from end when fromEnd option is true", () => {
		const result = sliceToFitBudget(items, estimateChars, 8, { fromEnd: true });
		expect(result).toEqual(["four"]);
	});

	it("returns at least one item if any single item fits", () => {
		const largeItems = ["tiny", "enormous", "huge"];
		const result = sliceToFitBudget(largeItems, estimateChars, 4);
		expect(result).toEqual(["tiny"]);
	});

	it("returns empty array if no single item fits budget", () => {
		const largeItems = ["enormous", "huge"];
		const result = sliceToFitBudget(largeItems, estimateChars, 3);
		expect(result).toEqual([]);
	});

	it("handles exact budget matches", () => {
		const result = sliceToFitBudget(items, estimateChars, 8);
		expect(result).toEqual(["one", "two"]); // 'one' (3) + 'two' (3) = 6 chars fits exactly
	});
});
