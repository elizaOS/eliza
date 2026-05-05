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
		expect(out.length).toBeLessThanOrEqual(160);
		expect(out.endsWith("...")).toBe(true);
	});

	it("compresses prose in a deterministic caveman style", () => {
		expect(
			compressPromptDescription(
				"This action is used to send a direct message to the user when the conversation needs a response.",
			),
		).toBe("send direct msg to user when the convo needs a reply.");
	});

	it("preserves code, urls, paths, and dates", () => {
		const out = compressPromptDescription(
			"Run `bun test` for https://example.com/a?b=1 and /tmp/eliza/file.ts on 2026-05-05.",
		);

		expect(out).toContain("`bun test`");
		expect(out).toContain("https://example.com/a?b=1");
		expect(out).toContain("/tmp/eliza/file.ts");
		expect(out).toContain("2026-05-05");
	});
});
