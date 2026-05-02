import { describe, expect, it } from "vitest";
import type { ActionResult } from "../types";
import {
	collectActionResultSizeWarnings,
	formatActionResultsForPrompt,
	MAX_PROMPTED_ACTION_RESULTS,
	trimActionResultForPromptState,
} from "./action-results";

function result(index: number, text = `output-${index}`): ActionResult {
	return {
		success: true,
		text,
		data: { actionName: `ACTION_${index}` },
	};
}

describe("formatActionResultsForPrompt", () => {
	it("returns an empty-state message when no results are available", () => {
		expect(formatActionResultsForPrompt([])).toBe(
			"No action results available.",
		);
	});

	it("renders exactly the configured cap without an omission note", () => {
		const formatted = formatActionResultsForPrompt(
			Array.from({ length: MAX_PROMPTED_ACTION_RESULTS }, (_, index) =>
				result(index + 1),
			),
		);

		expect(formatted).not.toContain("omitted");
		expect(formatted).toContain("1. ACTION_1 - succeeded");
		expect(formatted).toContain("8. ACTION_8 - succeeded");
	});

	it("keeps only the newest results and preserves absolute numbering", () => {
		const formatted = formatActionResultsForPrompt(
			Array.from({ length: 10 }, (_, index) => result(index + 1)),
		);

		expect(formatted).toContain("(2 earlier action result(s) omitted.)");
		expect(formatted).toContain("3. ACTION_3 - succeeded");
		expect(formatted).toContain("10. ACTION_10 - succeeded");
		expect(formatted).not.toContain("1. ACTION_1 - succeeded");
		expect(formatted).not.toContain("2. ACTION_2 - succeeded");
	});
});

describe("trimActionResultForPromptState", () => {
	it("keeps the beginning and end of oversized output and includes the full-output reference", () => {
		const trimmed = trimActionResultForPromptState(
			result(1, `${"a".repeat(5000)}middle${"z".repeat(5000)}`),
			{ text: "/tmp/full-output.txt" },
		);

		expect(trimmed.text).toContain("aaa");
		expect(trimmed.text).toContain("zzz");
		expect(trimmed.text).toContain("chars omitted");
		expect(trimmed.text).toContain("Full output: /tmp/full-output.txt");
		expect(trimmed.data?.fullOutputPath).toBe("/tmp/full-output.txt");
	});

	it("reports raw outputs above the warning token threshold", () => {
		const warnings = collectActionResultSizeWarnings(
			result(1, "x".repeat(40004)),
		);

		expect(warnings).toEqual([
			expect.objectContaining({
				actionName: "ACTION_1",
				field: "text",
				estimatedTokens: 10001,
				thresholdTokens: 10000,
			}),
		]);
	});
});
