import { expect, it } from "vitest";
import { mergeCalendarSourceSelection } from "./calendar-source-selection.js";

it("accepts explicit top-level source IDs without guessing", () => {
  expect(
    mergeCalendarSourceSelection(
      { start: "time" },
      { grantId: "grant", calendarId: "calendar" },
    ),
  ).toEqual({ start: "time", grantId: "grant", calendarId: "calendar" });
});
it("keeps nested IDs when the caller omits top-level IDs", () => {
  expect(
    mergeCalendarSourceSelection(
      { grantId: "nested", calendarId: "selected" },
      { calendarId: "legacy" },
    ),
  ).toEqual({ grantId: "nested", calendarId: "selected" });
});
it("rejects conflicting grants", () => {
  expect(() =>
    mergeCalendarSourceSelection({ grantId: "first" }, { grantId: "second" }),
  ).toThrow("disagree");
});
it("rejects conflicting calendar IDs", () => {
  expect(() =>
    mergeCalendarSourceSelection(
      { calendarId: "first" },
      { grantId: "grant", calendarId: "second" },
    ),
  ).toThrow("disagree");
});
it("does not mutate caller-owned details", () => {
  const details = { start: "time" };
  mergeCalendarSourceSelection(details, { grantId: "grant" });
  expect(details).toEqual({ start: "time" });
});
