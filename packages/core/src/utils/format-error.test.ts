import { describe, expect, it } from "vitest";
import { formatError } from "./format-error";

describe("formatError", () => {
	it("returns Error message", () => {
		expect(formatError(new Error("test error"))).toBe("test error");
		expect(formatError(new TypeError("type error"))).toBe("type error");
	});

	it("returns String(value) for non-Error values", () => {
		expect(formatError("string error")).toBe("string error");
		expect(formatError(42)).toBe("42");
		expect(formatError(true)).toBe("true");
		expect(formatError(null)).toBe("null");
		expect(formatError(undefined)).toBe("undefined");
	});

	it("handles objects", () => {
		expect(formatError({ message: "test" })).toBe("[object Object]");
		expect(formatError([1, 2, 3])).toBe("1,2,3");
	});

	it("handles poisoned toString", () => {
		const poisoned = { toString() { throw new Error("poisoned"); } };
		expect(formatError(poisoned)).toBe("[object Object]");
	});

	it("handles poisoned message getter", () => {
		const poisoned = Object.create(null, {
			message: { get() { throw new Error("poisoned"); } },
		});
		expect(formatError(poisoned)).toBe("[object Object]");
	});
});
