import { describe, expect, it } from "vitest";
import { chunkMarkdownText, chunkText } from "../src/markdown/chunk.ts";

const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
const flagUs = "\u{1F1FA}\u{1F1F8}";
// Tag characters as escapes: a pasted England flag can lose its tag
// characters to private-use lookalikes and stop being one cluster.
const flagEngland =
	"\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
const handMediumSkinTone = "\u{1F44B}\u{1F3FD}";
const eAcute = "e\u0301";

function graphemeBoundaries(text: string): Set<number> {
	const boundaries = new Set<number>([0]);
	let at = 0;
	for (const { segment } of new Intl.Segmenter("en", {
		granularity: "grapheme",
	}).segment(text)) {
		at += segment.length;
		boundaries.add(at);
	}
	return boundaries;
}

/** Every chunk boundary of a plain-text split must be a grapheme boundary. */
function expectGraphemeSafeChunks(text: string, chunks: string[]): void {
	const boundaries = graphemeBoundaries(text);
	expect(chunks.join("")).toBe(text);
	let at = 0;
	for (const chunk of chunks.slice(0, -1)) {
		at += chunk.length;
		expect(boundaries.has(at)).toBe(true);
	}
}

describe("chunkText keeps an oversized cluster at the start whole", () => {
	it("does not split a ZWJ family emoji shorter than the limit", () => {
		const chunks = chunkText(`${family}${"x".repeat(50)}`, 5);
		expect(chunks[0]).toBe(family);
		expectGraphemeSafeChunks(`${family}${"x".repeat(50)}`, chunks);
	});

	it("does not split a regional-indicator flag shorter than the limit", () => {
		const chunks = chunkText(`${flagUs}${"y".repeat(20)}`, 3);
		expect(chunks[0]).toBe(flagUs);
		expectGraphemeSafeChunks(`${flagUs}${"y".repeat(20)}`, chunks);
	});

	it("does not split a subdivision flag shorter than the limit", () => {
		const chunks = chunkText(`${flagEngland}${"z".repeat(20)}`, 10);
		expect(chunks[0]).toBe(flagEngland);
		expectGraphemeSafeChunks(`${flagEngland}${"z".repeat(20)}`, chunks);
	});

	it("does not split a skin-tone modifier shorter than the limit", () => {
		const chunks = chunkText(`${handMediumSkinTone}${"w".repeat(20)}`, 3);
		expect(chunks[0]).toBe(handMediumSkinTone);
		expectGraphemeSafeChunks(`${handMediumSkinTone}${"w".repeat(20)}`, chunks);
	});

	it("does not split a combining mark shorter than the limit", () => {
		const chunks = chunkText(`${eAcute}${"v".repeat(20)}`, 1);
		expect(chunks[0]).toBe(eAcute);
		expectGraphemeSafeChunks(`${eAcute}${"v".repeat(20)}`, chunks);
	});
});

describe("chunkMarkdownText keeps an oversized cluster at the start whole", () => {
	it("does not split a ZWJ family emoji shorter than the limit", () => {
		const text = `${family}${"x".repeat(50)}`;
		const chunks = chunkMarkdownText(text, 5);
		expect(chunks[0]).toBe(family);
		expectGraphemeSafeChunks(text, chunks);
	});
});
