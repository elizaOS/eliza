/**
 * Connector action param helpers coerce loose agent input. limitParam clamps to
 * 1..100 (DoS-bounding a query), isUuidLike gates id-shaped inputs, and the
 * scalar readers reject non-coercible values rather than passing them through.
 */
import { describe, expect, it } from "vitest";
import type { HandlerOptions } from "../../../types/components";
import {
	boolParam,
	isUuidLike,
	limitParam,
	numberParam,
	paramsFromOptions,
	sourceParam,
	textParam,
} from "./connectorActionUtils.ts";

describe("paramsFromOptions / textParam", () => {
	it("reads the parameters bag and trims non-empty strings", () => {
		expect(
			paramsFromOptions({ parameters: { a: 1 } } as unknown as HandlerOptions),
		).toEqual({
			a: 1,
		});
		expect(paramsFromOptions(undefined)).toEqual({});
		expect(textParam("  hi ")).toBe("hi");
		expect(textParam("")).toBeUndefined();
		expect(textParam(5)).toBeUndefined();
	});
});

describe("boolParam", () => {
	it("accepts bool + truthy/falsy keywords, rejects junk", () => {
		expect(boolParam(true)).toBe(true);
		for (const v of ["yes", "1", "on", "TRUE"]) expect(boolParam(v)).toBe(true);
		for (const v of ["no", "0", "off", "false"])
			expect(boolParam(v)).toBe(false);
		expect(boolParam("maybe")).toBeUndefined();
		expect(boolParam(5)).toBeUndefined();
	});
});

describe("numberParam / limitParam", () => {
	it("numberParam coerces numbers/strings, else fallback", () => {
		expect(numberParam(5)).toBe(5);
		expect(numberParam("7")).toBe(7);
		expect(numberParam("x")).toBeUndefined();
		expect(numberParam("x", 10)).toBe(10);
	});

	it("limitParam clamps to 1..100 and floors, with a default", () => {
		expect(limitParam({ limit: 50 })).toBe(50);
		expect(limitParam({ limit: 200 })).toBe(100);
		expect(limitParam({ limit: 0 })).toBe(1);
		expect(limitParam({ limit: "5.9" })).toBe(5);
		expect(limitParam({})).toBe(20);
		expect(limitParam({}, 10)).toBe(10);
	});
});

describe("sourceParam", () => {
	it("prefers source, falls back to platform", () => {
		expect(sourceParam({ source: "discord" })).toBe("discord");
		expect(sourceParam({ platform: "slack" })).toBe("slack");
		expect(sourceParam({ source: "", platform: "x" })).toBe("x");
		expect(sourceParam({})).toBeUndefined();
	});
});

describe("isUuidLike", () => {
	it("matches canonical UUIDs only", () => {
		expect(isUuidLike("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
		expect(isUuidLike("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
		expect(isUuidLike("not-a-uuid")).toBe(false);
		expect(isUuidLike("123e4567e89b12d3a456426614174000")).toBe(false);
		expect(isUuidLike(undefined)).toBe(false);
	});
});
