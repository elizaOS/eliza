/**
 * `formatError` is the canonical error-message extractor and runs on failure
 * paths across the runtime, so it must never itself throw and mask the original
 * error. `String(value)` raises `TypeError: Cannot convert object to primitive
 * value` for null-prototype objects and objects with a poisoned
 * `toString` / `Symbol.toPrimitive`; a pathological `Error` subclass can expose
 * a throwing `message` getter. Every one of these must resolve to a string.
 */

import { describe, expect, it } from "vitest";
import { formatError } from "./format-error.ts";

describe("formatError", () => {
	it("returns an Error's message", () => {
		expect(formatError(new Error("socket hang up"))).toBe("socket hang up");
	});

	it("returns the message of an Error subclass", () => {
		class HttpError extends Error {}
		expect(formatError(new HttpError("bad gateway"))).toBe("bad gateway");
	});

	it("stringifies primitives", () => {
		expect(formatError("kaboom")).toBe("kaboom");
		expect(formatError(42)).toBe("42");
		expect(formatError(10n)).toBe("10");
		expect(formatError(Symbol("boom"))).toBe("Symbol(boom)");
		expect(formatError(null)).toBe("null");
		expect(formatError(undefined)).toBe("undefined");
	});

	it("stringifies a plain object via its toString", () => {
		expect(formatError({})).toBe("[object Object]");
	});

	it("does not throw on a null-prototype object", () => {
		let out = "";
		expect(() => {
			out = formatError(Object.create(null));
		}).not.toThrow();
		expect(out).toBe("[object Object]");
	});

	it("does not throw when toString throws", () => {
		const poisoned = {
			toString() {
				throw new Error("poisoned toString");
			},
		};
		let out = "";
		expect(() => {
			out = formatError(poisoned);
		}).not.toThrow();
		expect(out).toBe("[object Object]");
	});

	it("does not throw when Symbol.toPrimitive throws", () => {
		const poisoned = {
			[Symbol.toPrimitive]() {
				throw new Error("poisoned Symbol.toPrimitive");
			},
		};
		let out = "";
		expect(() => {
			out = formatError(poisoned);
		}).not.toThrow();
		expect(out).toBe("[object Object]");
	});

	it("does not throw when an Error's message getter throws", () => {
		class WeirdError extends Error {
			override get message(): string {
				throw new Error("poisoned message getter");
			}
		}
		let out = "";
		expect(() => {
			out = formatError(new WeirdError());
		}).not.toThrow();
		expect(out).toBe("[object Error]");
	});

	it("does not throw on a circular object", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		let out = "";
		expect(() => {
			out = formatError(circular);
		}).not.toThrow();
		expect(out).toBe("[object Object]");
	});

	it("returns [unstringifiable error] when type-tag access is hostile", () => {
		const hostile = new Proxy(
			{},
			{
				get(_target, prop) {
					if (
						prop === Symbol.toPrimitive ||
						prop === "toString" ||
						prop === Symbol.toStringTag
					) {
						throw new Error("hostile property access");
					}
					return undefined;
				},
			},
		);

		let out = "";
		expect(() => {
			out = formatError(hostile);
		}).not.toThrow();
		expect(out).toBe("[unstringifiable error]");
	});

	it("formats standard built-in errors and empty message errors", () => {
		expect(formatError(new TypeError("type mismatch"))).toBe("type mismatch");
		expect(formatError(new RangeError("out of bounds"))).toBe("out of bounds");
		expect(formatError(new SyntaxError("unexpected token"))).toBe(
			"unexpected token",
		);
		expect(formatError(new Error(""))).toBe("");
	});
});
