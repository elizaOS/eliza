/**
 * Verifies the public text-header helper preserves its header when the body is
 * empty and retains the established newline behavior for populated bodies.
 * This is a deterministic unit test with no runtime or model dependencies.
 */
import { describe, expect, it } from "vitest";
import { addHeader } from "./utils.ts";

describe("addHeader", () => {
	it("returns a non-empty header when the body is empty", () => {
		expect(addHeader("Header", "")).toBe("Header");
	});

	it("returns an empty string when both inputs are empty", () => {
		expect(addHeader("", "")).toBe("");
	});

	it("preserves the established newline-delimited body format", () => {
		expect(addHeader("Header", "Body")).toBe("Header\nBody\n");
		expect(addHeader("", "Body")).toBe("Body\n");
	});
});
