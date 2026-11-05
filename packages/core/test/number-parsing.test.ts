import { describe, expect, it } from "vitest";
import {
	parseCanonicalInteger,
	parseClampedFloat,
	parseClampedInteger,
	parseNonNegativeInteger,
	parsePositiveFloat,
	parsePositiveInteger,
} from "../src/utils/number-parsing.ts";

describe("parsePositiveInteger", () => {
	it("parses valid positive integer strings", () => {
		expect(parsePositiveInteger("42")).toBe(42);
		expect(parsePositiveInteger(" 100 ")).toBe(100);
		expect(parsePositiveInteger("1")).toBe(1);
	});

	it("returns fallback for missing, zero, negative, or invalid strings", () => {
		expect(parsePositiveInteger(undefined, 10)).toBe(10);
		expect(parsePositiveInteger("", 10)).toBe(10);
		expect(parsePositiveInteger("0", 10)).toBe(10);
		expect(parsePositiveInteger("-5", 10)).toBe(10);
		expect(parsePositiveInteger("abc", 10)).toBe(10);
		expect(parsePositiveInteger("2.5", 10)).toBe(10);
	});

	it("normalizes non-positive or non-integer fallback to undefined", () => {
		expect(parsePositiveInteger("abc", 0)).toBeUndefined();
		expect(parsePositiveInteger("abc", -1)).toBeUndefined();
		expect(parsePositiveInteger("abc", 2.5)).toBeUndefined();
		expect(parsePositiveInteger(undefined, Number.NaN)).toBeUndefined();
	});
});

describe("parseNonNegativeInteger", () => {
	it("parses zero and positive integers", () => {
		expect(parseNonNegativeInteger("0")).toBe(0);
		expect(parseNonNegativeInteger("42")).toBe(42);
		expect(parseNonNegativeInteger(" 100 ")).toBe(100);
	});

	it("returns fallback for negative, decimal, or malformed strings", () => {
		expect(parseNonNegativeInteger("-1", 5)).toBe(5);
		expect(parseNonNegativeInteger("3.14", 5)).toBe(5);
		expect(parseNonNegativeInteger("xyz", 5)).toBe(5);
	});

	it("normalizes negative or non-integer fallback to undefined", () => {
		expect(parseNonNegativeInteger("invalid", -1)).toBeUndefined();
		expect(parseNonNegativeInteger("invalid", 3.5)).toBeUndefined();
	});
});

describe("parseCanonicalInteger", () => {
	it("parses canonical unsigned decimal integers without padding", () => {
		expect(parseCanonicalInteger("0")).toBe(0);
		expect(parseCanonicalInteger("100")).toBe(100);
		expect(parseCanonicalInteger("")).toBeUndefined();
		expect(parseCanonicalInteger(undefined)).toBeUndefined();
	});

	it("returns invalid for whitespace padding or malformed input", () => {
		expect(parseCanonicalInteger(" 1")).toBe("invalid");
		expect(parseCanonicalInteger("1 ")).toBe("invalid");
		expect(parseCanonicalInteger("-1")).toBe("invalid");
		expect(parseCanonicalInteger("01")).toBe("invalid");
	});

	it("validates bounds and clamp option", () => {
		expect(parseCanonicalInteger("5", { min: 1, max: 10 })).toBe(5);
		expect(parseCanonicalInteger("15", { min: 1, max: 10 })).toBe("invalid");
		expect(parseCanonicalInteger("15", { min: 1, max: 10, clamp: true })).toBe(
			10,
		);
		expect(() => parseCanonicalInteger("5", { min: 10, max: 2 })).toThrow(
			RangeError,
		);
	});
});

describe("parsePositiveFloat", () => {
	it("parses positive finite floats", () => {
		expect(parsePositiveFloat("3.14")).toBe(3.14);
		expect(parsePositiveFloat("42", { floor: true })).toBe(42);
		expect(parsePositiveFloat("2.9", { floor: true })).toBe(2);
	});

	it("returns fallback for non-positive or malformed floats", () => {
		expect(parsePositiveFloat("0", { fallback: 1.5 })).toBe(1.5);
		expect(parsePositiveFloat("-2", { fallback: 1.5 })).toBe(1.5);
		expect(parsePositiveFloat("abc", { fallback: 1.5 })).toBe(1.5);
	});

	it("normalizes non-positive fallback to undefined", () => {
		expect(parsePositiveFloat("abc", { fallback: 0 })).toBeUndefined();
		expect(parsePositiveFloat("abc", { fallback: -2 })).toBeUndefined();
	});
});

describe("parseClampedFloat", () => {
	it("clamps parsed floats to min/max", () => {
		expect(parseClampedFloat("15.5", { min: 0, max: 10 })).toBe(10);
		expect(parseClampedFloat("-5.5", { min: 0, max: 10 })).toBe(0);
		expect(parseClampedFloat("5.5", { min: 0, max: 10 })).toBe(5.5);
	});

	it("clamps fallback when input is invalid or missing", () => {
		expect(parseClampedFloat("invalid", { min: 5, max: 10, fallback: 2 })).toBe(
			5,
		);
		expect(
			parseClampedFloat("invalid", { min: 5, max: 10, fallback: 20 }),
		).toBe(10);
		expect(parseClampedFloat("invalid", { min: 5, max: 10, fallback: 7 })).toBe(
			7,
		);
	});

	it("throws RangeError when min > max", () => {
		expect(() => parseClampedFloat("5", { min: 10, max: 2 })).toThrow(
			RangeError,
		);
	});
});

describe("parseClampedInteger", () => {
	it("clamps parsed integers to min/max", () => {
		expect(parseClampedInteger("15", { min: 0, max: 10 })).toBe(10);
		expect(parseClampedInteger("-5", { min: 0, max: 10 })).toBe(0);
		expect(parseClampedInteger("5", { min: 0, max: 10 })).toBe(5);
		expect(parseClampedInteger("-0")).toBe(0);
	});

	it("clamps fallback when input is invalid or missing", () => {
		expect(
			parseClampedInteger("invalid", { min: 5, max: 10, fallback: 0 }),
		).toBe(5);
		expect(
			parseClampedInteger("invalid", { min: 5, max: 10, fallback: 50 }),
		).toBe(10);
		expect(
			parseClampedInteger("invalid", { min: 5, max: 10, fallback: 8 }),
		).toBe(8);
	});

	it("normalizes non-integer fallback to undefined", () => {
		expect(
			parseClampedInteger("invalid", { min: 0, max: 10, fallback: 2.5 }),
		).toBeUndefined();
	});

	it("throws RangeError when min > max", () => {
		expect(() => parseClampedInteger("5", { min: 10, max: 2 })).toThrow(
			RangeError,
		);
	});
});
