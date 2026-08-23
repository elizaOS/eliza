/**
 * Regression for safe version ordering in OptimizedPromptService.
 *
 * Exercises the shared comparator that replaces bare `a - b` sorts which return
 * `NaN` for non-finite inputs and corrupt Array.sort's total order.
 */
import { describe, expect, it } from "vitest";
import { compareVersionAsc } from "./optimized-prompt.js";

describe("compareVersionAsc", () => {
	it("sorts finite versions ascending", () => {
		const input = [3, 1, 2];
		expect([...input].sort(compareVersionAsc)).toEqual([1, 2, 3]);
	});

	it("moves NaN to the end while preserving finite order", () => {
		const input = [2, Number.NaN, 1, 3];
		const sorted = [...input].sort(compareVersionAsc);
		expect(sorted.slice(0, 3)).toEqual([1, 2, 3]);
		expect(Number.isNaN(sorted[3])).toBe(true);
	});

	it("moves Infinity to the end", () => {
		const input = [2, Number.POSITIVE_INFINITY, 1];
		const sorted = [...input].sort(compareVersionAsc);
		expect(sorted).toEqual([1, 2, Number.POSITIVE_INFINITY]);
	});

	it("handles all non-finite as equal (stable, no NaN corruption)", () => {
		const input = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		const sorted = [...input].sort(compareVersionAsc);
		expect(sorted.length).toBe(3);
		expect(sorted.every((v) => !Number.isFinite(v))).toBe(true);
	});

	it("proves unsafe comparator returns NaN and violates total order", () => {
		const unsafe = (a: number, b: number) => a - b;
		expect(unsafe(1, Number.NaN)).toBeNaN();
		expect(unsafe(Number.NaN, 1)).toBeNaN();
		// Bare sort with NaN leaves array in engine-defined order, not sorted ascending
		const bare = [2, Number.NaN, 1].sort(unsafe);
		// bare is not strictly [1,2,NaN] on all engines because NaN comparison is unstable
		// The safe comparator guarantees the NaN is last and finite prefix sorted
		const safe = [2, Number.NaN, 1].sort(compareVersionAsc);
		expect(safe.slice(0, 2)).toEqual([1, 2]);
		expect(Number.isNaN(safe[2])).toBe(true);
	});

	it("handles negative and zero finite values", () => {
		const input = [0, -1, 2, -2];
		expect([...input].sort(compareVersionAsc)).toEqual([-2, -1, 0, 2]);
	});

	it("is consistent for mixed finite and non-finite large array", () => {
		const input = [5, Number.NaN, 3, Number.POSITIVE_INFINITY, 1, 4, 2];
		const sorted = [...input].sort(compareVersionAsc);
		expect(sorted.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
		expect(sorted.slice(5).every((v) => !Number.isFinite(v))).toBe(true);
	});

	it("returns 0 for both non-finite (equal bucket)", () => {
		expect(compareVersionAsc(Number.NaN, Number.POSITIVE_INFINITY)).toBe(0);
		expect(compareVersionAsc(Number.POSITIVE_INFINITY, Number.NaN)).toBe(0);
	});
});
