import { describe, expect, it } from "vitest";
import { compressPromptDescription } from "../utils/prompt-compression";

describe("compressPromptDescription", () => {
	it("collapses whitespace", () => {
		expect(compressPromptDescription("  a   b\nc\t")).toBe("a b c");
	});

	it("returns empty for missing or blank", () => {
		expect(compressPromptDescription(undefined)).toBe("");
		expect(compressPromptDescription("   ")).toBe("");
	});

	it("truncates past 160 chars with ellipsis", () => {
		const long = "word ".repeat(50);
		const out = compressPromptDescription(long);
		expect(out.length).toBe(160);
		expect(out.endsWith("...")).toBe(true);
	});
});
