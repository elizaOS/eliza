import { expect, test } from "vitest";
import { stableStringify } from "../src/utils/deterministic";

test("stable JSON preserves boxed primitive values while sorting keys", () => {
	const number = Object(42);
	const string = Object("hello");
	const boolean = Object(false);
	expect(stableStringify(number)).toBe("42");
	expect(stableStringify(string)).toBe('"hello"');
	expect(stableStringify(boolean)).toBe("false");
	expect(stableStringify({ z: number, a: [string, boolean] })).toBe(
		'{"a":["hello",false],"z":42}',
	);
});
