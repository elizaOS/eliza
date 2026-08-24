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

	it("prioritizes longer language prefixes when language definitions overlap", () => {
		expect(
			unwrapWholeCodeFence('```json5\n{"ok": true}\n```', ["json", "json5"]),
		).toBe('{"ok": true}');
		expect(
			unwrapWholeCodeFence('```json5\n{"ok": true}\n```', ["json5", "json"]),
		).toBe('{"ok": true}');
	});

	it("matches language tags case-insensitively", () => {
		expect(unwrapWholeCodeFence('```JSON\n{"ok": true}\n```', ["json"])).toBe(
			'{"ok": true}',
		);
		expect(
			unwrapWholeCodeFence("```JavaScript\nconst a = 1;\n```", ["javascript"]),
		).toBe("const a = 1;");
	});

	it("handles empty fences and whitespace-only bodies", () => {
		expect(unwrapWholeCodeFence("``````", ["json"])).toBe("");
		expect(unwrapWholeCodeFence("```json```", ["json"])).toBe("");
		expect(unwrapWholeCodeFence("```json\n   \t  \n```", ["json"])).toBe("");
	});

	it("preserves internal backticks in content", () => {
		expect(
			unwrapWholeCodeFence("```markdown\nUse `const x = 1;` here.\n```", [
				"markdown",
			]),
		).toBe("Use `const x = 1;` here.");
	});

	it("rejects strings shorter than 6 characters or missing fence boundaries", () => {
		expect(unwrapWholeCodeFence("```", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("`````", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence('not-fenced\n{"ok":true}\n```', ["json"])).toBeNull();
		expect(unwrapWholeCodeFence('```json\n{"ok":true}\nmissing-end', ["json"])).toBeNull();
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
		expect(unwrapWholeCodeFence("```true```", [])).toBe("true");
		expect(unwrapWholeCodeFence("```json\ntrue\n```", [])).toBeNull();
	});

	it("scans a 100k-character body without backtracking", () => {
		const body = "\t".repeat(100_000);
		expect(unwrapWholeCodeFence(`\`\`\`json\n${body}x\n\`\`\``, ["json"])).toBe(
			"x",
		);
	});
});
