/** Surrogate safety for verbosity-enforcer.ts. */
import { describe, expect, test } from "vitest";
import { enforceVerbosity } from "./verbosity-enforcer.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("verbosity-enforcer surrogate safety", () => {
	test("emoji in word at cut boundary stays well-formed", () => {
		const fox = "🦊";
		const words = Array.from({ length: 60 }, (_, i) =>
			i === 45 ? `word${fox}` : `w${i}`,
		);
		const text = words.join(" ");
		const res = enforceVerbosity(text, "terse");
		expect(isWellFormed(res.text)).toBe(true);
		expect(() => JSON.stringify(res)).not.toThrow();
	});

	test("sentence ending with emoji terminator stays well-formed", () => {
		const fox = "🦊";
		const text = `Here is the first sentence with ${fox}. ${Array.from({ length: 60 }, (_, i) => `extra${i}`).join(" ")}`;
		const res = enforceVerbosity(text, "terse");
		expect(isWellFormed(res.text)).toBe(true);
		expect(res.text.includes(fox)).toBe(true);
	});

	test("lone high surrogate in response text is sanitized safely", () => {
		const badText = `First sentence \ud800 text. ${Array.from({ length: 60 }, (_, i) => `extra${i}`).join(" ")}`;
		const res = enforceVerbosity(badText, "terse");
		expect(isWellFormed(res.text)).toBe(true);
		expect(res.text.includes("\ud800")).toBe(false);
	});

	test("sweep word counts around terse cap all stay well-formed", () => {
		const fox = "🦊";
		for (let words = 40; words <= 55; words++) {
			const text = Array.from({ length: words }, (_, i) =>
				i % 5 === 0 ? `w${fox}` : `w${i}`,
			).join(" ");
			const res = enforceVerbosity(text, "terse");
			expect(isWellFormed(res.text)).toBe(true);
			expect(() => JSON.stringify(res)).not.toThrow();
		}
	});
});
