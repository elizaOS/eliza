/** A chunk boundary must not land inside a grapheme cluster: a ZWJ emoji,
 * a flag, or a skin-tone modifier split across chunks renders as different
 * characters in each chunk. The finest grain of the splitter is a code
 * point, so a long unbroken run that reaches that grain cuts clusters. */

import { describe, expect, it } from "vitest";
import { RecursiveCharacterTextSplitter } from "../src/utils/recursive-character-text-splitter";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Every chunk end in the joined stream must sit on a grapheme boundary. */
function assertGraphemeBoundaries(text: string, chunks: string[]): void {
	const boundaries = new Set<number>();
	let pos = 0;
	for (const { segment } of segmenter.segment(text)) {
		pos += segment.length;
		boundaries.add(pos);
	}
	let offset = 0;
	for (const chunk of chunks) {
		offset += chunk.length;
		if (offset < text.length) {
			expect(
				boundaries.has(offset),
				`chunk ends inside a grapheme cluster at offset ${offset}: ${JSON.stringify(chunk)}`,
			).toBe(true);
		}
	}
}

describe("RecursiveCharacterTextSplitter grapheme clusters", () => {
	it("keeps a ZWJ family emoji, a flag, and a skin-tone emoji whole", async () => {
		const family = "👨‍👩‍👧‍👦";
		const flag = "🇰🇷";
		const skinTone = "👍🏽";
		const text = `a${family}b${flag}c${skinTone}d${"x".repeat(40)}`;
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 10,
			chunkOverlap: 2,
		});
		const chunks = await splitter.splitText(text);
		assertGraphemeBoundaries(text, chunks);
		// No chunk starts with a lone joiner or a lone regional indicator.
		for (const chunk of chunks) {
			expect(chunk.startsWith("\u200D")).toBe(false);
			expect(chunk.startsWith("🇰") && !chunk.startsWith(flag)).toBe(false);
			expect(chunk.startsWith("🇷")).toBe(false);
		}
		expect(chunks.join("")).toContain(family);
		expect(chunks.join("")).toContain(flag);
		expect(chunks.join("")).toContain(skinTone);
	});

	it("keeps a combining-mark cluster whole", async () => {
		// Nine x's fill the chunk, so a code-point split cuts the combining
		// mark off its base letter at the chunk edge.
		const text = `${"x".repeat(9)}e\u0301${"x".repeat(30)}`;
		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 10,
			chunkOverlap: 0,
		});
		const chunks = await splitter.splitText(text);
		assertGraphemeBoundaries(text, chunks);
		expect(chunks.join("")).toBe(text);
	});
});
