import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.ts";

/**
 * `chunkText` splits an over-long message into delivery-sized chunks for
 * connectors with hard length limits (Discord 2000, SMS 160, …) (#8801). The
 * integrity property that matters: every chunk fits the limit AND no message
 * content is lost or corrupted across the split. A regression here
 * silently drops or mangles the user's outbound text, so these are pinned.
 */
describe("chunkText", () => {
	it("returns [] for empty and a single chunk within-limit / non-positive limit", () => {
		expect(chunkText("", 10)).toEqual([]);
		expect(chunkText("short", 10)).toEqual(["short"]);
		expect(chunkText("anything", 0)).toEqual(["anything"]);
		expect(chunkText("anything", -5)).toEqual(["anything"]);
	});

	it("splits long text into chunks each within the limit", () => {
		const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const chunks = chunkText(text, 30);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
	});

	it("preserves every word across the split (word-boundary breaks, no loss)", () => {
		const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
		const chunks = chunkText(words.join(" "), 25);
		expect(chunks.join(" ").split(/\s+/).filter(Boolean)).toEqual(words);
	});

	it("prefers a newline break inside the window", () => {
		const chunks = chunkText(`first line here\n${"x".repeat(40)}`, 30);
		expect(chunks[0]).toBe("first line here");
	});

	it("hard-breaks an over-long unbroken token at the limit, losing nothing", () => {
		expect(chunkText("a".repeat(25), 10)).toEqual([
			"aaaaaaaaaa",
			"aaaaaaaaaa",
			"aaaaa",
		]);
	});
});
