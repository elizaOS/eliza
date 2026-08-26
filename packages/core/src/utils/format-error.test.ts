/**
 * `formatError` and `toError` are the canonical error utilities and run on
 * failure paths across the runtime. They must never themselves throw and mask
 * the original error, and toError must preserve the original error as `.cause`.
 */

import { describe, expect, it } from "vitest";
import { formatError, toError } from "./format-error.ts";

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
});

describe("toError", () => {
	it("returns existing Error instances unmodified", () => {
		const orig = new Error("existing error");
		expect(toError(orig)).toBe(orig);
	});

	it("converts strings and primitives into Error instances preserving cause", () => {
		const errString = toError("something broke");
		expect(errString).toBeInstanceOf(Error);
		expect(errString.message).toBe("something broke");
		expect(errString.cause).toBe("something broke");

		const errNum = toError(500);
		expect(errNum).toBeInstanceOf(Error);
		expect(errNum.message).toBe("500");
		expect(errNum.cause).toBe(500);

		const errObj = toError({ status: 500, detail: "bad gateway" });
		expect(errObj).toBeInstanceOf(Error);
		expect(errObj.message).toBe("[object Object]");
		expect(errObj.cause).toEqual({ status: 500, detail: "bad gateway" });
	});

	it("handles empty strings, whitespace, null, and undefined with fallback message", () => {
		expect(toError("").message).toBe("Unknown error");
		expect(toError("   ", "Custom fallback").message).toBe("Custom fallback");
		expect(toError(null).message).toBe("Unknown error");
		expect(toError(undefined, "Missing error").message).toBe("Missing error");
	});

	it("survives hostile/poisoned objects without throwing and preserves cause", () => {
		const nullProto = Object.create(null);
		nullProto.code = 123;
		const errNullProto = toError(nullProto);
		expect(errNullProto).toBeInstanceOf(Error);
		expect(errNullProto.message).toBe("[object Object]");
		expect(errNullProto.cause).toBe(nullProto);

		const poisonedToString = {
			toString() {
				throw new Error("poisoned toString");
			},
		};
		const errPoisoned = toError(poisonedToString);
		expect(errPoisoned).toBeInstanceOf(Error);
		expect(errPoisoned.message).toBe("[object Object]");
		expect(errPoisoned.cause).toBe(poisonedToString);
	});
});
