/**
 * A fence label must match an accepted language as a whole word: a longer
 * label that only shares the prefix (json5, jsonc, javascript) must not
 * unwrap, and the label's trailing characters must never leak into the
 * returned body.
 */
import { describe, expect, it } from "vitest";

import { unwrapWholeCodeFence } from "../src/markdown/code";

describe("unwrapWholeCodeFence label boundary", () => {
	it("does not unwrap a longer label that shares an accepted prefix", () => {
		expect(unwrapWholeCodeFence('```json5\n{"a":1}\n```', ["json"])).toBeNull();
		expect(unwrapWholeCodeFence('```jsonc\n{"a":1}\n```', ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("```javascript\ncode\n```", ["java"])).toBeNull();
		expect(unwrapWholeCodeFence("```tsx\ncode\n```", ["ts"])).toBeNull();
		expect(unwrapWholeCodeFence('```JSON5\n{"a":1}\n```', ["json"])).toBeNull();
	});

	it("keeps a compact longer label as content instead of its tail", () => {
		expect(unwrapWholeCodeFence("```json5```", ["json"])).toBe("json5");
	});

	it("still unwraps exact labels, unlabeled fences, and compact content", () => {
		expect(unwrapWholeCodeFence('```json\n{"a":1}\n```', ["json"])).toBe(
			'{"a":1}',
		);
		expect(unwrapWholeCodeFence('```json5\n{"a":1}\n```', ["json", "json5"])).toBe(
			'{"a":1}',
		);
		expect(unwrapWholeCodeFence("```\n{a:1}\n```", ["json"])).toBe("{a:1}");
		expect(unwrapWholeCodeFence("```true```", ["json"])).toBe("true");
		expect(unwrapWholeCodeFence("```typescript\ncode\n```", ["ts"])).toBeNull();
		expect(unwrapWholeCodeFence('```json \n{"a":1}\n```', ["json"])).toBe(
			'{"a":1}',
		);
	});
});
