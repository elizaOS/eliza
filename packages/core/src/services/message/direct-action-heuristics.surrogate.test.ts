/** Surrogate safety for unwrapPlannerIdentifier / normalizeActionIdentifier in direct-action-heuristics. */
import { describe, expect, test } from "vitest";
import { normalizeActionIdentifier } from "./direct-action-heuristics.ts";

describe("direct-action-heuristics unwrapPlannerIdentifier surrogate safety", () => {
	test("emoji at 9999 boundary backs off cleanly without lone surrogate at 10000 cap", () => {
		const fox = "🦊";
		const input = `${"a".repeat(9999)}${fox}`;
		expect(() => normalizeActionIdentifier(input)).not.toThrow();
	});

	test("fitting emoji normalized without mangling", () => {
		const input = "MY_ACTION_🦊";
		const normalized = normalizeActionIdentifier(input);
		expect(normalized).toBe("MYACTION🦊");
	});

	test("lone high surrogate in action identifier does not throw", () => {
		const badInput = `bad \ud800 in action ${"x".repeat(12000)}`;
		expect(() => normalizeActionIdentifier(badInput)).not.toThrow();
	});

	test("sweep offsets around 10000 cap all normalize safely", () => {
		const fox = "🦊";
		for (let n = 9990; n <= 10005; n++) {
			const action = `${"a".repeat(n)}${fox}`;
			expect(() => normalizeActionIdentifier(action)).not.toThrow();
		}
	});
});
