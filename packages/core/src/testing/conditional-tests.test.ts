/**
 * Unit coverage for conditional test runners in conditional-tests.ts.
 *
 * Tests describeIf, itIf, and testIf returning active runners when true
 * and skip runners when false.
 */

import { describe, expect, it, test } from "vitest";
import { describeIf, itIf, testIf } from "./conditional-tests.js";

describe("conditional-tests", () => {
	describe("describeIf", () => {
		it("returns describe when condition is true", () => {
			expect(describeIf(true)).toBe(describe);
		});

		it("returns a skip suite function when condition is false", () => {
			const runner = describeIf(false);
			expect(typeof runner).toBe("function");
			expect(runner).not.toBe(describe);
		});
	});

	describe("itIf", () => {
		it("returns it when condition is true", () => {
			expect(itIf(true)).toBe(it);
		});

		it("returns a skip test function when condition is false", () => {
			const runner = itIf(false);
			expect(typeof runner).toBe("function");
			expect(runner).not.toBe(it);
		});
	});

	describe("testIf", () => {
		it("returns test when condition is true", () => {
			expect(testIf(true)).toBe(test);
		});

		it("returns a skip test function when condition is false", () => {
			const runner = testIf(false);
			expect(typeof runner).toBe("function");
			expect(runner).not.toBe(test);
		});
	});
});
