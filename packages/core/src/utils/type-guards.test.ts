/**
 * Unit tests for type guards in packages/core/src/utils/type-guards.ts.
 */

import { describe, expect, it } from "vitest";
import {
	asRecord,
	asRecordOrUndefined,
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
