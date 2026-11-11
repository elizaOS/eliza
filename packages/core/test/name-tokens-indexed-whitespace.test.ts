import { describe, expect, it } from "vitest";
import { replaceIndexedNameTokens } from "../src/name-tokens.ts";

describe("replaceIndexedNameTokens whitespace", () => {
	it("tolerates a space between the token name and the index", () => {
		expect(replaceIndexedNameTokens("Hi {{name 1}}!", ["Momo"])).toBe(
			"Hi Momo!",
		);
		expect(replaceIndexedNameTokens("Hi {{ name 1 }}!", ["Momo"])).toBe(
			"Hi Momo!",
		);
		expect(replaceIndexedNameTokens("Hi {{user 2}}!", ["Ana", "Ben"])).toBe(
			"Hi Ben!",
		);
	});

	it("keeps the existing compact and out-of-range behaviour", () => {
		expect(replaceIndexedNameTokens("Hi {{name1}}!", ["Momo"])).toBe(
			"Hi Momo!",
		);
		expect(replaceIndexedNameTokens("Hi {{ name1 }}!", ["Momo"])).toBe(
			"Hi Momo!",
		);
		expect(replaceIndexedNameTokens("Hi {{name 0}}!", ["Momo"])).toBe(
			"Hi {{name 0}}!",
		);
		expect(replaceIndexedNameTokens("Hi {{name 9}}!", ["Momo"])).toBe(
			"Hi {{name 9}}!",
		);
		expect(replaceIndexedNameTokens("Hi {{username 1}}!", ["Momo"])).toBe(
			"Hi {{username 1}}!",
		);
	});
});
