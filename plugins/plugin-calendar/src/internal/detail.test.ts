/**
 * Guards the planner-junk calendarId boundary against the live regression it
 * exists for: a model-invented id ("cal_primary") passed through as an
 * explicit source filter, excluded every calendar, and a create turn died
 * with CALENDAR_MUTATION_CONTEXT_INCOMPLETE while the aggregated feed was
 * complete. Real provider ids (including the genuine "primary") must keep
 * passing through untouched. Deterministic unit harness, no mocks.
 */

import { describe, expect, it } from "vitest";
import { sanitizeCalendarId } from "./detail.js";

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
