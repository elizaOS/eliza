// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  detailArray,
  detailBoolean,
  detailNumber,
  detailObject,
  detailString,
  formatRelativeMinutes,
  messageSource,
  messageText,
  parseLifeOpsJsonRecord,
  toActionData,
} from "../src/lifeops/google/format-helpers.js";

/**
 * Pure helpers behind the LifeOps Google (calendar/gmail) action surface:
 * typed accessors that pull a value out of an untyped detail record (and return
 * undefined rather than a wrong-typed value), safe message field reads, model
 * JSON parsing that tolerates junk, and relative-time formatting.
 */

const mem = (content: unknown): Memory => ({ content }) as unknown as Memory;

describe("message field accessors", () => {
  it("read source/text only when they are strings", () => {
    expect(messageSource(mem({ source: "discord" }))).toBe("discord");
    expect(messageSource(mem({ source: 5 }))).toBeNull();
    expect(messageText(mem({ text: "hi" }))).toBe("hi");
    expect(messageText(mem({}))).toBe("");
  });
});

describe("detail accessors", () => {
  const details = {
    name: "  Ada  ",
    blank: "   ",
    count: 3,
    nan: Number.NaN,
    flag: false,
    obj: { a: 1 },
    arr: [1, 2],
  };

  it("return correctly-typed values, undefined on mismatch", () => {
    expect(detailString(details, "name")).toBe("Ada"); // trimmed
    expect(detailString(details, "blank")).toBeUndefined();
    expect(detailNumber(details, "count")).toBe(3);
    expect(detailNumber(details, "nan")).toBeUndefined();
    expect(detailBoolean(details, "flag")).toBe(false);
    expect(detailObject(details, "obj")).toEqual({ a: 1 });
    expect(detailObject(details, "arr")).toBeUndefined(); // arrays are not objects here
    expect(detailArray(details, "arr")).toEqual([1, 2]);
    expect(detailArray(details, "obj")).toBeUndefined();
  });
});

describe("parseLifeOpsJsonRecord", () => {
  it("parses a JSON object, null for non-object/garbage", () => {
    expect(parseLifeOpsJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(parseLifeOpsJsonRecord("not json")).toBeNull();
  });
});

describe("formatRelativeMinutes", () => {
  it("renders now / minutes / hours+minutes", () => {
    expect(formatRelativeMinutes(0)).toBe("now");
    expect(formatRelativeMinutes(-5)).toBe("now");
    expect(formatRelativeMinutes(25)).toBe("in 25 min");
    expect(formatRelativeMinutes(60)).toBe("in 1h");
    expect(formatRelativeMinutes(90)).toBe("in 1h 30m");
  });
});

describe("toActionData", () => {
  it("shallow-copies an object into a provider data record", () => {
    expect(toActionData({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  });
});
