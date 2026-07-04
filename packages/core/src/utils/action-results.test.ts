/**
 * Action-result helpers bound how much of a (potentially huge) tool output
 * lands in prompt state. Token estimation, middle-truncation with a full-output
 * reference, and oversize warnings keep a verbose action from blowing the
 * context budget.
 */

import { describe, expect, it } from "vitest";
import type { ActionResult } from "../types/components";
import {
	collectActionResultSizeWarnings,
	estimateActionResultTokens,
	getActionResultActionName,
	getActionResultReference,
	stringifyActionResultError,
	truncateMiddle,
} from "./action-results.ts";

const result = (r: Partial<ActionResult>): ActionResult => r as ActionResult;

describe("estimateActionResultTokens", () => {
	it("estimates ~1 token per 4 chars (ceil)", () => {
		expect(estimateActionResultTokens("12345678")).toBe(2);
		expect(estimateActionResultTokens("12345")).toBe(2); // ceil(5/4)
		expect(estimateActionResultTokens("")).toBe(0);
	});
});

describe("getActionResultActionName", () => {
	it("reads data.actionName, else 'Unknown Action'", () => {
		expect(
			getActionResultActionName(result({ data: { actionName: "FOO" } })),
		).toBe("FOO");
		expect(
			getActionResultActionName(result({ data: { actionName: "  " } })),
		).toBe("Unknown Action");
		expect(getActionResultActionName(result({}))).toBe("Unknown Action");
	});
});

describe("stringifyActionResultError", () => {
	it("normalizes Error/string/other, passes through nullish", () => {
		expect(stringifyActionResultError(undefined)).toBeUndefined();
		expect(stringifyActionResultError(null)).toBeUndefined();
		expect(stringifyActionResultError(new Error("boom"))).toBe("boom");
		expect(stringifyActionResultError("raw")).toBe("raw");
		expect(stringifyActionResultError(42)).toBe("42");
	});
});

describe("getActionResultReference", () => {
	it("pulls a full-output path from data, else undefined", () => {
		expect(
			getActionResultReference(
				result({ data: { fullOutputPath: "/tmp/out" } }),
				"text",
			),
		).toBe("/tmp/out");
		expect(getActionResultReference(result({}), "text")).toBeUndefined();
	});
});

describe("truncateMiddle", () => {
	it("returns short text trimmed, unchanged", () => {
		expect(truncateMiddle("  short  ", 100)).toBe("short");
	});

	it("middle-truncates long text and can append a reference", () => {
		const long = "x".repeat(500);
		const out = truncateMiddle(long, 80);
		expect(out.length).toBeLessThan(long.length);
		expect(out).toMatch(/chars omitted/);
		expect(out.startsWith("x")).toBe(true);

		const withRef = truncateMiddle(long, 80, "/tmp/full");
		expect(withRef).toMatch(/Full output: \/tmp\/full$/);
	});
});

describe("collectActionResultSizeWarnings", () => {
	it("warns only when a field exceeds the token threshold", () => {
		const r = result({ text: "12345678", data: { actionName: "FOO" } });
		expect(collectActionResultSizeWarnings(r)).toEqual([]); // default threshold huge
		const warnings = collectActionResultSizeWarnings(r, 1);
		expect(warnings).toEqual([
			{
				actionName: "FOO",
				field: "text",
				rawCharLength: 8,
				estimatedTokens: 2,
				thresholdTokens: 1,
			},
		]);
	});
});
