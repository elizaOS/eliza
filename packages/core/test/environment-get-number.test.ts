import { afterEach, expect, test } from "vitest";
import { Environment } from "../src/utils/environment";

afterEach(() => {
	delete process.env.TEST_NUM;
});

function read(value: string | undefined, defaultValue?: number) {
	if (value === undefined) delete process.env.TEST_NUM;
	else process.env.TEST_NUM = value;
	return new Environment().getNumber("TEST_NUM", defaultValue);
}

test("getNumber rejects hex, binary, and octal notation", () => {
	expect(read("0x10")).toBeUndefined();
	expect(read("0x10", 7)).toBe(7);
	expect(read("0b101")).toBeUndefined();
	expect(read("0o17")).toBeUndefined();
	expect(read("0XFF")).toBeUndefined();
});

test("getNumber still parses plain decimal values", () => {
	expect(read("100")).toBe(100);
	expect(read("12.5")).toBe(12.5);
	expect(read("1e3")).toBe(1000);
	expect(read(" 42 ")).toBe(42);
	expect(read(".5")).toBe(0.5);
	expect(read("-2")).toBe(-2);
});

test("getNumber rejects other non-numeric values", () => {
	expect(read("12abc")).toBeUndefined();
	expect(read("")).toBeUndefined();
	expect(read(undefined)).toBeUndefined();
	expect(read("Infinity")).toBeUndefined();
	expect(read("NaN")).toBeUndefined();
	expect(read("1_000")).toBeUndefined();
});
