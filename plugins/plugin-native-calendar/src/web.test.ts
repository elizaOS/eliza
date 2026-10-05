/**
 * Exercises the real `AppleCalendarWeb` fallback class directly (no mocks):
 * every method returns a stable `not_supported` result, omits caller payloads
 * and isolates returned objects from later calls.
 */
import { describe, expect, it } from "vitest";

import { AppleCalendarWeb } from "./web";

const unsupportedResult = {
  ok: false,
  error: "not_supported",
  message:
    "Apple Calendar is only available through the native iOS app or macOS desktop runtime.",
};

describe("AppleCalendarWeb fallback", () => {
  it("reports restricted permissions without trying to request native access", async () => {
    const calendar = new AppleCalendarWeb();

    await expect(calendar.checkPermissions()).resolves.toEqual({
      calendar: "restricted",
      canRequest: false,
      reason: unsupportedResult.message,
    });
    await expect(calendar.requestPermissions()).resolves.toEqual({
      calendar: "restricted",
      canRequest: false,
      reason: unsupportedResult.message,
    });
    await expect(
      calendar.requestPermissions({ access: "write_only" }),
    ).resolves.toEqual({
      calendar: "restricted",
      canRequest: false,
      reason: unsupportedResult.message,
    });
    await expect(
      calendar.requestPermissions({ access: "full_access" }),
    ).resolves.toEqual({
      calendar: "restricted",
      canRequest: false,
      reason: unsupportedResult.message,
    });
  });

  it("returns a stable unsupported result for all event operations", async () => {
    const calendar = new AppleCalendarWeb();

    await expect(calendar.listCalendars()).resolves.toEqual(unsupportedResult);
    await expect(
      calendar.listEvents({
        calendarId: "primary",
        timeMin: "2026-05-31T12:00:00Z",
        timeMax: "2026-05-31T13:00:00Z",
      }),
    ).resolves.toEqual(unsupportedResult);
    await expect(
      calendar.createEvent({
        title: "<script>payload-marker</script>",
        startAt: "2026-05-31T12:00:00Z",
        endAt: "2026-05-31T13:00:00Z",
      }),
    ).resolves.toEqual(unsupportedResult);
    await expect(
      calendar.updateEvent({
        eventId: "payload-marker",
        title: "<script>payload-marker</script>",
      }),
    ).resolves.toEqual(unsupportedResult);
    await expect(calendar.deleteEvent({ eventId: "event-1" })).resolves.toEqual(
      unsupportedResult,
    );
  });

  it("returns a fresh unsupported object per call so callers cannot mutate shared state", async () => {
    const calendar = new AppleCalendarWeb();

    const first = await calendar.listCalendars();
    first.message = "mutated";

    await expect(calendar.listCalendars()).resolves.toEqual(unsupportedResult);
  });
});
