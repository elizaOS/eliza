/**
 * Unit tests for the calendar detail-coercion helpers (detailString/Number/
 * Boolean/Array) used to read fields off an LLM plan record. Pure functions.
 */
import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  detailArray,
  detailBoolean,
  detailNumber,
  detailString,
  messageText,
  parseCalendarJsonRecord,
} from "../src/internal/detail.js";

/**
 * Calendar action detail extraction (#8795). Typed readers coerce strictly
 * (wrong type → undefined), and parseCalendarJsonRecord robustly extracts a
 * JSON object from model output wrapped in <think> tags or code fences —
 * returning null (never a partial/array) on anything malformed.
 */

const msg = (text: unknown): Memory =>
  ({ content: { text } }) as unknown as Memory;

describe("typed detail readers", () => {
  it("messageText returns string text else empty", () => {
    expect(messageText(msg("hi"))).toBe("hi");
    expect(messageText(msg(undefined))).toBe("");
  });

  it("detailString/Number/Boolean/Array reject wrong types", () => {
    expect(detailString({ a: "  hi " }, "a")).toBe("hi");
    expect(detailString({ a: "" }, "a")).toBeUndefined();
    expect(detailString({ a: 5 }, "a")).toBeUndefined();
    expect(detailNumber({ a: 5 }, "a")).toBe(5);
    expect(detailNumber({ a: "5" }, "a")).toBeUndefined();
    expect(detailNumber({ a: Number.POSITIVE_INFINITY }, "a")).toBeUndefined();
    expect(detailBoolean({ a: true }, "a")).toBe(true);
    expect(detailBoolean({ a: "true" }, "a")).toBeUndefined();
    expect(detailArray({ a: [1, 2] }, "a")).toEqual([1, 2]);
    expect(detailArray({ a: "x" }, "a")).toBeUndefined();
  });
});

describe("parseCalendarJsonRecord", () => {
  it("extracts a JSON object from raw / fenced / think-wrapped output", () => {
    expect(parseCalendarJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(parseCalendarJsonRecord('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseCalendarJsonRecord('<think>reasoning</think>{"x":2}')).toEqual({
      x: 2,
    });
  });

  it("returns null for arrays / malformed / empty", () => {
    expect(parseCalendarJsonRecord("[1,2]")).toBeNull();
    expect(parseCalendarJsonRecord("not json")).toBeNull();
    expect(parseCalendarJsonRecord("")).toBeNull();
  });
});
