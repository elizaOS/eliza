/** Removes an optional whole-value Markdown code fence with a linear delimiter scan. */

import { describe, expect, it } from "vitest";
import { unwrapWholeCodeFence } from "./code-fence";

describe("unwrapWholeCodeFence", () => {
	it("returns null for input without fences", () => {
		expect(unwrapWholeCodeFence("plain text", ["ts"])).toBeNull();
	});

	it("returns null for input with only opening fence", () => {
		expect(unwrapWholeCodeFence("```ts\ncode", ["ts"])).toBeNull();
	});

	it("returns null for input with only closing fence", () => {
		expect(unwrapWholeCodeFence("code\n```", ["ts"])).toBeNull();
	});

	it("unwraps unlabeled fence", () => {
		expect(unwrapWholeCodeFence("```true```", ["ts"])).toBe("true");
		expect(unwrapWholeCodeFence("```name: value```", ["ts"])).toBe(
			"name: value",
		);
	});

	it("unwraps labeled fence with supported language", () => {
		expect(unwrapWholeCodeFence("```ts\ncode\n```", ["ts"])).toBe("code");
		expect(
			unwrapWholeCodeFence("```typescript\ncode\n```", ["typescript"]),
		).toBe("code");
		expect(
			unwrapWholeCodeFence("```python\nprint('hi')\n```", ["python"]),
		).toBe("print('hi')");
	});

	it("returns null for unsupported language label", () => {
		expect(unwrapWholeCodeFence("```ruby\ncode\n```", ["ts"])).toBeNull();
	});

	it("handles multiple languages", () => {
		expect(unwrapWholeCodeFence("```python\ncode\n```", ["ts", "python"])).toBe(
			"code",
		);
		expect(unwrapWholeCodeFence("```ts\ncode\n```", ["python", "ts"])).toBe(
			"code",
		);
	});

	it("is case-insensitive for language matching", () => {
		expect(unwrapWholeCodeFence("```TS\ncode\n```", ["ts"])).toBe("code");
		expect(
			unwrapWholeCodeFence("```TypeScript\ncode\n```", ["typescript"]),
		).toBe("code");
	});

	it("handles whitespace around content", () => {
		expect(unwrapWholeCodeFence("```ts\n  code  \n```", ["ts"])).toBe("code");
	});

	it("handles empty content", () => {
		expect(unwrapWholeCodeFence("``````", ["ts"])).toBe("");
		expect(unwrapWholeCodeFence("```ts\n```", ["ts"])).toBe("");
	});

	it("handles too-short input", () => {
		expect(unwrapWholeCodeFence("````", ["ts"])).toBeNull();
		expect(unwrapWholeCodeFence("```", ["ts"])).toBeNull();
	});

	it("handles empty languages array", () => {
		expect(unwrapWholeCodeFence("```true```", [])).toBe("true");
		expect(unwrapWholeCodeFence("```ts\ncode\n```", [])).toBeNull();
	});

	it("handles language with special characters", () => {
		expect(unwrapWholeCodeFence("```c++\ncode\n```", ["c++"])).toBe("code");
	});

	it("handles compact unlabeled content", () => {
		expect(unwrapWholeCodeFence("``````", ["ts"])).toBe("");
		expect(unwrapWholeCodeFence("```a```", ["ts"])).toBe("a");
	});
});
