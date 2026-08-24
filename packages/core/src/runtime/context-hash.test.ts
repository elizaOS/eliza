/**
 * Tests for context-hash — stable stringify and hashing.
 */
import { describe, expect, it } from "vitest";
import { hashString } from "./context-hash.ts";

describe("context-hash", () => {
	it("hashes string deterministically", () => {
		const a = hashString("hello");
		const b = hashString("hello");
		expect(a).toBe(b);
		expect(a).toHaveLength(64);
	});

	it("different inputs produce different hashes", () => {
		expect(hashString("hello")).not.toBe(hashString("world"));
	});

	it("handles empty string", () => {
		const h = hashString("");
		expect(h).toHaveLength(64);
		expect(h).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("handles unicode", () => {
		const h = hashString("caf\u00e9");
		expect(h).toHaveLength(64);
		expect(h).not.toBe(hashString("cafe"));
	});

	it("is case sensitive", () => {
		expect(hashString("Hello")).not.toBe(hashString("hello"));
	});
});
