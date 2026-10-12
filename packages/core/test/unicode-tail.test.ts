import { expect, test } from "vitest";
import { tailWellFormed, truncateWellFormed } from "../src/utils/unicode";

test("fractional tail lengths use a whole code-unit budget", () => {
	for (const text of ["abc", "a😀", "😀a", "a😀b"]) {
		for (const length of [0.5, 1.5, 2.5, 3.5]) {
			expect(tailWellFormed(text, length)).toBe(
				tailWellFormed(text, Math.floor(length)),
			);
			expect(tailWellFormed(text, length).length).toBeLessThanOrEqual(
				Math.floor(length),
			);
		}
	}
	expect(tailWellFormed("a😀", 1.5)).toBe("");
	expect(tailWellFormed("😀a", 2)).toBe("a");
	expect(tailWellFormed("a😀", 2)).toBe("😀");
	expect(tailWellFormed("a😀", 3)).toBe("a😀");
	expect(truncateWellFormed("a😀", 2.5)).toBe("a");
	for (const length of [0, -1, NaN, Infinity]) {
		expect(tailWellFormed("abc", length)).toBe("");
	}
});
