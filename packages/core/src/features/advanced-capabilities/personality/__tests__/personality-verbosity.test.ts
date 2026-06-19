import { describe, expect, test } from "vitest";
import { MAX_TERSE_TOKENS } from "../types.ts";
import {
	approximateTokenCount,
	enforceVerbosity,
} from "../verbosity-enforcer.ts";

describe("enforceVerbosity", () => {
	test("normal verbosity is pass-through", () => {
		const result = enforceVerbosity(
			"This is a moderately long reply that is fine when not terse.",
			"normal",
		);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("moderately");
	});

	test("verbose verbosity is pass-through", () => {
		const text = "a ".repeat(200);
		const result = enforceVerbosity(text, "verbose");
		expect(result.truncated).toBe(false);
	});

	test("terse leaves short replies alone", () => {
		const result = enforceVerbosity("Short answer.", "terse");
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("Short answer.");
	});

	test("terse truncates over-budget replies at the sentence boundary", () => {
		// ~90 words ≈ 117 tokens, well over the cap of 60.
		const sentences = Array.from(
			{ length: 15 },
			(_, i) =>
				`This is sentence ${i + 1} which has several extra words to bulk it up.`,
		);
		const text = sentences.join(" ");
		const result = enforceVerbosity(text, "terse");
		expect(result.truncated).toBe(true);
		expect(result.finalTokens).toBeLessThanOrEqual(MAX_TERSE_TOKENS);
		expect(result.text.endsWith(".")).toBe(true);
	});

	test("terse with no sentence boundary uses ellipsis", () => {
		// 80 words, no punctuation — single sentence too long.
		const text = `${"word ".repeat(80).trim()}`;
		const result = enforceVerbosity(text, "terse");
		expect(result.truncated).toBe(true);
		expect(result.text.endsWith("…")).toBe(true);
	});

	test("null verbosity is pass-through", () => {
		const result = enforceVerbosity("any text here", null);
		expect(result.truncated).toBe(false);
	});
});

describe("approximateTokenCount", () => {
	test("counts whitespace-delimited words with 1.3 multiplier", () => {
		expect(approximateTokenCount("hello world")).toBe(3); // ceil(2*1.3)
		expect(approximateTokenCount("")).toBe(0);
		expect(approximateTokenCount("one")).toBe(2); // ceil(1*1.3)
	});
});
