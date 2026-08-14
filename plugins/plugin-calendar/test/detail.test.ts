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
    ]) {
      expect(sanitizeCalendarId(junk)).toBeUndefined();
    }
  });

  it("passes real calendar ids through trimmed", () => {
    expect(sanitizeCalendarId("primary")).toBe("primary");
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

describe("detailString drops planner key-name debris", () => {
  // Live 2026-08-14: "cancel the quibbleworth review" arrived with
  // side="side", grantId="grantId", mode="mode". Those type-check, so the junk
  // grant reached connector routing, missed the built-in calendar, and the user
  // was told "Google Calendar isn't connected" about a local event.
  it("drops a value that is only its own key name", () => {
    expect(detailString({ side: "side" }, "side")).toBeUndefined();
    expect(detailString({ grantId: "grantId" }, "grantId")).toBeUndefined();
    expect(detailString({ mode: "mode" }, "mode")).toBeUndefined();
  });

  it("drops a key echo across naming styles", () => {
    expect(detailString({ grantId: "grant_id" }, "grantId")).toBeUndefined();
    expect(
      detailString({ calendar_id: "calendarId" }, "calendar_id"),
    ).toBeUndefined();
  });

  it("drops a comma-led key fragment", () => {
    expect(detailString({ title: ",time_min:" }, "title")).toBeUndefined();
    expect(detailString({ label: ", new_title" }, "label")).toBeUndefined();
  });

  it("keeps a real value that merely contains the key name", () => {
    expect(detailString({ side: "google" }, "side")).toBe("google");
    expect(detailString({ title: "title fight tickets" }, "title")).toBe(
      "title fight tickets",
    );
    expect(detailString({ query: "querying the db" }, "query")).toBe(
      "querying the db",
    );
  });
});
