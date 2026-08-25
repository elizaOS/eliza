/**
 * `chunkText` splits an over-long message into delivery-sized chunks for
 * connectors with hard length limits (Discord 2000, SMS 160, …) (#8801). The
 * integrity property that matters: every chunk fits the limit AND no message
 * content is lost or corrupted across the split. A regression here
 * silently drops or mangles the user's outbound text, so these are pinned.
 */
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.ts";

describe("chunkText", () => {
	it("returns [] for empty and a single chunk within the limit", () => {
		expect(chunkText("", 10)).toEqual([]);
		expect(chunkText("short", 10)).toEqual(["short"]);
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

	it("never splits a surrogate pair on a hard break", () => {
		// An unbroken run of non-BMP characters (emoji) longer than the limit hits
		// the hard-break path. A UTF-16 slice at the limit would bisect a pair,
		// emitting lone surrogates that render as U+FFFD in each delivered chunk.
		const input = "😀".repeat(20); // 40 UTF-16 units, no break points
		const chunks = chunkText(input, 7);
		for (const c of chunks) {
			expect(isWellFormed(c)).toBe(true);
		}
		expect(chunks.join("")).toBe(input);
	});

	it("keeps pairs whole at limit 2 (one astral scalar per chunk)", () => {
		const input = "😀".repeat(4);
		const chunks = chunkText(input, 2);
		expect(chunks).toEqual(["😀", "😀", "😀", "😀"]);
	});

	it("emits one whole pair per chunk at limit 1 instead of lone surrogates", () => {
		// A 1-unit cap cannot represent any astral scalar; the contract is to
		// exceed the cap by one unit rather than bisect the pair.
		const input = "😀".repeat(3);
		const chunks = chunkText(input, 1);
		expect(chunks).toEqual(["😀", "😀", "😀"]);
		for (const c of chunks) {
			expect(isWellFormed(c)).toBe(true);
		}
		expect(chunks.join("")).toBe(input);
	});

	it("passes pre-existing lone surrogates through untouched", () => {
		const input = "ab\ud83dcd\ude00ef";
		const chunks = chunkText(input, 3);
		expect(chunks.join("")).toBe(input);
		for (const c of chunks) {
			expect(c.length).toBeLessThanOrEqual(3);
		}
	});
});

function isWellFormed(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}
