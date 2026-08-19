/**
 * `chunkDiscordText` must never split a surrogate pair (emoji) across two
 * chunks. A run of multi-byte characters with no whitespace break point (or
 * inside a fenced code block, where whitespace is preserved verbatim) falls
 * through to a raw character-index cut; that cut must back off by one unit
 * rather than bisect a pair, in both the no-whitespace fallback path and the
 * fence-preserving path.
 */
import { ElizaError, toWellFormedUnicode } from "@elizaos/core";
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

	// maxChars: 1 is too small to fit a surrogate pair without splitting it
	// (truncateWellFormed(remaining, 1) on emoji-leading text returns "").
	// Before the round-1 fix that made zero progress per loop iteration --
	// `out` grew unbounded until V8 threw `RangeError: Invalid array length`
	// a few seconds in. A transport limit is a hard cap, not advisory: a
	// bound too small for even one well-formed unit must fail closed with a
	// typed error instead of silently widening past it (matching the
	// fail-closed contract already merged for plugin-slack). These are
	// load-bearing: reverting the fix makes both tests below fail (the
	// call either hangs/crashes or returns an over-limit chunk instead of
	// throwing).
	it("fails closed at maxChars: 1 with emoji-leading content (no-whitespace path)", () => {
		const text = "\u{1F600}".repeat(5);

		try {
			chunkDiscordText(text, { maxChars: 1, maxLines: 999 });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ElizaError);
			expect((err as ElizaError).code).toBe("DISCORD_CHUNK_LIMIT_TOO_SMALL");
		}
	}, 5_000);

	// At maxChars: 1 the fence delimiter itself (```, 3 ASCII chars) can't fit
	// the reservation either -- this must fail closed at the fence-close
	// reservation, before ever attempting to split the emoji body.
	it("fails closed at maxChars: 1 on a fenced/preserve-whitespace payload", () => {
		const body = "\u{1F600}".repeat(5);
		const text = `\`\`\`\n${body}\n\`\`\``;

		try {
			chunkDiscordText(text, { maxChars: 1, maxLines: 999 });
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ElizaError);
			expect((err as ElizaError).code).toBe("DISCORD_CHUNK_LIMIT_TOO_SMALL");
		}
	}, 5_000);

	it("rejects a non-positive-integer maxChars instead of silently coercing it", () => {
		for (const invalid of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
			try {
				chunkDiscordText("hello world", { maxChars: invalid });
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(ElizaError);
				expect((err as ElizaError).code).toBe("DISCORD_CHUNK_LIMIT_INVALID");
			}
		}
	});

	// Two related overrun bugs, both load-bearing here: (1) the fence
	// reservation used to silently drop back to the full (unreserved)
	// maxChars whenever the closing marker's width made the reserved budget
	// go non-positive; (2) when a segment got flushed mid-fence, `current`
	// was reset to the fence's re-opening line and then the segment was
	// appended unconditionally, without accounting for that re-opening
	// prefix's own width, so a segment sized right up to the (already
	// reserved) budget still overran once the prefix was added. At a
	// small-but-sane bound (large enough for the marker to actually fit)
	// every chunk -- including ones that close and reopen the fence across a
	// split -- must stay within the requested maxChars.
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

	// When a mid-fence flush reopens `current` with the fence's own opening
	// line (e.g. "```" or "```js"), the very next appended segment is NOT a
	// continuation of that opening line -- it must start on its own line.
	// Before the fix, the append loop used a stale delimiter computed before
	// the flush, gluing content directly onto the opener (e.g. "```😀"
	// instead of "```\n😀"), which Discord parses as fence info/language
	// metadata rather than code content. Covers backtick and tilde fences,
	// plain and language-tagged and indented openers.
	function assertNoContentGluedOntoFenceOpener(
		chunks: string[],
		openLine: string,
	) {
		for (const chunk of chunks) {
			if (!chunk.startsWith(openLine)) {
				continue;
			}
			const rest = chunk.slice(openLine.length);
			if (rest.length > 0) {
				expect(rest.startsWith("\n")).toBe(true);
			}
		}
	}

	it("separates a reopened fence opener from its content with a newline (backtick)", () => {
		const maxChars = 10;
		const body = `x${"\u{1F600}".repeat(30)}`;
		const text = `\`\`\`\n${body}\n\`\`\``;
		const chunks = chunkDiscordText(text, { maxChars, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		assertNoContentGluedOntoFenceOpener(chunks, "```");
	});

	it("separates a reopened fence opener from its content with a newline (tilde)", () => {
		const maxChars = 10;
		const body = `x${"\u{1F600}".repeat(30)}`;
		const text = `~~~\n${body}\n~~~`;
		const chunks = chunkDiscordText(text, { maxChars, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		assertNoContentGluedOntoFenceOpener(chunks, "~~~");
	});

	it("separates a reopened fence opener from its content with a newline (language tag)", () => {
		const maxChars = 12;
		const body = `x${"\u{1F600}".repeat(30)}`;
		const text = `\`\`\`js\n${body}\n\`\`\``;
		const chunks = chunkDiscordText(text, { maxChars, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		assertNoContentGluedOntoFenceOpener(chunks, "```js");
	});

	it("separates a reopened fence opener from its content with a newline (indented)", () => {
		const maxChars = 20;
		const body = `x${"\u{1F600}".repeat(30)}`;
		const text = `   \`\`\`\n${body}\n   \`\`\``;
		const chunks = chunkDiscordText(text, { maxChars, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		assertNoContentGluedOntoFenceOpener(chunks, "   ```");
	});

	// Balanced, parseable fences and exact content preservation: every open
	// marker line must be matched by a close marker line, and stripping all
	// marker lines from every chunk (in order) must reproduce the original
	// body exactly -- no characters lost, duplicated, or merged into a
	// marker line during a close/reopen split.
	it("keeps fences balanced and preserves body content exactly across a close/reopen split", () => {
		const maxChars = 10;
		const body = `x${"\u{1F600}".repeat(30)}`;
		const text = `\`\`\`\n${body}\n\`\`\``;
		const chunks = chunkDiscordText(text, { maxChars, maxLines: 999 });

		expect(chunks.length).toBeGreaterThan(1);
		const isMarkerLine = (line: string) => /^ {0,3}`{3,}$/.test(line);
		let bodyOnly = "";
		for (const chunk of chunks) {
			const lines = chunk.split("\n");
			expect(lines.filter(isMarkerLine).length % 2).toBe(0);
			for (const line of lines) {
				if (!isMarkerLine(line)) {
					bodyOnly += line;
				}
			}
		}
		expect(bodyOnly).toBe(body);
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
