/** Unit tests for voice metric-math helpers (rounding, percentiles). Deterministic. */
import { describe, expect, it } from "vitest";
import { percentile, round1, round4 } from "./metric-math";

describe("round1", () => {
	it("rounds to one decimal place", () => {
		expect(round1(12.34)).toBe(12.3);
	});

	it("rounds half up", () => {
		expect(round1(0.25)).toBe(0.3);
	});

	it("leaves integers unchanged", () => {
		expect(round1(42)).toBe(42);
	});
});

describe("round4", () => {
	it("rounds to four decimal places", () => {
		expect(round4(0.123456)).toBe(0.1235);
	});

	it("leaves shorter values unchanged", () => {
		expect(round4(0.12)).toBe(0.12);
	});
});

describe("percentile", () => {
	it("computes the nearest-rank percentile", () => {
		const sample = [10, 20, 30, 40, 50];
		// p50 over 5 elements: rank = ceil(0.5 * 5) = 3 -> index 2 -> 30
		expect(percentile(sample, 50)).toBe(30);
		// p95: rank = ceil(0.95 * 5) = 5 -> index 4 -> 50
		expect(percentile(sample, 95)).toBe(50);
		// p0: rank = ceil(0) = 0 -> clamped to index 0 -> 10
		expect(percentile(sample, 0)).toBe(10);
	});

	it("sorts before ranking", () => {
		expect(percentile([50, 10, 30, 20, 40], 50)).toBe(30);
	});

	it("filters non-finite values before ranking", () => {
		const sample = [10, Number.NaN, 20, Number.POSITIVE_INFINITY, 30];
		// finite = [10, 20, 30]; p50: rank = ceil(0.5 * 3) = 2 -> index 1 -> 20
		expect(percentile(sample, 50)).toBe(20);
	});

	it("rounds the result to one decimal place", () => {
		// finite single sample -> returned via round1
		expect(percentile([12.34], 50)).toBe(12.3);
	});

	it("returns null for an empty sample", () => {
		expect(percentile([], 50)).toBeNull();
	});

	it("returns null when every value is non-finite", () => {
		expect(percentile([Number.NaN, Number.POSITIVE_INFINITY], 50)).toBeNull();
	});
});
