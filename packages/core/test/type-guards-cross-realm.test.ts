import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
	asRecord,
	isPlainObject,
} from "../src/utils/type-guards.ts";

function crossRealm(code: string): unknown {
	return vm.runInNewContext(code);
}

describe("isPlainObject with cross-realm values", () => {
	it("accepts a plain object literal from another realm", () => {
		expect(isPlainObject(crossRealm("({ a: 1 })"))).toBe(true);
	});

	it("accepts a null-prototype object from another realm", () => {
		expect(
			isPlainObject(crossRealm("Object.create(null)")),
		).toBe(true);
	});

	it("still rejects a Date from another realm", () => {
		expect(isPlainObject(crossRealm("new Date()"))).toBe(false);
	});

	it("still rejects a class instance from another realm", () => {
		expect(
			isPlainObject(crossRealm("class Foo {}; new Foo()")),
		).toBe(false);
	});

	it("still rejects an array from another realm", () => {
		expect(isPlainObject(crossRealm("[1, 2]"))).toBe(false);
	});

	it("accepts a same-realm plain object and rejects same-realm built-ins", () => {
		expect(isPlainObject({ a: 1 })).toBe(true);
		expect(isPlainObject(new Date())).toBe(false);
		expect(isPlainObject(null)).toBe(false);
	});

	it("asRecord narrows a cross-realm plain object instead of null", () => {
		const value = crossRealm("({ a: 1 })");
		expect(asRecord(value)).toBe(value);
	});
});
