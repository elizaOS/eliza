/**
 * Unit tests for type guards in packages/core/src/utils/type-guards.ts.
 */

import { describe, expect, it } from "vitest";
import {
	asRecord,
	asRecordOrUndefined,
	isFiniteNumber,
	isNonEmptyArray,
	isNonEmptyString,
	isObjectRecord,
	isPlainObject,
} from "./type-guards";

describe("isPlainObject", () => {
	it("identifies object literals and null-prototype objects", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject({ key: "val" })).toBe(true);
		expect(isPlainObject(Object.create(null))).toBe(true);
		expect(isPlainObject(Object.create(Object.prototype))).toBe(true);
	});

	it("rejects non-plain object built-ins and instances", () => {
		expect(isPlainObject(new Date())).toBe(false);
		expect(isPlainObject(/regex/)).toBe(false);
		expect(isPlainObject(new Map())).toBe(false);
		expect(isPlainObject(new Set())).toBe(false);
		expect(isPlainObject(new Error("err"))).toBe(false);
		expect(isPlainObject(Promise.resolve())).toBe(false);
		expect(isPlainObject(new Uint8Array())).toBe(false);

		class CustomClass {
			foo = "bar";
		}
		expect(isPlainObject(new CustomClass())).toBe(false);
	});

	it("rejects spoofed prototypes without invoking their constructor getter", () => {
		const spoofedPrototype = { constructor: Object };
		expect(isPlainObject(Object.create(spoofedPrototype))).toBe(false);

		const hostilePrototype = Object.create(null);
		Object.defineProperty(hostilePrototype, "constructor", {
			get: () => {
				throw new Error("constructor getter must not run");
			},
		});
		expect(isPlainObject(Object.create(hostilePrototype))).toBe(false);
	});

	it("rejects arrays, functions, and primitives", () => {
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject([1, 2, 3])).toBe(false);
		expect(isPlainObject(() => {})).toBe(false);
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject(undefined)).toBe(false);
		expect(isPlainObject(42)).toBe(false);
		expect(isPlainObject("string")).toBe(false);
		expect(isPlainObject(true)).toBe(false);
		expect(isPlainObject(Symbol("sym"))).toBe(false);
		expect(isPlainObject(100n)).toBe(false);
	});
});

describe("isObjectRecord", () => {
	it("identifies all non-null, non-array objects including class instances", () => {
		expect(isObjectRecord({})).toBe(true);
		expect(isObjectRecord({ a: 1 })).toBe(true);
		expect(isObjectRecord(new Date())).toBe(true);
		expect(isObjectRecord(Object.create(null))).toBe(true);
	});

	it("rejects null, arrays, and primitive values", () => {
		expect(isObjectRecord(null)).toBe(false);
		expect(isObjectRecord([])).toBe(false);
		expect(isObjectRecord(undefined)).toBe(false);
		expect(isObjectRecord(123)).toBe(false);
		expect(isObjectRecord("test")).toBe(false);
	});
});

describe("asRecord and asRecordOrUndefined", () => {
	it("narrows plain objects and returns null or undefined otherwise", () => {
		const plain = { name: "eliza" };
		expect(asRecord(plain)).toBe(plain);
		expect(asRecordOrUndefined(plain)).toBe(plain);

		expect(asRecord(new Date())).toBeNull();
		expect(asRecordOrUndefined(new Date())).toBeUndefined();

		expect(asRecord(null)).toBeNull();
		expect(asRecordOrUndefined(null)).toBeUndefined();

		expect(asRecord(undefined)).toBeNull();
		expect(asRecordOrUndefined(undefined)).toBeUndefined();
	});
});

describe("isNonEmptyString", () => {
	it("identifies non-empty strings", () => {
		expect(isNonEmptyString("hello")).toBe(true);
		expect(isNonEmptyString(" a ")).toBe(true);
		expect(isNonEmptyString("123")).toBe(true);
	});

	it("rejects empty or whitespace-only strings", () => {
		expect(isNonEmptyString("")).toBe(false);
		expect(isNonEmptyString("   ")).toBe(false);
		expect(isNonEmptyString("\t\n")).toBe(false);
	});

	it("rejects non-string values", () => {
		expect(isNonEmptyString(null)).toBe(false);
		expect(isNonEmptyString(undefined)).toBe(false);
		expect(isNonEmptyString(123)).toBe(false);
		expect(isNonEmptyString({})).toBe(false);
		expect(isNonEmptyString([])).toBe(false);
		expect(isNonEmptyString(true)).toBe(false);
	});
});

describe("isFiniteNumber", () => {
	it("identifies valid finite numbers", () => {
		expect(isFiniteNumber(0)).toBe(true);
		expect(isFiniteNumber(42)).toBe(true);
		expect(isFiniteNumber(-3.14)).toBe(true);
		expect(isFiniteNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(isFiniteNumber(Number.MIN_VALUE)).toBe(true);
	});

	it("rejects non-finite number values (NaN, ±Infinity)", () => {
		expect(isFiniteNumber(Number.NaN)).toBe(false);
		expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isFiniteNumber(Number.NEGATIVE_INFINITY)).toBe(false);
		expect(isFiniteNumber(Infinity)).toBe(false);
		expect(isFiniteNumber(-Infinity)).toBe(false);
	});

	it("rejects non-number values", () => {
		expect(isFiniteNumber("42")).toBe(false);
		expect(isFiniteNumber(null)).toBe(false);
		expect(isFiniteNumber(undefined)).toBe(false);
		expect(isFiniteNumber(true)).toBe(false);
		expect(isFiniteNumber({})).toBe(false);
		expect(isFiniteNumber([])).toBe(false);
		expect(isFiniteNumber(100n)).toBe(false);
	});
});

describe("isNonEmptyArray", () => {
	it("identifies non-empty arrays", () => {
		expect(isNonEmptyArray([1])).toBe(true);
		expect(isNonEmptyArray(["a", "b"])).toBe(true);
		expect(isNonEmptyArray([null])).toBe(true);
		expect(isNonEmptyArray([undefined])).toBe(true);
		expect(isNonEmptyArray([{}])).toBe(true);
	});

	it("rejects empty arrays", () => {
		expect(isNonEmptyArray([])).toBe(false);
	});

	it("rejects non-array values", () => {
		expect(isNonEmptyArray(null)).toBe(false);
		expect(isNonEmptyArray(undefined)).toBe(false);
		expect(isNonEmptyArray({})).toBe(false);
		expect(isNonEmptyArray("abc")).toBe(false);
		expect(isNonEmptyArray(123)).toBe(false);
		expect(isNonEmptyArray(new Set([1]))).toBe(false);
	});
});
