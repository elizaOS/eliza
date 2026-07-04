/**
 * Covers the markdown fence parser (`parseFenceSpans` / `findFenceSpanAt` /
 * `isSafeFenceBreak`): backtick vs tilde markers, unclosed and info-string
 * fences, indentation limits, and safe-break detection — deterministic cases
 * plus a fast-check fuzz asserting ordered, in-bounds spans.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "./fences";

describe("markdown fence parsing", () => {
	it("matches backtick and tilde fences independently", () => {
		const markdown = [
			"intro",
			"```ts",
			"const value = '~~~ not a closing fence';",
			"```",
			"middle",
			"~~~",
			"``` not a closing fence",
			"~~~",
			"outro",
		].join("\n");

		const spans = parseFenceSpans(markdown);

		expect(spans).toHaveLength(2);
		expect(spans[0]).toMatchObject({ marker: "```", openLine: "```ts" });
		expect(spans[1]).toMatchObject({ marker: "~~~", openLine: "~~~" });
	});

	it("treats an unclosed fence as spanning to the end of the buffer", () => {
		const markdown = 'before\n```json\n{"ok": true}\n';
		const spans = parseFenceSpans(markdown);

		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({
			start: "before\n".length,
			end: markdown.length,
			marker: "```",
		});
	});

	it("does not close an open fence on a marker line carrying an info string", () => {
		// CommonMark: a closing code fence may be followed only by spaces/tabs.
		// A line like "```js" inside an open ``` block is content, not a closer —
		// treating it as one would let chunkers split inside the code block.
		const markdown = "```\nexample:\n```js\ninner code\n```\nafter\n";
		const spans = parseFenceSpans(markdown);

		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({
			start: 0,
			end: markdown.indexOf("\nafter"),
		});
		expect(isSafeFenceBreak(spans, markdown.indexOf("inner code"))).toBe(false);

		// Trailing spaces/tabs after the closing marker still close.
		expect(parseFenceSpans("```\ncode\n```  \nafter")).toHaveLength(1);
		expect(parseFenceSpans("```\ncode\n```\t\nafter")).toHaveLength(1);
	});

	it("does not treat fences indented more than three spaces as fenced blocks", () => {
		expect(parseFenceSpans("    ```\ncode\n    ```")).toEqual([]);
		expect(parseFenceSpans("   ```\ncode\n   ```")).toHaveLength(1);
	});

	it("marks positions inside fences as unsafe breakpoints", () => {
		const markdown = "before\n```ts\nconst x = 1;\n```\nafter";
		const spans = parseFenceSpans(markdown);
		const insideCode = markdown.indexOf("const x");
		const outside = markdown.indexOf("after");

		expect(findFenceSpanAt(spans, insideCode)).toBeDefined();
		expect(isSafeFenceBreak(spans, insideCode)).toBe(false);
		expect(isSafeFenceBreak(spans, outside)).toBe(true);
	});

	it("fuzzes arbitrary markdown as producing ordered, bounded spans", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 2_000 }), (markdown) => {
				const spans = parseFenceSpans(markdown);
				let previousEnd = -1;

				for (const span of spans) {
					expect(span.start).toBeGreaterThanOrEqual(0);
					expect(span.end).toBeGreaterThanOrEqual(span.start);
					expect(span.end).toBeLessThanOrEqual(markdown.length);
					expect(span.start).toBeGreaterThan(previousEnd);
					expect(["`", "~"]).toContain(span.marker[0]);
					expect(span.marker.length).toBeGreaterThanOrEqual(3);
					previousEnd = span.end;
				}
			}),
			{ numRuns: 500 },
		);
	});
});
