/**
 * Tests for deterministic post-generation verbosity enforcement.
 */
import { describe, expect, it } from "vitest";
import { MAX_TERSE_TOKENS } from "./types.ts";
import {
	approximateTokenCount,
	enforceVerbosity,
} from "./verbosity-enforcer.ts";

describe("approximateTokenCount", () => {
	it("counts an empty string as zero tokens", () => {
		expect(approximateTokenCount("")).toBe(0);
		expect(approximateTokenCount("   ")).toBe(0);
	});

	it("estimates tokens as ceil(words * 1.3)", () => {
		expect(approximateTokenCount("one")).toBe(2); // ceil(1 * 1.3)
		expect(approximateTokenCount("a b c")).toBe(4); // ceil(3 * 1.3)
		expect(approximateTokenCount("hello world foo bar")).toBe(6); // ceil(4*1.3)
	});

	it("ignores leading and trailing whitespace", () => {
		expect(approximateTokenCount("  a b  ")).toBe(3); // ceil(2 * 1.3)
	});

	it("counts newline-separated words", () => {
		expect(approximateTokenCount("line1\nline2\nline3")).toBe(4);
	});
});

describe("enforceVerbosity", () => {
	it("passes normal responses through unchanged", () => {
		const result = enforceVerbosity("long reply here", "normal");
		expect(result.text).toBe("long reply here");
		expect(result.truncated).toBe(false);
		expect(result.originalTokens).toBe(4);
		expect(result.finalTokens).toBe(result.originalTokens);
	});

	it("passes verbose responses through unchanged", () => {
		const text = "very verbose response";
		const result = enforceVerbosity(text, "verbose");
		expect(result.text).toBe(text);
		expect(result.truncated).toBe(false);
	});

	it("passes null and undefined verbosity through unchanged", () => {
		const text = "some response";
		expect(enforceVerbosity(text, null).text).toBe(text);
		expect(enforceVerbosity(text, undefined).text).toBe(text);
	});

	it("keeps terse responses under the token cap intact", () => {
		const short = "short reply";
		const result = enforceVerbosity(short, "terse");
		expect(result.text).toBe(short);
		expect(result.truncated).toBe(false);
		expect(result.finalTokens).toBeLessThanOrEqual(MAX_TERSE_TOKENS);
	});

	it("truncates an over-limit terse response at a sentence boundary", () => {
		// The word cap lands at 46 words; the "Cut here." sentence sits inside.
		const long = `${"word ".repeat(44)}Cut here. ${"word ".repeat(30)}`;
		const result = enforceVerbosity(long, "terse");
		expect(result.truncated).toBe(true);
		expect(result.text).toMatch(/\.$/);
		expect(result.text.split(" ").length).toBeLessThanOrEqual(46);
		expect(result.finalTokens).toBeLessThan(result.originalTokens);
	});

	it("does not treat a dot glued to the next character as a sentence end", () => {
		// The dot in "app/layout.tsx" must not cut the reply mid-filename.
		const long = `${"word ".repeat(40)}see app/layout.tsx for more ${"word ".repeat(30)}`;
		const result = enforceVerbosity(long, "terse");
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("app/layout");
		expect(result.text.endsWith("…")).toBe(true);
	});

	it("hard-cuts with an ellipsis when no sentence boundary exists", () => {
		const long = "no punctuation anywhere ".repeat(20);
		const result = enforceVerbosity(long, "terse");
		expect(result.truncated).toBe(true);
		expect(result.text.endsWith("…")).toBe(true);
		expect(result.text.endsWith(". ")).toBe(false);
	});

	it("handles question sentence terminators", () => {
		const long = `${"word ".repeat(40)}Is this a question? More text here.`;
		const result = enforceVerbosity(long, "terse");
		expect(result.truncated).toBe(true);
		expect(result.text.endsWith("?")).toBe(true);
	});

	it("counts original tokens before truncation", () => {
		const long = "word ".repeat(100);
		const result = enforceVerbosity(long, "terse");
		expect(result.originalTokens).toBe(approximateTokenCount(long));
	});
});
