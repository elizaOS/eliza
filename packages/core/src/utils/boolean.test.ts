/**
 * Unit tests for parseBooleanValue and parseBooleanText in packages/core/src/utils/boolean.ts.
 * Exercises default truthy/falsy vocabularies, custom options with mixed case and whitespace,
 * boolean pass-throughs, and invalid input fallbacks.
 */
import { describe, expect, it } from "vitest";
import { parseBooleanText, parseBooleanValue } from "./boolean";

describe("parseBooleanValue", () => {
	it("passes boolean literals through unchanged", () => {
		expect(parseBooleanValue(true)).toBe(true);
		expect(parseBooleanValue(false)).toBe(false);
	});

	it("parses default truthy string representations", () => {
		for (const val of ["true", "1", "yes", "on", "TRUE", "Yes", "ON "]) {
			expect(parseBooleanValue(val)).toBe(true);
		}
	});

	it("parses default falsy string representations", () => {
		for (const val of ["false", "0", "no", "off", "FALSE", "No", "OFF\n"]) {
			expect(parseBooleanValue(val)).toBe(false);
		}
	});

	it("returns undefined for unrecognized strings and non-string inputs", () => {
		expect(parseBooleanValue("maybe")).toBeUndefined();
		expect(parseBooleanValue("")).toBeUndefined();
		expect(parseBooleanValue("   ")).toBeUndefined();
		expect(parseBooleanValue(null)).toBeUndefined();
		expect(parseBooleanValue(undefined)).toBeUndefined();
		expect(parseBooleanValue(123)).toBeUndefined();
		expect(parseBooleanValue({})).toBeUndefined();
	});

	it("matches custom truthy and falsy options case-insensitively with whitespace trimming", () => {
		expect(
			parseBooleanValue("enabled", {
				truthy: ["Enabled"],
				falsy: ["Disabled"],
			}),
		).toBe(true);

		expect(
			parseBooleanValue("ENABLED", {
				truthy: ["enabled"],
			}),
		).toBe(true);

		expect(
			parseBooleanValue("disabled", {
				truthy: ["Enabled"],
				falsy: [" Disabled "],
			}),
		).toBe(false);

		expect(
			parseBooleanValue("DISABLED", {
				falsy: ["disabled"],
			}),
		).toBe(false);
	});
});

describe("parseBooleanText", () => {
	it("parses extended text booleans (y/n, enable/disable) with false fallback", () => {
		expect(parseBooleanText("yes")).toBe(true);
		expect(parseBooleanText("y")).toBe(true);
		expect(parseBooleanText("enable")).toBe(true);
		expect(parseBooleanText("ENABLE")).toBe(true);
		expect(parseBooleanText("no")).toBe(false);
		expect(parseBooleanText("n")).toBe(false);
		expect(parseBooleanText("disable")).toBe(false);
		expect(parseBooleanText("random_unknown_text")).toBe(false);
		expect(parseBooleanText(null)).toBe(false);
		expect(parseBooleanText(undefined)).toBe(false);
	});
});
