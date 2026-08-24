/**
 * Unit tests for code fence unwrapping and delimiter parsing.
 * Validates markdown fence stripping, language tag matching, and whitespace trimming.
 */
import { describe, expect, it } from "vitest";
import { unwrapWholeCodeFence } from "../code-fence.ts";

describe("code-fence", () => {
	describe("unwrapWholeCodeFence", () => {
		it("unwraps standard language-tagged fences", () => {
			expect(unwrapWholeCodeFence('```json\n{"a": 1}\n```', ["json"])).toBe(
				'{"a": 1}',
			);
			expect(unwrapWholeCodeFence('```JSON\n{"a": 1}\n```', ["json"])).toBe(
				'{"a": 1}',
			);
		});

		it("unwraps fences with multiple acceptable languages matching longest first", () => {
			expect(
				unwrapWholeCodeFence("```javascript\nconsole.log(1);\n```", [
					"js",
					"javascript",
				]),
			).toBe("console.log(1);");
		});

		it("unwraps unlabeled compact content", () => {
			expect(unwrapWholeCodeFence("```true```", ["json"])).toBe("true");
			expect(unwrapWholeCodeFence("```name: value```", ["yaml"])).toBe(
				"name: value",
			);
		});

		it("returns null for non-matching or explicit unsupported language tags", () => {
			expect(
				unwrapWholeCodeFence("```python\nprint(1)\n```", ["json", "yaml"]),
			).toBeNull();
		});

		it("returns null for malformed or incomplete fences", () => {
			expect(unwrapWholeCodeFence("", ["json"])).toBeNull();
			expect(unwrapWholeCodeFence("```json", ["json"])).toBeNull();
			expect(unwrapWholeCodeFence("json```", ["json"])).toBeNull();
			expect(unwrapWholeCodeFence("not a fence", ["json"])).toBeNull();
			expect(unwrapWholeCodeFence("`````", ["json"])).toBeNull(); // length < 6
		});
	});
});
