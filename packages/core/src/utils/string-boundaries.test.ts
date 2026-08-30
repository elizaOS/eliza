import { describe, expect, it } from "vitest";
import { trimEndCharacters, trimEndWhitespace } from "./string-boundaries";

describe("trimEndCharacters", () => {
	it("trims trailing characters from the set", () => {
		expect(trimEndCharacters("hellooo", "o")).toBe("hell");
		expect(trimEndCharacters("hello...", ".")).toBe("hello");
		expect(trimEndCharacters("hello!!!", "!")).toBe("hello");
	});

	it("trims multiple different characters from the set", () => {
		expect(trimEndCharacters("helloabc", "abc")).toBe("hello");
		expect(trimEndCharacters("hello   ", " ")).toBe("hello");
	});

	it("returns original string when nothing to trim", () => {
		expect(trimEndCharacters("hello", "xyz")).toBe("hello");
		expect(trimEndCharacters("hello", "")).toBe("hello");
	});

	it("handles empty string", () => {
		expect(trimEndCharacters("", "abc")).toBe("");
	});

	it("handles string of all trimable characters", () => {
		expect(trimEndCharacters("aaaa", "a")).toBe("");
		expect(trimEndCharacters("abcabc", "abc")).toBe("");
	});

	it("preserves leading characters", () => {
		expect(trimEndCharacters("aaabbb", "b")).toBe("aaa");
		expect(trimEndCharacters("   hello   ", " ")).toBe("   hello");
	});

	it("handles surrogate pairs correctly", () => {
		// 💀 = \uD83D\uDC80 (2 code units)
		expect(trimEndCharacters("hello💀💀", "💀")).toBe("hello");
		expect(trimEndCharacters("hello💀", "o")).toBe("hello💀");
	});

	it("handles unicode characters in trim set", () => {
		expect(trimEndCharacters("caféé", "é")).toBe("caf");
	});
});

describe("trimEndWhitespace", () => {
	it("trims trailing whitespace", () => {
		expect(trimEndWhitespace("hello   ")).toBe("hello");
		expect(trimEndWhitespace("hello\t\n")).toBe("hello");
		expect(trimEndWhitespace("hello ")).toBe("hello");
	});

	it("returns original string when no trailing whitespace", () => {
		expect(trimEndWhitespace("hello")).toBe("hello");
		expect(trimEndWhitespace("hello world")).toBe("hello world");
	});

	it("handles empty string", () => {
		expect(trimEndWhitespace("")).toBe("");
	});

	it("handles whitespace-only string", () => {
		expect(trimEndWhitespace("   ")).toBe("");
		expect(trimEndWhitespace("\t\n\r")).toBe("");
	});

	it("preserves leading whitespace", () => {
		expect(trimEndWhitespace("  hello  ")).toBe("  hello");
		expect(trimEndWhitespace("\thello\n")).toBe("\thello");
	});

	it("handles various whitespace characters", () => {
		expect(trimEndWhitespace("hello\u00A0")).toBe("hello"); // non-breaking space
		expect(trimEndWhitespace("hello\u2003")).toBe("hello"); // em space
	});
});
