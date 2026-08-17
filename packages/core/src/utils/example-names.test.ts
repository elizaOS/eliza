/**
 * Unit tests for EXAMPLE_NAMES and pickRandomExampleName in packages/core/src/utils/example-names.ts.
 */

import { describe, expect, it } from "vitest";
import { EXAMPLE_NAMES, pickRandomExampleName } from "./example-names";

describe("EXAMPLE_NAMES", () => {
	it("contains non-empty list of unique example names", () => {
		expect(EXAMPLE_NAMES.length).toBeGreaterThan(0);
		const unique = new Set(EXAMPLE_NAMES);
		expect(unique.size).toBe(EXAMPLE_NAMES.length);
	});
});

describe("pickRandomExampleName", () => {
	it("returns a valid name from EXAMPLE_NAMES on standard call", () => {
		const name = pickRandomExampleName(0);
		expect(EXAMPLE_NAMES).toContain(name as (typeof EXAMPLE_NAMES)[number]);
	});

	it("handles negative indices using positive modulo wrapping", () => {
		for (let i = -1; i >= -50; i--) {
			const name = pickRandomExampleName(i);
			expect(EXAMPLE_NAMES).toContain(name as (typeof EXAMPLE_NAMES)[number]);
		}
	});

	it("handles non-finite and non-number arguments safely", () => {
		const nameNaN = pickRandomExampleName(Number.NaN);
		expect(EXAMPLE_NAMES).toContain(nameNaN as (typeof EXAMPLE_NAMES)[number]);

		const nameInf = pickRandomExampleName(Number.POSITIVE_INFINITY);
		expect(EXAMPLE_NAMES).toContain(nameInf as (typeof EXAMPLE_NAMES)[number]);

		const nameNegInf = pickRandomExampleName(Number.NEGATIVE_INFINITY);
		expect(EXAMPLE_NAMES).toContain(
			nameNegInf as (typeof EXAMPLE_NAMES)[number],
		);

		const nameString = pickRandomExampleName("invalid" as unknown as number);
		expect(EXAMPLE_NAMES).toContain(
			nameString as (typeof EXAMPLE_NAMES)[number],
		);
	});

	it("handles large positive indices cleanly", () => {
		for (let i = 1; i <= 50; i++) {
			const name = pickRandomExampleName(i * 100);
			expect(EXAMPLE_NAMES).toContain(name as (typeof EXAMPLE_NAMES)[number]);
		}
	});
});
