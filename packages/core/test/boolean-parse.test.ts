import { expect, test } from "vitest";
import { parseBooleanValue } from "../src/utils/boolean";

test("parseBooleanValue accepts numeric 1 and 0", () => {
	expect(parseBooleanValue(1)).toBe(true);
	expect(parseBooleanValue(0)).toBe(false);
});

test("parseBooleanValue returns undefined for other numbers", () => {
	expect(parseBooleanValue(2)).toBeUndefined();
	expect(parseBooleanValue(-1)).toBeUndefined();
	expect(parseBooleanValue(Number.NaN)).toBeUndefined();
	expect(parseBooleanValue(0.5)).toBeUndefined();
});

test("parseBooleanValue keeps its existing string and boolean behavior", () => {
	expect(parseBooleanValue(true)).toBe(true);
	expect(parseBooleanValue(false)).toBe(false);
	expect(parseBooleanValue("yes")).toBe(true);
	expect(parseBooleanValue("1")).toBe(true);
	expect(parseBooleanValue("false")).toBe(false);
	expect(parseBooleanValue("no")).toBe(false);
	expect(parseBooleanValue("maybe")).toBeUndefined();
	expect(parseBooleanValue("enabled", { truthy: ["enabled"] })).toBe(true);
	expect(parseBooleanValue(null)).toBeUndefined();
	expect(parseBooleanValue(undefined)).toBeUndefined();
});
