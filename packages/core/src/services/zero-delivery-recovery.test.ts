import { describe, expect, test } from "bun:test";

interface ActionResultFixture {
	success: boolean;
	data?: unknown;
}

function ranNonSilentAction(
	actionResults: readonly ActionResultFixture[],
	suppressesPlannerReply = false,
): boolean {
	return (
		actionResults.some((result) => result.success === true) &&
		!suppressesPlannerReply
	);
}

describe("zero-delivery recovery", () => {
	test("all action results are errors", () => {
		const actionResults = [
			{ success: false, data: { error: "first tool failed" } },
			{ success: false, data: { error: "second tool failed" } },
		];

		expect(ranNonSilentAction(actionResults)).toBe(false);
	});

	test("at least one action result is successful", () => {
		const actionResults = [{ success: true, data: { value: "done" } }];

		expect(ranNonSilentAction(actionResults)).toBe(true);
	});

	test("empty action results", () => {
		expect(ranNonSilentAction([])).toBe(false);
	});

	test("mixed successful and failed action results", () => {
		const actionResults = [
			{ success: false, data: { error: "tool failed" } },
			{ success: true, data: { value: "done" } },
		];

		expect(ranNonSilentAction(actionResults)).toBe(true);
	});
});
