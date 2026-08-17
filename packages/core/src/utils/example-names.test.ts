/**
 * Unit tests for EXAMPLE_NAMES and pickRandomExampleName in packages/core/src/utils/example-names.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_NAMES, pickRandomExampleName } from "./example-names";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("EXAMPLE_NAMES", () => {
	it("contains non-empty list of unique example names", () => {
		expect(EXAMPLE_NAMES.length).toBeGreaterThan(0);
		const unique = new Set(EXAMPLE_NAMES);
		expect(unique.size).toBe(EXAMPLE_NAMES.length);
	});
});

describe("pickRandomExampleName", () => {
	it("returns a valid name from EXAMPLE_NAMES on standard call", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const name = pickRandomExampleName(0);
		expect(name).toBe(EXAMPLE_NAMES[0]);
	});

	it("handles negative indices using positive modulo wrapping", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		expect(pickRandomExampleName(-1)).toBe(EXAMPLE_NAMES.at(-1));
		expect(pickRandomExampleName(-EXAMPLE_NAMES.length)).toBe(EXAMPLE_NAMES[0]);
		expect(pickRandomExampleName(-EXAMPLE_NAMES.length - 2)).toBe(
			EXAMPLE_NAMES.at(-2),
		);
	});

	it("maps non-finite arguments to index zero", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		expect(pickRandomExampleName(Number.NaN)).toBe(EXAMPLE_NAMES[0]);
		expect(pickRandomExampleName(Number.POSITIVE_INFINITY)).toBe(
			EXAMPLE_NAMES[0],
		);
		expect(pickRandomExampleName(Number.NEGATIVE_INFINITY)).toBe(
			EXAMPLE_NAMES[0],
		);
	});

	it("floors fractional indices and wraps large positive indices", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		expect(pickRandomExampleName(1.9)).toBe(EXAMPLE_NAMES[1]);
		expect(pickRandomExampleName(EXAMPLE_NAMES.length * 100 + 2)).toBe(
			EXAMPLE_NAMES[2],
		);
	});
});
