/** Validates core's deterministic boundary scanners against long adversarial suffixes. */

import { describe, expect, it } from "vitest";
import {
	trimBoundaryCharacters,
	trimEndCharacters,
	trimEndWhitespace,
	trimStartCharacters,
} from "./string-boundaries";

describe("core string boundary scanners", () => {
	it("trims only the requested suffix", () => {
		expect(trimEndCharacters("https://example.test///", "/")).toBe(
			"https://example.test",
		);
		expect(trimEndWhitespace("answer \t\n")).toBe("answer");
	});

	it("trims requested prefixes and boundaries", () => {
		expect(trimStartCharacters("///https://example.test", "/")).toBe(
			"https://example.test",
		);
		expect(trimBoundaryCharacters("///https://example.test///", "/")).toBe(
			"https://example.test",
		);
	});

	it("handles 100k-character suffixes in linear time", () => {
		expect(trimEndCharacters(`root${"/".repeat(100_000)}`, "/")).toBe("root");
		expect(trimStartCharacters(`${"/".repeat(100_000)}root`, "/")).toBe("root");
		expect(trimEndWhitespace(`root${"\t".repeat(100_000)}`)).toBe("root");
	});

	it("does not split an unmatched Unicode code point", () => {
		const allowed = String.fromCodePoint(0x1f600);
		const sameLowSurrogate = String.fromCodePoint(0x1f200);
		expect(trimEndCharacters(`root${sameLowSurrogate}`, allowed)).toBe(
			`root${sameLowSurrogate}`,
		);
		expect(trimStartCharacters(`${sameLowSurrogate}root`, allowed)).toBe(
			`${sameLowSurrogate}root`,
		);
	});
});
