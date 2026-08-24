/** Exercises whole-value code-fence parsing, including adversarial whitespace bodies. */

import { describe, expect, it } from "vitest";
import { unwrapWholeCodeFence } from "./code-fence.ts";

describe("unwrapWholeCodeFence", () => {
	it("unwraps accepted languages and rejects other wrappers", () => {
		expect(unwrapWholeCodeFence('```json\n{"ok":true}\n```', ["json"])).toBe(
			'{"ok":true}',
		);
		expect(unwrapWholeCodeFence("```ts\n{}\n```", ["json"])).toBeNull();
	});

	it("keeps compact unlabeled bodies distinct from language labels", () => {
		expect(unwrapWholeCodeFence("```true```", ["json"])).toBe("true");
		expect(unwrapWholeCodeFence("```jsontrue```", ["json"])).toBe("true");
		expect(unwrapWholeCodeFence("```name: eliza```", ["toon"])).toBe(
			"name: eliza",
		);
		expect(
			unwrapWholeCodeFence("```typescript\ntrue\n```", ["json"]),
		).toBeNull();
	});

	it("scans a 100k-character body without backtracking", () => {
		const body = "\t".repeat(100_000);
		expect(unwrapWholeCodeFence(`\`\`\`json\n${body}x\n\`\`\``, ["json"])).toBe(
			"x",
		);
	});

	it("returns null for non-string inputs without throwing", () => {
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence(null, ["json"])).toBeNull();
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence(undefined, ["json"])).toBeNull();
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence(123, ["json"])).toBeNull();
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence({}, ["json"])).toBeNull();
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence([], ["json"])).toBeNull();
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence("```json\nx\n```", null)).toBeNull();
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence("```json\nx\n```", undefined)).toBeNull();
		// @ts-expect-error runtime guard check
		expect(unwrapWholeCodeFence("```json\nx\n```", "json" as unknown as string[])).toBeNull();
		expect(unwrapWholeCodeFence("", ["json"])).toBeNull();
	});
});
