/**
 * Tests the standalone verification-output parsers with deterministic Vitest
 * summary lines, including the mixed-order format emitted by real reporters.
 */
import { describe, expect, it } from "vitest";
import {
	parseVitestCounts,
	parseVitestOutput,
} from "./verification-helpers.js";

describe("parseVitestOutput", () => {
	it.each([
		["passed before failed", "Tests 1 passed | 2 failed (3)", 1, 2],
		["failed before passed", "Tests 2 failed | 5 passed (7)", 5, 2],
		["passed only", "Tests 8 passed (8)", 8, 0],
		["failed only", "Tests 3 failed (3)", 0, 3],
	])("captures %s counts", (_name, output, passed, failed) => {
		expect(parseVitestOutput(output)).toMatchObject({ passed, failed });
	});

	it("keeps an unrecognized summary distinct from a real zero count", () => {
		expect(
			parseVitestCounts("Test Files 1 passed (1)\nDuration 10ms"),
		).toBeNull();
		expect(parseVitestCounts("Tests no tests")).toBeNull();
	});

	it("collects unique failure names when the summary is absent", () => {
		expect(
			parseVitestOutput("× first failure\n× first failure\n✗ second failure"),
		).toMatchObject({
			passed: 0,
			failed: 2,
			failures: ["first failure", "second failure"],
		});
	});
});
