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

	it("pads odd-length hex with a leading zero (browser + Node parity)", () => {
		// "abc" -> "0abc" -> bytes 0x0a, 0xbc
		expect(toHex(fromHex("abc"))).toBe("0abc");
		expect(toHex(fromHex("0abc"))).toBe("0abc");
		expect(toHex(fromHex("a"))).toBe("0a");
		expect(toHex(fromHex("f"))).toBe("0f");
		expect(toHex(fromHex("0"))).toBe("00");
		expect(toHex(fromHex("1"))).toBe("01");
		// odd length with separators: "a b c" -> "abc" -> "0abc"
		expect(toHex(fromHex("a b c"))).toBe("0abc");
		expect(toHex(fromHex("a-b-c"))).toBe("0abc");
		expect(toHex(fromHex("  a  "))).toBe("0a");
		// odd length with 0x prefix noise
		expect(toHex(fromHex("0xabc"))).toBe("0abc");
		expect(toHex(fromHex("0x1"))).toBe("01");
		// longer odd
		expect(toHex(fromHex("12345"))).toBe("012345");
		expect(toHex(fromHex("1234567"))).toBe("01234567");
		// even length unchanged
		expect(toHex(fromHex("abcd"))).toBe("abcd");
		expect(toHex(fromHex("00"))).toBe("00");
		expect(toHex(fromHex("0000"))).toBe("0000");
		expect(toHex(fromHex(""))).toBe("");
		// case-insensitive and non-hex stripping
		expect(toHex(fromHex("ABC"))).toBe("0abc");
		expect(toHex(fromHex("a!b@c#"))).toBe("0abc");
		// browser parity: ensures byte length is correct after padding
		expect(fromHex("abc").length).toBe(2);
		expect(fromHex("a").length).toBe(1);
		expect(fromHex("12345").length).toBe(3);
		expect(fromHex("").length).toBe(0);
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
