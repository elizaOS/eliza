import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/utils/deterministic";

describe("stableStringify unstringifiable values", () => {
	it("rejects top-level undefined instead of returning undefined as a string", () => {
		// The declared return type is `string`, so a caller may use the
		// result as a string (`.length`, concatenation, hashing). Returning
		// the value `undefined` breaks that contract at runtime.
		expect(() => stableStringify(undefined)).toThrowError(
			/Cannot serialize undefined to JSON/,
		);
	});

	it("rejects top-level functions and symbols the same way", () => {
		expect(() => stableStringify(() => 1)).toThrowError(
			/Cannot serialize function to JSON/,
		);
		expect(() => stableStringify(Symbol("x"))).toThrowError(
			/Cannot serialize symbol to JSON/,
		);
	});

	it("keeps stringifying ordinary JSON values, keys sorted", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(stableStringify([3, 2])).toBe("[3,2]");
		expect(stableStringify("x")).toBe('"x"');
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(0)).toBe("0");
	});

	it("keeps dropping nested undefined instead of throwing", () => {
		expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(stableStringify([undefined, 1])).toBe("[null,1]");
	});

	it("keeps the Date special case", () => {
		expect(stableStringify(new Date("2026-01-02T03:04:05.000Z"))).toBe(
			'"2026-01-02T03:04:05.000Z"',
		);
	});
});
