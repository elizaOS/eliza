/**
 * Action-result helpers preserve complete tool output for prompt state while
 * retaining diagnostic token estimates and oversize warnings.
 */

import { describe, expect, it } from "vitest";
import type { ActionResult } from "../types/components";
import {
	collectActionResultSizeWarnings,
	estimateActionResultTokens,
	formatActionResultsForPrompt,
	formatCompleteActionResultText,
	getActionResultActionName,
	getActionResultReference,
	stringifyActionResultError,
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

describe("formatCompleteActionResultText", () => {
	it("returns short text trimmed, unchanged", () => {
		expect(formatCompleteActionResultText("  short  ", 100)).toBe("short");
	});

	it("preserves long text despite a legacy max argument", () => {
		const long = `HEAD${"x".repeat(150_000)}TAIL`;
		const out = formatCompleteActionResultText(long, 80);
		expect(out).toBe(long);

		const withRef = formatCompleteActionResultText(long, 80, "/tmp/full");
		expect(withRef).toBe(`${long}\n\nFull output: /tmp/full`);
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

describe("formatCompleteActionResultText Unicode safety", () => {
	it("preserves complete emoji-bearing output", () => {
		const text = '{"user":"ana","note":"shipped 🚀 ok"},'.repeat(400);
		const out = formatCompleteActionResultText(text, 4000);
		expect(out).toBe(text);
		expect(out.isWellFormed()).toBe(true);
	});
});

describe("formatActionResultsForPrompt projections", () => {
	it("serializes promptData instead of duplicating complete data", () => {
		const rendered = formatActionResultsForPrompt(
			[
				result({
					success: true,
					text: "exact page",
					data: { body: "RAW_BODY_SENTINEL", actionName: "FILE" },
					promptData: { actionName: "FILE", safe: "metadata" },
				}),
			],
			{ includeData: true },
		);
		expect(rendered).toContain("exact page");
		expect(rendered).toContain("metadata");
		expect(rendered).not.toContain("RAW_BODY_SENTINEL");
	});
});
