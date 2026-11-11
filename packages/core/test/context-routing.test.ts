/** shouldIncludeByContext lowercased contexts but never trimmed them, so a
 * context with surrounding whitespace (as produced by splitting a joined
 * state value) never matched and the component was wrongly hidden. */
import { describe, expect, it } from "vitest";
import { shouldIncludeByContext } from "../src/utils/context-routing";

describe("shouldIncludeByContext", () => {
	it("matches an active context with surrounding whitespace", () => {
		expect(shouldIncludeByContext(["wallet"], [" wallet "])).toBe(true);
	});

	it("matches a declared context with surrounding whitespace", () => {
		expect(shouldIncludeByContext([" wallet "], ["wallet"])).toBe(true);
	});

	it("still matches exact and case-insensitive contexts", () => {
		expect(shouldIncludeByContext(["wallet"], ["wallet"])).toBe(true);
		expect(shouldIncludeByContext(["wallet"], ["WALLET"])).toBe(true);
	});

	it("still excludes non-overlapping contexts", () => {
		expect(shouldIncludeByContext(["wallet"], ["code"])).toBe(false);
		expect(shouldIncludeByContext(["wallet"], [" wallet  ", "code"])).toBe(
			true,
		);
	});

	it("stays permissive for empty declared or active sets", () => {
		expect(shouldIncludeByContext([], ["wallet"])).toBe(true);
		expect(shouldIncludeByContext(undefined, ["wallet"])).toBe(true);
		expect(shouldIncludeByContext(["wallet"], [])).toBe(true);
		expect(shouldIncludeByContext(["wallet"], undefined)).toBe(true);
	});
});
