/**
 * `chunkDiscordText` must never split a surrogate pair (emoji) across two
 * chunks. A run of multi-byte characters with no whitespace break point (or
 * inside a fenced code block, where whitespace is preserved verbatim) falls
 * through to a raw character-index cut; that cut must back off by one unit
 * rather than bisect a pair, in both the no-whitespace fallback path and the
 * fence-preserving path.
 */
import { describe, expect, it } from "vitest";
import { chunkDiscordText } from "../messaging.ts";

function isWellFormedString(text: string): boolean {
	return typeof (text as unknown as { isWellFormed?: () => boolean })
		.isWellFormed === "function"
		? (text as unknown as { isWellFormed: () => boolean }).isWellFormed()
		: true;
}

describe("chunkDiscordText surrogate-pair safety", () => {
	it("never tears an emoji across chunks when no whitespace break exists", () => {
		// Odd-length prefix shifts parity so the 2000-char boundary lands mid-pair
		// (verified: unpatched code emits a chunk ending in a lone high surrogate
		// and the next chunk starting with the orphaned low surrogate).
		const text = `x${"\u{1F600}".repeat(1200)}`;
		const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(isWellFormedString(chunk)).toBe(true);
		}
		// No characters lost or duplicated across the split.
		expect(chunks.join("")).toBe(text);
	});

	it("never tears an emoji across chunks inside a fenced code block", () => {
		const body = `x${"\u{1F600}".repeat(1200)}`;
		const text = `\`\`\`\n${body}\n\`\`\``;
		const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(isWellFormedString(chunk)).toBe(true);
		}
	});

	it("still breaks at whitespace when one is available near the limit", () => {
		const text = `${"a".repeat(1990)} ${"b".repeat(50)}`;
		const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 999 });
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("")).toBe(text);
	});
});
