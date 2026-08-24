/** Validates core's deterministic boundary scanners against long adversarial suffixes. */

import { describe, expect, it } from "vitest";
import { trimEndCharacters, trimEndWhitespace } from "./string-boundaries";

describe("core string boundary scanners", () => {
	it("trims only the requested suffix", () => {
		expect(trimEndCharacters("https://example.test///", "/")).toBe(
			"https://example.test",
		);
		expect(trimEndWhitespace("answer \t\n")).toBe("answer");
	});

	it("handles 100k-character suffixes in linear time", () => {
		expect(trimEndCharacters(`root${"/".repeat(100_000)}`, "/")).toBe("root");
		expect(trimEndWhitespace(`root${"\t".repeat(100_000)}`)).toBe("root");
	});

	it("does not split an unmatched Unicode code point", () => {
		const allowed = String.fromCodePoint(0x1f600);
		const sameLowSurrogate = String.fromCodePoint(0x1f200);
		expect(trimEndCharacters(`root${sameLowSurrogate}`, allowed)).toBe(
			`root${sameLowSurrogate}`,
		);
	});

	it("returns safe defaults for non-string inputs", () => {
		expect(trimEndCharacters(null as unknown as string, "/")).toBe("");
		expect(trimEndCharacters(undefined as unknown as string, "/")).toBe("");
		expect(trimEndCharacters(42 as unknown as string, "/")).toBe("");
		expect(trimEndCharacters("abc///", null as unknown as string)).toBe(
			"abc///",
		);
		expect(trimEndCharacters("abc///", undefined as unknown as string)).toBe(
			"abc///",
		);
		expect(trimEndCharacters("abc///", 42 as unknown as string)).toBe("abc///");
		expect(trimEndCharacters("abc///", "")).toBe("abc///");
		expect(trimEndCharacters("https://example.test///", "/")).toBe(
			"https://example.test",
		);
		expect(trimEndWhitespace(null as unknown as string)).toBe("");
		expect(trimEndWhitespace(undefined as unknown as string)).toBe("");
		expect(trimEndWhitespace(123 as unknown as string)).toBe("");
		expect(trimEndWhitespace("")).toBe("");
		expect(trimEndWhitespace("hello   ")).toBe("hello");
	});
});
