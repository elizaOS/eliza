/** A quoted reference must stay one quoted token: a `"` inside the reference
 * closes the quote early, and control characters (including ANSI escapes)
 * ride along verbatim into chat or logs. Neither is name-shaped, so the
 * caller-supplied fallback noun applies instead, as it already does for
 * multi-line or overlong references. */

import { describe, expect, it } from "vitest";
import { describeUserReference } from "../src/utils/reference-echo";

describe("describeUserReference unsafe characters", () => {
	it("falls back for a reference containing a double quote", () => {
		expect(describeUserReference('a"b', "target")).toBe("target");
		expect(describeUserReference('"quoted"', "target")).toBe("target");
	});

	it("falls back for a reference containing an ANSI escape", () => {
		expect(describeUserReference("[31mhello", "target")).toBe("target");
	});

	it("falls back for a reference containing other control characters", () => {
		expect(describeUserReference("ab", "target")).toBe("target");
		expect(describeUserReference("a\u0009b", "target")).toBe("target");
	});

	it("falls back for a reference containing a line or paragraph separator", () => {
		expect(describeUserReference("a\u2028b", "target")).toBe("target");
		expect(describeUserReference("a\u2029b", "target")).toBe("target");
	});

	it("still quotes a plain name, including one with an apostrophe", () => {
		expect(describeUserReference("hello", "target")).toBe('"hello"');
		expect(describeUserReference("o'brien", "target")).toBe('"o\'brien"');
	});

	it("still falls back for multi-line or overlong references", () => {
		expect(describeUserReference("a\nb", "target")).toBe("target");
		expect(describeUserReference("x".repeat(65), "target")).toBe("target");
	});
});
