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
  normalizePlannerCalendarWindow,
  parseCalendarJsonRecord,
  sanitizeCalendarId,
  sanitizeWindowPreset,
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

describe("sanitizeCalendarId (#18946)", () => {
  it("drops planner placeholder tokens case-insensitively", () => {
    for (const junk of [
      "default",
      "Default",
      "ALL",
      "none",
      "null",
      "unset",
      "unknown",
      "any",
      "AUTO",
      "  Auto  ",
      "cal_primary",
      "CAL_PRIMARY",
      "primary_calendar",
      "default_calendar",
      "my_calendar",
      "calendar",
      "cal_1",
      "calendar_id",
      "placeholder",
    ]) {
      expect(sanitizeCalendarId(junk)).toBeUndefined();
    }
  });

  it("passes real calendar ids through trimmed", () => {
    for (const id of [
      "primary",
      "nubs@example.com",
      "AAMkAGI2TGuLAAA=",
      "family-shared",
    ]) {
      expect(sanitizeCalendarId(id)).toBe(id);
    }
    expect(sanitizeCalendarId(" user@example.com ")).toBe("user@example.com");
    expect(sanitizeCalendarId("AQMkADAwATM3ZmYAZS0xYjIz")).toBe(
      "AQMkADAwATM3ZmYAZS0xYjIz",
    );
  });

  it("treats empty and whitespace-only values as unset", () => {
    expect(sanitizeCalendarId(undefined)).toBeUndefined();
    expect(sanitizeCalendarId("")).toBeUndefined();
    expect(sanitizeCalendarId("   ")).toBeUndefined();
  });
});

describe("normalizePlannerCalendarWindow (#18946)", () => {
  it.each([
    ["2026-08-05T09:00:00Z", "not-a-date"],
    ["not-a-date", "2026-08-05T10:00:00Z"],
    ["2026-08-05T10:00:00Z", "2026-08-05T09:00:00Z"],
  ])("drops the entire pair for incomplete or reversed bounds", (min, max) => {
    expect(normalizePlannerCalendarWindow(min, max)).toBeUndefined();
  });

  it("canonicalizes an ordered offset-bearing pair", () => {
    expect(
      normalizePlannerCalendarWindow(
        "2026-08-05T09:00:00-07:00",
        "2026-08-05T10:00:00-07:00",
      ),
    ).toEqual({
      timeMin: "2026-08-05T16:00:00.000Z",
      timeMax: "2026-08-05T17:00:00.000Z",
    });
  });
});

describe("sanitizeWindowPreset", () => {
  it("passes the declared presets through, case-insensitively", () => {
    expect(sanitizeWindowPreset("tomorrow_morning")).toBe("tomorrow_morning");
    expect(sanitizeWindowPreset(" Tomorrow_Evening ")).toBe("tomorrow_evening");
  });

  it("drops planner-invented presets so the timestamp path decides instead", () => {
    // The live regression: "gym session tuesday at 7am" produced a preset the
    // service rejected with a 400 that aborted the whole create.
    for (const junk of ["tuesday_morning", "morning", "next_week", "auto"]) {
      expect(sanitizeWindowPreset(junk)).toBeUndefined();
    }
    expect(sanitizeWindowPreset(undefined)).toBeUndefined();
    expect(sanitizeWindowPreset("   ")).toBeUndefined();
  });
});

describe("detailString literal values", () => {
  it.each([
    "n/a",
    "na",
    "None",
    "null",
    "undefined",
    "Unknown",
    "unset",
    "missing",
    "not specified",
    "not provided",
    "TBD",
    "placeholder",
    "location_missing",
    "traveloriginaddress_missing",
    "unknown_missing",
    "Missing Persons rehearsal",
    "Nana's house",
  ])("preserves the user-authored value %s in text fields", (value) => {
    for (const key of [
      "title",
      "description",
      "query",
      "location",
      "travelOriginAddress",
    ]) {
      expect(detailString({ [key]: value }, key)).toBe(value);
    }
  });

  it("omits only absent, non-string, and blank values", () => {
    for (const value of [undefined, null, false, 0, {}, [], "", "   "]) {
      expect(detailString({ title: value }, "title")).toBeUndefined();
    }
    expect(detailString(undefined, "title")).toBeUndefined();
    expect(detailString({}, "travelOriginAddress")).toBeUndefined();
    expect(detailString({ location: "  Golden Gate Park  " }, "location")).toBe(
      "Golden Gate Park",
    );
  });
});
