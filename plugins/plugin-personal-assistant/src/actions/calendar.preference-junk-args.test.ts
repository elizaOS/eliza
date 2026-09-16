/**
 * Planner-argument validation for the CALENDAR action when the planner fills
 * the update_preferences-only `blackoutWindows` field with junk on an unrelated
 * operation. Exercises the same validateToolArgs boundary the planner loop
 * applies before the handler runs; no runtime or database.
 */
import { describe, expect, it } from "vitest";
import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args";
import { calendarAction } from "./calendar";

describe("CALENDAR planner arguments carrying junk preference fields", () => {
  it("accepts a search_events call whose blackout window is malformed", () => {
    // Live 2026-09-05: startLocal "00" failed the whole read with
    // "does not match pattern" before the handler could ignore the field.
    const result = validateToolArgs(calendarAction, {
      action: "search_events",
      query: "Tuesday",
      blackoutWindows: [{ startLocal: "00", endLocal: "00" }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("still rejects a typed-bound violation on a declared numeric field", () => {
    const result = validateToolArgs(calendarAction, {
      action: "update_preferences",
      travelBufferMinutes: "ninety",
    });
    expect(result.valid).toBe(false);
  });
});
