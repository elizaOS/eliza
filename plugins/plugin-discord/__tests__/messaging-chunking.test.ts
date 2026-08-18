/**
 * `chunkDiscordText` must never split a surrogate pair (emoji) across two
 * chunks. A run of multi-byte characters with no whitespace break point (or
 * inside a fenced code block, where whitespace is preserved verbatim) falls
 * through to a raw character-index cut; that cut must back off by one unit
 * rather than bisect a pair, in both the no-whitespace fallback path and the
 * fence-preserving path.
 */
import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { chunkDiscordText } from "../messaging.ts";

// toWellFormedUnicode only rewrites lone surrogates, so an unmodified
// round-trip is a real (and portable -- it has its own manual-scan fallback
// for runtimes without native String.prototype.isWellFormed) well-formedness
// check, unlike a helper that silently returns `true` when the native method
// is absent.
function isWellFormedString(text: string): boolean {
	return toWellFormedUnicode(text) === text;
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

	// maxChars: 1 forces splitLongLine's internal limit to 1 code unit -- too
	// small to fit a surrogate pair without splitting it. Before the fix,
	// truncateWellFormed(remaining, 1) on emoji-leading text returned "" and
	// both branches below made zero progress per iteration; `out` grows
	// unbounded until V8 throws `RangeError: Invalid array length` a few
	// seconds in (verified: reverting the source fix makes both tests below
	// fail with that RangeError, not a hang). These are load-bearing.
	it("terminates and stays well formed at maxChars: 1 (no-whitespace path)", () => {
		const text = "\u{1F600}".repeat(5);
		const chunks = chunkDiscordText(text, { maxChars: 1, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(isWellFormedString(chunk)).toBe(true);
		}
		expect(chunks.join("")).toBe(text);
	}, 5_000);

	it("terminates and stays well formed at maxChars: 1 (fenced/preserve-whitespace path)", () => {
		const body = "\u{1F600}".repeat(5);
		const text = `\`\`\`\n${body}\n\`\`\``;
		const chunks = chunkDiscordText(text, { maxChars: 1, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(isWellFormedString(chunk)).toBe(true);
		}
	}, 5_000);
});
