/**
 * Unit tests for sliceToFitBudget against real arrays and a real estimator (no
 * mocks): it bounds prompt size for providers, so the invariant that matters is
 * that the returned slice never exceeds the budget and never silently drops an
 * item that would have fit. Both directions are covered because `fromEnd`
 * selects the newest items — the case a provider uses when recent context
 * matters more than old.
 */
import { describe, expect, it } from "vitest";
import { sliceToFitBudget } from "./slice-to-fit-budget";

/** Estimator matching the real usage shape: cost derived from the item itself. */
const byLength = (item: string) => item.length;

describe("sliceToFitBudget", () => {
	it("returns everything when the whole set fits", () => {
		const items = ["aaa", "bb", "c"];
		expect(sliceToFitBudget(items, byLength, 100)).toEqual(items);
	});

	it("keeps the running total within the budget", () => {
		const items = ["aaaaa", "bbbbb", "ccccc"];
		const kept = sliceToFitBudget(items, byLength, 12);

		expect(kept).toEqual(["aaaaa", "bbbbb"]);
		expect(
			kept.reduce((sum, item) => sum + item.length, 0),
		).toBeLessThanOrEqual(12);
	});

	it("includes an item that exactly exhausts the budget", () => {
		// Boundary: the comparison is `>`, so a perfect fit must be kept rather
		// than dropped — otherwise a provider silently loses one item per call.
		expect(sliceToFitBudget(["aaaaa", "bbbbb"], byLength, 10)).toEqual([
			"aaaaa",
			"bbbbb",
		]);
	});

	it("returns empty when the first item alone exceeds the budget", () => {
		expect(sliceToFitBudget(["aaaaaaaaaa"], byLength, 3)).toEqual([]);
	});

	it("stops at the first item that does not fit rather than skipping it", () => {
		// The result is a contiguous prefix: a later small item is NOT pulled
		// forward past a large one, because callers rely on order being preserved.
		expect(sliceToFitBudget(["aaaaaaaa", "b"], byLength, 5)).toEqual([]);
	});

	it("returns empty for an empty input", () => {
		expect(sliceToFitBudget([], byLength, 100)).toEqual([]);
	});

	it("returns empty for a zero or negative budget", () => {
		expect(sliceToFitBudget(["a"], byLength, 0)).toEqual([]);
		expect(sliceToFitBudget(["a"], byLength, -10)).toEqual([]);
	});

	it("treats a zero budget as no room even for a zero-cost item", () => {
		// Without the explicit `targetChars <= 0` guard this returns [""],
		// because 0 + 0 never exceeds 0. A caller asking for zero characters
		// wants nothing back, so the guard is load-bearing rather than cosmetic.
		expect(sliceToFitBudget([""], byLength, 0)).toEqual([]);
		expect(sliceToFitBudget([""], byLength, 0, { fromEnd: true })).toEqual([]);
	});

	it("keeps zero-cost items when there is any budget at all", () => {
		expect(sliceToFitBudget(["", "", "a"], byLength, 1)).toEqual(["", "", "a"]);
	});

	describe("fromEnd", () => {
		it("keeps the newest items and preserves their original order", () => {
			const items = ["old", "mid", "new"];
			expect(sliceToFitBudget(items, byLength, 6, { fromEnd: true })).toEqual([
				"mid",
				"new",
			]);
		});

		it("returns a contiguous suffix, never a gap", () => {
			// The oversized middle item blocks the older item even though that
			// item would fit in the remaining budget. Skipping the blocker would
			// turn a suffix into a gap and make the returned slice exceed budget.
			const items = ["old", "huuuuuuuge", "tail"];
			expect(sliceToFitBudget(items, byLength, 7, { fromEnd: true })).toEqual([
				"tail",
			]);
		});

		it("returns everything when the whole set fits", () => {
			const items = ["a", "b"];
			expect(sliceToFitBudget(items, byLength, 100, { fromEnd: true })).toEqual(
				items,
			);
		});

		it("returns empty when the newest item alone exceeds the budget", () => {
			expect(
				sliceToFitBudget(["a", "toooooo-long"], byLength, 3, { fromEnd: true }),
			).toEqual([]);
		});
	});

	it("estimates each item exactly once", () => {
		// The implementation sizes everything upfront specifically to avoid
		// double estimation; an estimator can be expensive (serialization), so
		// this pins the stated property rather than trusting the comment.
		const calls: string[] = [];
		const counting = (item: string) => {
			calls.push(item);
			return item.length;
		};

		sliceToFitBudget(["aa", "bb", "cc"], counting, 4);

		expect(calls).toEqual(["aa", "bb", "cc"]);
	});

	it("does not mutate the input array", () => {
		const items = ["aaa", "bbb", "ccc"];
		const copy = [...items];

		sliceToFitBudget(items, byLength, 4);
		sliceToFitBudget(items, byLength, 4, { fromEnd: true });

		expect(items).toEqual(copy);
	});

	it("works with non-string items via their own estimator", () => {
		const items = [{ chars: 5 }, { chars: 5 }, { chars: 5 }];
		expect(sliceToFitBudget(items, (item) => item.chars, 11)).toEqual([
			{ chars: 5 },
			{ chars: 5 },
		]);
	});
});
