/**
 * Cross-platform buffer abstraction (Node Buffer / browser Uint8Array). The
 * encoding round-trips and byte ops must agree across representations, since
 * crypto/secret code depends on these for hex/base64 conversions.
 */

import { describe, expect, it } from "vitest";
import {
	alloc,
	bufferToString,
	byteLength,
	concat,
	equals,
	fromBytes,
	fromHex,
	fromString,
	isBuffer,
	randomBytes,
	slice,
	toHex,
} from "./buffer.ts";

describe("hex / string round-trips", () => {
	it("utf8 ⇄ hex ⇄ string", () => {
		expect(toHex(fromString("Hello"))).toBe("48656c6c6f");
		expect(bufferToString(fromHex("48656c6c6f"))).toBe("Hello");
		// fromHex tolerates separators.
		expect(bufferToString(fromHex("48 65 6c 6c 6f"))).toBe("Hello");
	});

	it("base64 ⇄ utf8", () => {
		expect(bufferToString(fromString("SGVsbG8=", "base64"))).toBe("Hello");
		expect(bufferToString(fromString("Hi"), "base64")).toBe("SGk=");
	});

	it("hex via bufferToString", () => {
		expect(bufferToString(fromBytes([1, 2, 3]), "hex")).toBe("010203");
	});
});

describe("isBuffer", () => {
	it("recognizes buffer-likes only", () => {
		expect(isBuffer(fromString("x"))).toBe(true);
		expect(isBuffer(new Uint8Array([1]))).toBe(true);
		expect(isBuffer("x")).toBe(false);
		expect(isBuffer([1, 2])).toBe(false);
		expect(isBuffer(null)).toBe(false);
	});
});

describe("byte ops", () => {
	it("alloc fills zeros; fromBytes preserves values", () => {
		expect(toHex(alloc(4))).toBe("00000000");
		expect(byteLength(alloc(4))).toBe(4);
		expect(toHex(fromBytes([255, 0, 16]))).toBe("ff0010");
	});

	it("concat and slice compose bytes", () => {
		expect(toHex(concat([fromBytes([1]), fromBytes([2, 3])]))).toBe("010203");
		expect(toHex(slice(fromBytes([1, 2, 3, 4]), 1, 3))).toBe("0203");
	});

	it("equals compares contents and length", () => {
		expect(equals(fromBytes([1, 2]), fromBytes([1, 2]))).toBe(true);
		expect(equals(fromBytes([1, 2]), fromBytes([1, 9]))).toBe(false);
		expect(equals(fromBytes([1, 2]), fromBytes([1, 2, 3]))).toBe(false);
	});

	it("randomBytes returns the requested length and varies", () => {
		expect(byteLength(randomBytes(8))).toBe(8);
		expect(toHex(randomBytes(8))).not.toBe(toHex(randomBytes(8)));
	});
});
