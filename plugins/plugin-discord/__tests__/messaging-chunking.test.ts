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
import { chunkDiscordText, MIN_CHUNK_CHARS } from "../messaging.ts";

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
	//
	// maxChars: 1 is below MIN_CHUNK_CHARS, so chunkDiscordText raises it to
	// MIN_CHUNK_CHARS (2) -- the load-bearing chunk.length assertion checks
	// against that *effective* bound, not the literal requested value, since
	// no cut below it can stay well-formed (see ChunkDiscordTextOpts.maxChars).
	it("terminates, stays well formed, and honors the effective bound at maxChars: 1 (no-whitespace path)", () => {
		const text = "\u{1F600}".repeat(5);
		const chunks = chunkDiscordText(text, { maxChars: 1, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(isWellFormedString(chunk)).toBe(true);
			expect(chunk.length).toBeLessThanOrEqual(MIN_CHUNK_CHARS);
		}
		expect(chunks.join("")).toBe(text);
	}, 5_000);

	// At maxChars: 1 the fence delimiter itself (```, 3 ASCII chars) no longer
	// fits the budget, so splitLongLine shreds it across chunks like any other
	// line -- a real but pre-existing, orthogonal characteristic of degenerate
	// tiny bounds that has nothing to do with surrogate pairs, and no chunk
	// length bound is provable here. Only what this PR guarantees is checked:
	// termination and surrogate-pair well-formedness. The realistic
	// wrapper-accounting case (fence marker comfortably fits the budget) is
	// covered separately below.
	it("terminates and stays well formed at maxChars: 1 (fenced/preserve-whitespace path)", () => {
		const body = "\u{1F600}".repeat(5);
		const text = `\`\`\`\n${body}\n\`\`\``;
		const chunks = chunkDiscordText(text, { maxChars: 1, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(isWellFormedString(chunk)).toBe(true);
		}
	}, 5_000);

	// The fence-reservation fallback used to silently drop back to the full
	// (unreserved) maxChars whenever the closing marker's width made the
	// reserved budget go non-positive, letting a chunk overrun by the fence's
	// entire width. At a small-but-sane bound (large enough for the marker to
	// actually fit) every chunk -- including the ones that close and reopen
	// the fence across a split -- must stay within the requested maxChars.
	it("keeps every chunk within maxChars when closing/reopening a fence at a small bound", () => {
		const maxChars = 10;
		const body = `x${"\u{1F600}".repeat(30)}`;
		const text = `\`\`\`\n${body}\n\`\`\``;
		const chunks = chunkDiscordText(text, { maxChars, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(isWellFormedString(chunk)).toBe(true);
			expect(chunk.length).toBeLessThanOrEqual(maxChars);
		}
	});

	// The reasoning-italics path reserves 2 chars off maxChars specifically so
	// a re-opening/closing "_" can be added back to each chunk without
	// exceeding the requested bound -- verify that budget actually holds at
	// the realistic default, not just that chunking terminates.
	it("keeps every chunk within maxChars when rebalancing reasoning italics", () => {
		const maxChars = 40;
		const body = `Reasoning:\n_${"word ".repeat(30).trim()}_`;
		const chunks = chunkDiscordText(body, { maxChars, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxChars);
		}
	});
});
