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

	it("rejects prefix-overmatched languages without a delimiter", () => {
		expect(unwrapWholeCodeFence("```jsonata\nhello\n```", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("```jsonATA\nhello\n```", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("```js\nhello\n```", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("```json\nhello\n```", ["json"])).toBe("hello");
		expect(
			unwrapWholeCodeFence("```jsonata\nhello\n```", ["json", "jsonata"]),
		).toBe("hello");
		expect(
			unwrapWholeCodeFence("```json\nhello\n```", ["json", "jsonata"]),
		).toBe("hello");
		expect(unwrapWholeCodeFence("```json \nhello\n```", ["json"])).toBe(
			"hello",
		);
	});
});
