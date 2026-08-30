/** Parse string booleans against configurable truthy and falsy vocabularies. */

import { describe, expect, it } from "vitest";
import { parseBooleanValue, parseBooleanText } from "./boolean";

describe("parseBooleanValue", () => {
	it("passes boolean values through", () => {
		expect(parseBooleanValue(true)).toBe(true);
		expect(parseBooleanValue(false)).toBe(false);
	});

	it("parses default truthy strings", () => {
		expect(parseBooleanValue("true")).toBe(true);
		expect(parseBooleanValue("1")).toBe(true);
		expect(parseBooleanValue("yes")).toBe(true);
		expect(parseBooleanValue("on")).toBe(true);
	});

	it("parses default falsy strings", () => {
		expect(parseBooleanValue("false")).toBe(false);
		expect(parseBooleanValue("0")).toBe(false);
		expect(parseBooleanValue("no")).toBe(false);
		expect(parseBooleanValue("off")).toBe(false);
	});

	it("returns undefined for unparseable strings", () => {
		expect(parseBooleanValue("maybe")).toBeUndefined();
		expect(parseBooleanValue("")).toBeUndefined();
		expect(parseBooleanValue("   ")).toBeUndefined();
		expect(parseBooleanValue("2")).toBeUndefined();
		expect(parseBooleanValue("enabled")).toBeUndefined();
	});

	it("returns undefined for non-string/non-boolean values", () => {
		expect(parseBooleanValue(1)).toBeUndefined();
		expect(parseBooleanValue(0)).toBeUndefined();
		expect(parseBooleanValue(null)).toBeUndefined();
		expect(parseBooleanValue(undefined)).toBeUndefined();
		expect(parseBooleanValue({})).toBeUndefined();
		expect(parseBooleanValue([])).toBeUndefined();
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(parseBooleanValue("TRUE")).toBe(true);
		expect(parseBooleanValue("True")).toBe(true);
		expect(parseBooleanValue("  true  ")).toBe(true);
		expect(parseBooleanValue("YES")).toBe(true);
		expect(parseBooleanValue("  yes  ")).toBe(true);
		expect(parseBooleanValue("FALSE")).toBe(false);
		expect(parseBooleanValue("  false  ")).toBe(false);
		expect(parseBooleanValue("NO")).toBe(false);
		expect(parseBooleanValue("OFF")).toBe(false);
	});

	it("accepts custom truthy values", () => {
		expect(parseBooleanValue("enabled", { truthy: ["enabled"] })).toBe(true);
		expect(parseBooleanValue("on", { truthy: ["enabled"] })).toBeUndefined();
	});

	it("accepts custom falsy values", () => {
		expect(parseBooleanValue("disabled", { falsy: ["disabled"] })).toBe(false);
		expect(parseBooleanValue("off", { falsy: ["disabled"] })).toBeUndefined();
	});

	it("accepts both custom truthy and falsy values", () => {
		expect(parseBooleanValue("enabled", { truthy: ["enabled"], falsy: ["disabled"] })).toBe(true);
		expect(parseBooleanValue("disabled", { truthy: ["enabled"], falsy: ["disabled"] })).toBe(false);
		expect(parseBooleanValue("maybe", { truthy: ["enabled"], falsy: ["disabled"] })).toBeUndefined();
	});

	it("handles empty custom vocabularies", () => {
		expect(parseBooleanValue("true", { truthy: [], falsy: [] })).toBeUndefined();
	});
});

describe("parseBooleanText", () => {
	it("passes boolean values through", () => {
		expect(parseBooleanText(true)).toBe(true);
		expect(parseBooleanText(false)).toBe(false);
	});

	it("parses extended truthy strings", () => {
		expect(parseBooleanText("yes")).toBe(true);
		expect(parseBooleanText("y")).toBe(true);
		expect(parseBooleanText("true")).toBe(true);
		expect(parseBooleanText("t")).toBe(true);
		expect(parseBooleanText("1")).toBe(true);
		expect(parseBooleanText("on")).toBe(true);
		expect(parseBooleanText("enable")).toBe(true);
	});

	it("parses extended falsy strings", () => {
		expect(parseBooleanText("no")).toBe(false);
		expect(parseBooleanText("n")).toBe(false);
		expect(parseBooleanText("false")).toBe(false);
		expect(parseBooleanText("f")).toBe(false);
		expect(parseBooleanText("0")).toBe(false);
		expect(parseBooleanText("off")).toBe(false);
		expect(parseBooleanText("disable")).toBe(false);
	});

	it("defaults invalid text to false", () => {
		expect(parseBooleanText("maybe")).toBe(false);
		expect(parseBooleanText("")).toBe(false);
		expect(parseBooleanText("   ")).toBe(false);
		expect(parseBooleanText("2")).toBe(false);
		expect(parseBooleanText("enabled")).toBe(false);
	});

	it("handles null and undefined", () => {
		expect(parseBooleanText(null)).toBe(false);
		expect(parseBooleanText(undefined)).toBe(false);
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(parseBooleanText("YES")).toBe(true);
		expect(parseBooleanText("  yes  ")).toBe(true);
		expect(parseBooleanText("NO")).toBe(false);
		expect(parseBooleanText("  no  ")).toBe(false);
		expect(parseBooleanText("TRUE")).toBe(true);
		expect(parseBooleanText("FALSE")).toBe(false);
	});
});
