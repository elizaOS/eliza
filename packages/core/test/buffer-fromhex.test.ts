import { expect, test } from "vitest";
import { fromHex, toHex } from "../src/utils/buffer";

test("fromHex rejects odd-length hex instead of dropping the trailing nibble", () => {
	expect(() => fromHex("abc")).toThrow(/odd number of hex digits/);
	expect(() => fromHex("0a1")).toThrow(/odd number of hex digits/);
	// A 25-char IV hex decodes to 12 bytes under the old behavior, which
	// passed the v2 ciphertext length check in settings.ts.
	expect(() => fromHex("a".repeat(25))).toThrow(/odd number of hex digits/);
	// Separators are stripped before the length check, so an odd count of
	// hex digits hidden behind separators is rejected too.
	expect(() => fromHex("ff:fe:f")).toThrow(/odd number of hex digits/);
});

test("fromHex still decodes even-length hex with separators", () => {
	expect(toHex(fromHex("ff:fe:fd"))).toBe("fffefd");
	expect(toHex(fromHex("0A1B"))).toBe("0a1b");
	expect(toHex(fromHex(""))).toBe("");
});
