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
});
