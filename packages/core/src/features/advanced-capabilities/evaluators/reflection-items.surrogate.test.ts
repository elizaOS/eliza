/** Surrogate safety for boundRender in reflection-items.ts. */
import { describe, expect, test } from "vitest";
import { boundRender } from "./reflection-items.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("reflection-items boundRender surrogate safety", () => {
	test("emoji at boundary before suffix backs off without lone surrogate", () => {
		const fox = "🦊";
		const input = `${"a".repeat(15)}${fox}${"b".repeat(20)}`;
		const out = boundRender(input, 25);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith("…[truncated]")).toBe(true);
		expect(() => JSON.stringify({ out })).not.toThrow();
	});

	test("fitting text with emoji untouched", () => {
		const fox = "🦊";
		const input = `Short ${fox} text`;
		const out = boundRender(input, 50);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	test("lone high surrogate in text sanitized safely", () => {
		const badInput = `Bad \ud800 in reflection text ${"x".repeat(100)}`;
		const out = boundRender(badInput, 30);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
	});

	test("very small maxChars budget truncates suffix safely", () => {
		expect(boundRender("some long text", 0)).toBe("");
		expect(boundRender("some long text", 1)).toBe("…");
		expect(boundRender("some long text", 5)).toBe("…[tru");
	});

	test("sweep offsets around max budget all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -5; offset <= 5; offset++) {
			const n = 30 + offset;
			const input = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
			const out = boundRender(input, 35);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ out })).not.toThrow();
		}
	});
});
