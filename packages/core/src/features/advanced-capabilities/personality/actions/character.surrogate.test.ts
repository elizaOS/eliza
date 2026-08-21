/** Surrogate safety for trimToString in character.ts. */
import { describe, expect, test } from "vitest";
import { trimToString } from "./character.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("character action trimToString surrogate safety", () => {
	test("emoji at max boundary backs off without lone surrogate", () => {
		const fox = "🦊";
		const input = `${"a".repeat(9)}${fox}${"b".repeat(20)}`;
		const out = trimToString(input, 10);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out).toBe("a".repeat(9));
			expect(() => JSON.stringify({ out })).not.toThrow();
		}
	});

	test("fitting emoji ending at max kept intact", () => {
		const fox = "🦊";
		const input = `${"a".repeat(8)}${fox}`;
		const out = trimToString(input, 10);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
			expect(out).toBe(input);
		}
	});

	test("lone high surrogate is sanitized safely", () => {
		const badInput = "Bad \ud800 string value for character bio";
		const out = trimToString(badInput, 20);
		expect(out).toBeDefined();
		if (out) {
			expect(isWellFormed(out)).toBe(true);
		}
	});

	test("sweep offsets around max cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 5; n <= 15; n++) {
			const input = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
			const out = trimToString(input, 12);
			expect(out).toBeDefined();
			if (out) {
				expect(isWellFormed(out)).toBe(true);
				expect(() => JSON.stringify({ out })).not.toThrow();
			}
		}
	});
});
