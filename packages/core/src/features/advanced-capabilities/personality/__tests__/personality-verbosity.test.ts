/**
 * Unit-tests the verbosity enforcer (enforceVerbosity, approximateTokenCount):
 * pass-through for normal/verbose/null, and terse truncation at the sentence
 * boundary or via ellipsis once a reply exceeds the terse token cap. Pure
 * functions, no runtime.
 */
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

describe("terse truncation preserves structure and real sentence boundaries", () => {
	test("does not treat a dot inside a filename as a sentence end (live 86-char cut)", () => {
		const text = [
			"- layout.tsx was changed and you wanted it reverted",
			"- ran `git checkout -- app/layout.tsx` in /home/milady/projects/agent-home — exit 0, revert done",
			'- earlier i tried to build an app called "layout-restorer" (wrong move) and it failed verification twice',
			"- you stopped that and clarified you just wanted the file git-reverted, not an app built",
		].join("\n");
		const result = enforceVerbosity(text, "terse");
		expect(result.truncated).toBe(true);
		// The old lastIndexOf(".") cut delivered exactly this broken prefix.
		expect(result.text).not.toBe(
			"- layout.tsx was changed and you wanted it reverted - ran `git checkout -- app/layout.",
		);
		expect(result.text.endsWith("app/layout.")).toBe(false);
		// Newlines survive: the truncated block keeps its bullet structure.
		expect(result.text).toContain("\n");
	});

	test("still truncates at a genuine sentence boundary", () => {
		const sentence = "This is a real sentence that ends cleanly.";
		const filler = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const result = enforceVerbosity(`${sentence} ${filler}`, "terse");
		expect(result.truncated).toBe(true);
		expect(result.text).toBe(sentence);
	});
});
