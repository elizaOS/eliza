import { describe, expect, it } from "vitest";
import { trimEndCharacters, trimEndWhitespace } from "./string-boundaries.ts";

describe("trimEndCharacters", () => {
	it("trims matching characters from the end", () => {
		expect(trimEndCharacters("hello!!!", "!")).toBe("hello");
		expect(trimEndCharacters("abccba", "ab")).toBe("abcc");
	});

	it("does not split surrogate pairs (emoji)", () => {
		// 🎨 is U+1F3A8 = surrogate pair; trimming "x" must not cut it
		const value = "art🎨xxx";
		expect(trimEndCharacters(value, "x")).toBe("art🎨");
	});

	it("returns the original when nothing matches", () => {
		const value = "hello";
		expect(trimEndCharacters(value, "z")).toBe(value);
	});

	it("handles empty strings", () => {
		expect(trimEndCharacters("", "x")).toBe("");
	});

	it("trims multiple distinct characters", () => {
		expect(trimEndCharacters("abc...", ".c")).toBe("ab");
	});
});

describe("trimEndWhitespace", () => {
	it("trims trailing whitespace", () => {
		expect(trimEndWhitespace("hello   ")).toBe("hello");
		expect(trimEndWhitespace("hello\t\n")).toBe("hello");
	});

	it("keeps leading whitespace", () => {
		expect(trimEndWhitespace("  hello  ")).toBe("  hello");
	});

	it("handles empty and all-whitespace strings", () => {
		expect(trimEndWhitespace("")).toBe("");
		expect(trimEndWhitespace("   ")).toBe("");
	});

	it("does not trim unicode non-whitespace", () => {
		expect(trimEndWhitespace("日本語")).toBe("日本語");
	});
});
