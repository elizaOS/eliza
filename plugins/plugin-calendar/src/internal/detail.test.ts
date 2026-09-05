/**
 * Guards the planner-junk calendarId boundary against the live regression it
 * exists for: a model-invented id ("cal_primary") passed through as an
 * explicit source filter, excluded every calendar, and a create turn died
 * with CALENDAR_MUTATION_CONTEXT_INCOMPLETE while the aggregated feed was
 * complete. Real provider ids (including the genuine "primary") must keep
 * passing through untouched. Deterministic unit harness, no mocks.
 */

import { describe, expect, it } from "vitest";
import {
  detailString,
  sanitizeCalendarId,
  sanitizeWindowPreset,
} from "./detail.js";

describe("sanitizeCalendarId", () => {
  it("passes real calendar ids through untouched", () => {
    for (const id of [
      "primary",
      "nubs@example.com",
      "AAMkAGI2TGuLAAA=",
      "family-shared",
    ]) {
      expect(sanitizeCalendarId(id)).toBe(id);
    }
  });

  it("drops the model-invented placeholder vocabulary to the aggregated feed", () => {
    for (const id of [
      "default",
      "all",
      "auto",
      // The live-regression spellings: synthetic "the calendar" ids.
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
      expect(sanitizeCalendarId(id)).toBeUndefined();
    }
  });

  it("treats empty and whitespace values as unset", () => {
    expect(sanitizeCalendarId(undefined)).toBeUndefined();
    expect(sanitizeCalendarId("")).toBeUndefined();
    expect(sanitizeCalendarId("   ")).toBeUndefined();
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
