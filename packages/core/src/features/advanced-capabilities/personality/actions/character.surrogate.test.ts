/** Surrogate safety for complete character identity strings: must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import { toWellFormedUnicode } from "../../../../utils/well-formed.ts";
import { trimToString } from "./character.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

describe("trimToString", () => {
	test("preserves a complete long string", () => {
		const input = `${"a".repeat(150_000)}🦊 tail`;
		const trimmed = trimToString(input);

		expect(trimmed).toBe(input);
		expect(isWellFormed(trimmed as string)).toBe(true);
	});

	test("sanitizes a lone surrogate without dropping surrounding content", () => {
		const trimmed = trimToString("name \uD800 here");

		expect(trimmed).toBe("name � here");
		expect(isWellFormed(trimmed as string)).toBe(true);
	});

	test("still rejects non-strings and blank input", () => {
		expect(trimToString(42)).toBeUndefined();
		expect(trimToString("   ")).toBeUndefined();
	});
});
