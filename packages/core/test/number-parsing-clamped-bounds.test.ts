import { describe, expect, it } from "vitest";
import {
	parseClampedFloat,
	parseClampedInteger,
} from "../src/utils/number-parsing";

describe("parseClampedInteger bounds", () => {
	it("rejects fractional bounds instead of returning a non-integer", () => {
		expect(() => parseClampedInteger("1", { min: 1.5 })).toThrow(RangeError);
		expect(() => parseClampedInteger("5", { max: 2.5 })).toThrow(RangeError);
	});

	it("rejects NaN bounds instead of returning NaN", () => {
		expect(() => parseClampedInteger("5", { min: NaN })).toThrow(RangeError);
		expect(() => parseClampedInteger("5", { max: NaN })).toThrow(RangeError);
	});

	it("rejects inverted bounds instead of returning a value outside them", () => {
		expect(() => parseClampedInteger("7", { min: 10, max: 5 })).toThrow(
			RangeError,
		);
	});

	it("still clamps with valid bounds, including the infinite defaults", () => {
		expect(parseClampedInteger("5", { min: 1, max: 10 })).toBe(5);
		expect(parseClampedInteger("0", { min: 1, max: 10 })).toBe(1);
		expect(parseClampedInteger("99", { min: 1, max: 10 })).toBe(10);
		expect(parseClampedInteger("5", { min: -Infinity, max: Infinity })).toBe(5);
	});
});

describe("parseClampedFloat bounds", () => {
	it("rejects inverted bounds instead of returning a value outside them", () => {
		expect(() => parseClampedFloat("7", { min: 10, max: 5 })).toThrow(
			RangeError,
		);
	});

	it("rejects NaN bounds instead of returning NaN", () => {
		expect(() => parseClampedFloat("5", { min: NaN })).toThrow(RangeError);
		expect(() => parseClampedFloat("5", { max: NaN })).toThrow(RangeError);
	});

	it("still accepts fractional bounds and clamps with them", () => {
		expect(parseClampedFloat("5", { min: 1.5, max: 2.5 })).toBe(2.5);
		expect(parseClampedFloat("0.5", { min: 1.5 })).toBe(1.5);
	});
});
