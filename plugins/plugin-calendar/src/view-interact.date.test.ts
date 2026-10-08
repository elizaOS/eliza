/**
 * A calendar view date must be a real civil day. February 30 matches the
 * YYYY-MM-DD shape, and the timezone resolver then throws instead of
 * returning a validation result.
 */
import { describe, expect, it } from "vitest";
import type { CalendarService } from "./service/CalendarService.js";
import { interact } from "./view-interact.js";

function serviceThatMustNotLoad(): CalendarService {
  return {
    getCalendarFeed() {
      throw new Error("feed should not load for an impossible date");
    },
  } as unknown as CalendarService;
}

describe("calendar view date", () => {
  it("rejects a date that is not a real day", async () => {
    const result = await interact(
      "get-events",
      { date: "2024-02-30" },
      serviceThatMustNotLoad(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CALENDAR_VIEW_VALIDATION_FAILED");
    expect(result.text).toContain("real calendar day");

    const nonLeap = await interact(
      "get-events",
      { date: "2023-02-29" },
      serviceThatMustNotLoad(),
    );
    expect(nonLeap.success).toBe(false);
    expect(nonLeap.error?.code).toBe("CALENDAR_VIEW_VALIDATION_FAILED");

    const april = await interact(
      "get-events",
      { date: "2024-04-31" },
      serviceThatMustNotLoad(),
    );
    expect(april.success).toBe(false);
    expect(april.error?.code).toBe("CALENDAR_VIEW_VALIDATION_FAILED");
  });

  it("still rejects a date that is not YYYY-MM-DD", async () => {
    const result = await interact(
      "get-events",
      { date: "February 30, 2024" },
      serviceThatMustNotLoad(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CALENDAR_VIEW_VALIDATION_FAILED");
    expect(result.text).toContain("YYYY-MM-DD");
  });

  it("loads a real leap day", async () => {
    let loaded = false;
    const service = {
      getCalendarFeed() {
        loaded = true;
        return {
          events: [],
          state: "complete",
          timeMin: "2024-02-29T00:00:00.000Z",
          timeMax: "2024-03-01T00:00:00.000Z",
        };
      },
    } as unknown as CalendarService;
    const result = await interact(
      "get-events",
      { date: "2024-02-29", timeZone: "UTC" },
      service,
    );
    expect(loaded).toBe(true);
    expect(result.success).toBe(true);
  });
});
