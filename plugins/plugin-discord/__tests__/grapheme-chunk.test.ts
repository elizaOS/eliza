import { describe, expect, it } from "vitest";
import { chunkDiscordText } from "../messaging";

const LIMIT = 40;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function graphemeBoundaries(text: string): Set<number> {
	const offsets = new Set<number>([0, text.length]);
	let offset = 0;
	for (const { segment } of segmenter.segment(text)) {
		offset += segment.length;
		offsets.add(offset);
	}
	return offsets;
}

const CLUSTERS: Array<[string, string]> = [
	["ZWJ family", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"],
	["flag", "\u{1F1F0}\u{1F1F7}"],
	["combining accent", "e\u0301"],
	["skin tone", "\u{1F44D}\u{1F3FD}"],
];

describe("chunkDiscordText grapheme-safe cut", () => {
	it.each(CLUSTERS)(
		"never splits a %s cluster across chunks at any placement",
		(_name, cluster) => {
			for (let pad = 0; pad <= 45; pad++) {
				const text = `${"a".repeat(pad)}${cluster}${"b".repeat(50)}`;
				const chunks = chunkDiscordText(text, { maxChars: LIMIT });
				expect(chunks.join("")).toBe(text);
				const boundaries = graphemeBoundaries(text);
				let offset = 0;
				for (const chunk of chunks.slice(0, -1)) {
					expect(chunk.length).toBeLessThanOrEqual(LIMIT);
					offset += chunk.length;
					expect(boundaries.has(offset)).toBe(true);
				}
			}
		},
	);

	it("cuts plain ASCII text at the limit unchanged", () => {
		const text = "x".repeat(LIMIT * 2 + 7);
		const parts = chunkDiscordText(text, { maxChars: LIMIT });
		expect(parts.map((part) => part.length)).toEqual([LIMIT, LIMIT, 7]);
		expect(parts.join("")).toBe(text);
	});

	it("falls back to the surrogate-safe cut for one over-long cluster", () => {
		const text = `e${"\u0301".repeat(LIMIT + 10)}`;
		const parts = chunkDiscordText(text, { maxChars: LIMIT });
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.join("")).toBe(text);
		for (const part of parts) {
			expect(part.length).toBeLessThanOrEqual(LIMIT);
			expect(part.isWellFormed()).toBe(true);
		}
	});
});
