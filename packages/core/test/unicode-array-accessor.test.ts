import { describe, expect, it } from "vitest";
import { ElizaError } from "../src/errors.ts";
import { deepToWellFormedUnicode } from "../src/utils/unicode.ts";

function arrayWithGetter(): { array: unknown[]; ran: () => boolean } {
	let ran = false;
	const array: unknown[] = ["ok"];
	Object.defineProperty(array, 1, {
		enumerable: true,
		get() {
			ran = true;
			return "x";
		},
	});
	return { array, ran: () => ran };
}

describe("deepToWellFormedUnicode with array accessors", () => {
	it("rejects an accessor array element without invoking it", () => {
		const { array, ran } = arrayWithGetter();
		let caught: unknown;
		try {
			deepToWellFormedUnicode(array);
		} catch (error) {
			caught = error;
		}
		expect(ran()).toBe(false);
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe("WELL_FORMED_UNSAFE_VALUE");
	});

	it("rejects an accessor array element nested inside an object", () => {
		const { array, ran } = arrayWithGetter();
		expect(() =>
			deepToWellFormedUnicode({ items: array }),
		).toThrowError(ElizaError);
		expect(ran()).toBe(false);
	});

	it("still sanitizes plain arrays and keeps clean arrays by reference", () => {
		expect(deepToWellFormedUnicode(["a\ud83d", "b"])).toEqual([
			"a\ufffd",
			"b",
		]);
		const clean = ["a", "b"];
		expect(deepToWellFormedUnicode(clean)).toBe(clean);
	});

	it("keeps holes in sparse arrays", () => {
		const sparse: unknown[] = ["a", "b"];
		sparse.length = 3;
		const result = deepToWellFormedUnicode(sparse);
		expect(result).toBe(sparse);
		expect(result.length).toBe(3);
		expect(2 in result).toBe(false);
	});
});
