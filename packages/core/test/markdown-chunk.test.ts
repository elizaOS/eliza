/**
 * A fence split must not eat the next line's leading whitespace. When the
 * splitter closes a fence at a newline break, it advanced the break past the
 * newline and then applied the generic "broke on a separator, skip one char"
 * step to the next line's first character. Inside a code fence that
 * character is indentation: a Python line lost one space, so a block that
 * started at four spaces came back mixed (three-space `y = 2` next to a
 * four-space `return x`) — an IndentationError in the code the user sees.
 */

import { describe, expect, it } from "vitest";
import { chunkMarkdownText } from "../src/markdown/chunk.js";

const PYTHON =
	"```python\ndef foo():\n    x = 1\n    y = 2\n    return x\n```";

describe("chunkMarkdownText fence splits keep indentation", () => {
	it("keeps four-space Python indentation across a fence split", () => {
		const chunks = chunkMarkdownText(PYTHON, 35);
		// With the indent kept, `return x` no longer fits in the same chunk,
		// so it moves to the next one — still at four spaces.
		expect(chunks[1]).toBe("```python\n    y = 2\n```");
		expect(chunks[2]).toBe("```python\n    return x\n```");
	});

	it("keeps four-space indentation at a tighter limit", () => {
		const chunks = chunkMarkdownText(PYTHON, 30);
		expect(chunks[1]).toBe("```python\n    x = 1\n```");
		expect(chunks[2]).toBe("```python\n    y = 2\n```");
		expect(chunks[3]).toBe("```python\n    return x\n```");
	});

	it("keeps the two-space indent of an indented fence", () => {
		const chunks = chunkMarkdownText(
			"  ```js\n  line1\n  line2\n  line3\n  ```",
			25,
		);
		expect(chunks[1]).toBe("  ```js\n  line2\n  ```");
		expect(chunks[2]).toBe("  ```js\n  line3\n  ```");
	});

	it("still respects the hard cap on every chunk", () => {
		for (const limit of [30, 35, 40, 45]) {
			for (const chunk of chunkMarkdownText(PYTHON, limit)) {
				expect(chunk.length).toBeLessThanOrEqual(limit);
			}
		}
	});
});
