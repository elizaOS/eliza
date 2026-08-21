/**
 * `chunkMarkdownText` feeds connectors with HARD length caps (Discord 2000,
 * SMS 160, …): a single chunk over `limit` gets the whole message rejected by
 * the platform API. The tricky path is fence splitting — the injected close
 * line (\n + ``` marker) must not push a chunk past `limit` even when it does
 * not fit next to the forced minimum-progress break. The limit is a hard cap;
 * closing/reopening fences is best-effort within it.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chunkMarkdownText } from "./chunk.ts";

describe("chunkMarkdownText", () => {
	it("never exceeds the limit even when the fence close line cannot fit", () => {
		const text = "```\nAAAAAAAAAAAAAAAAAAAA\n```\n";
		const limit = 8;
		const chunks = chunkMarkdownText(text, limit);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(limit);
		}
		// No content is lost: the original code payload survives the split.
		expect(chunks.join("")).toContain("AAAA");
		expect(chunks.join("").replace(/[^A]/g, "")).toBe("A".repeat(20));
	});

	it("terminates when the fence reopen line is longer than the limit", () => {
		// The bail path must not re-arm the fence split, or each
		// iteration prepends the "```js" reopen line (6 chars with newline) while
		// consuming only `limit` (5) chars — `remaining` grows forever and the call
		// never returns, hard-hanging the caller.
		const chunks = chunkMarkdownText(`\`\`\`js\n${"b".repeat(50)}`, 5);

		expect(chunks.length).toBeGreaterThan(0);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(5);
		}
		expect(chunks.join("").replace(/[^b]/g, "")).toBe("b".repeat(50));
	});

	it("closes and reopens a split fence when the limit has room for it", () => {
		const body = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`);
		const text = `intro\n\n\`\`\`typescript\n${body.join("\n")}\n\`\`\`\n\ntail`;
		const chunks = chunkMarkdownText(text, 200);

		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(200);
		}
		// Every chunk that opens the fence also closes it (balanced markers).
		for (const chunk of chunks) {
			const fenceLines = chunk
				.split("\n")
				.filter((line) => line.startsWith("```"));
			expect(fenceLines.length % 2).toBe(0);
		}
		// Continuation chunks reopen with the original info string.
		const reopened = chunks.filter((c) => c.startsWith("```typescript\n"));
		expect(reopened.length).toBeGreaterThan(0);
	});

	it("property: every chunk fits the limit for arbitrary fenced markdown", () => {
		const piece = fc.constantFrom(
			"word ",
			"longerword ",
			"\n",
			"\n\n",
			"```\n",
			"```js\n",
			"~~~\n",
			"`x` ",
			"(paren ",
			") ",
			"a".repeat(30),
			"  ```\n",
		);
		fc.assert(
			fc.property(
				fc.array(piece, { minLength: 1, maxLength: 30 }),
				// min 8 keeps a regression failing fast on the length assertion; the
				// deterministic tests above pin the tiny-limit (< 8) behavior, where
				// the failure mode is not just overflow but non-termination.
				fc.integer({ min: 8, max: 120 }),
				(pieces, limit) => {
					for (const chunk of chunkMarkdownText(pieces.join(""), limit)) {
						expect(chunk.length).toBeLessThanOrEqual(limit);
					}
				},
			),
			{ numRuns: 2_000 },
		);
	});

	it("never splits a surrogate pair on a hard break", () => {
		const input = "😀".repeat(20); // 40 UTF-16 units, no break points
		const chunks = chunkMarkdownText(input, 7);
		for (const c of chunks) {
			expect(isWellFormed(c)).toBe(true);
		}
		expect(chunks.join("")).toBe(input);
	});

	it("keeps pairs whole at limit 2 (one astral scalar per chunk)", () => {
		const input = "😀".repeat(4);
		const chunks = chunkMarkdownText(input, 2);
		expect(chunks).toEqual(["😀", "😀", "😀", "😀"]);
	});

	it("emits one whole pair per chunk at limit 1 instead of lone surrogates", () => {
		// A 1-unit cap cannot represent any astral scalar; the contract is to
		// exceed the cap by one unit rather than bisect the pair.
		const input = "😀".repeat(3);
		const chunks = chunkMarkdownText(input, 1);
		expect(chunks).toEqual(["😀", "😀", "😀"]);
		for (const c of chunks) {
			expect(isWellFormed(c)).toBe(true);
		}
		expect(chunks.join("")).toBe(input);
	});

	it("passes pre-existing lone surrogates through untouched", () => {
		const input = "ab\ud83dcd\ude00ef";
		const chunks = chunkMarkdownText(input, 3);
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
