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

	it("scans a 100k-character body without backtracking", () => {
		const body = "\t".repeat(100_000);
		expect(unwrapWholeCodeFence(`\`\`\`json\n${body}x\n\`\`\``, ["json"])).toBe(
			"x",
		);
	});
});
