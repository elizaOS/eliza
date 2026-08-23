import { describe, expect, it } from "vitest";
import {
	describeUserReference,
	userReferenceLogView,
} from "./reference-echo.ts";

describe("describeUserReference", () => {
	it("quotes short single-line references", () => {
		expect(describeUserReference("alice", "target")).toBe('"alice"');
		expect(describeUserReference("query about x", "target")).toBe(
			'"query about x"',
		);
	});

	it("falls back for empty, overlong, and multiline references", () => {
		expect(describeUserReference("", "target")).toBe("target");
		expect(describeUserReference("   ", "target")).toBe("target");
		expect(describeUserReference("a".repeat(65), "target")).toBe("target");
		expect(describeUserReference("line1\nline2", "target")).toBe("target");
	});

	it("trims before checking length", () => {
		expect(describeUserReference("  name  ", "target")).toBe('"name"');
	});

	it("uses default fallback for non-string input", () => {
		expect(describeUserReference(null as never, "target")).toBe("target");
		expect(describeUserReference(5 as never, null as never)).toBe("target");
	});
});

describe("userReferenceLogView", () => {
	it("collapses whitespace to one line", () => {
		expect(userReferenceLogView("a\n b\t c")).toBe("a b c");
	});

	it("clamps at 120 chars with ellipsis", () => {
		const long = "x".repeat(200);
		const view = userReferenceLogView(long);
		expect(view.length).toBe(120);
		expect(view.endsWith("…")).toBe(true);
	});

	it("passes through short values", () => {
		expect(userReferenceLogView("short")).toBe("short");
		expect(userReferenceLogView("")).toBe("");
	});
});
