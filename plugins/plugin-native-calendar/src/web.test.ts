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
        title: "Planning",
        startAt: "2026-05-31T12:00:00Z",
        endAt: "2026-05-31T13:00:00Z",
      }),
    ).resolves.toEqual(unsupportedResult);
    await expect(
      calendar.updateEvent({
        eventId: "event-1",
        title: "Planning",
      }),
    ).resolves.toEqual(unsupportedResult);
    await expect(calendar.deleteEvent({ eventId: "event-1" })).resolves.toEqual(
      unsupportedResult,
    );
  });

  it.each([
    { startAt: "../../etc/passwd", endAt: "2026-05-31T13:00:00Z" },
    { title: "<img src=x onerror=alert(1)>", location: "javascript:alert(1)" },
    { timeZone: "Mars/Olympus_Mons" },
    {
      attendees: [
        {
          email: "attacker@example.com",
          displayName: "<script>alert(1)</script>",
        },
      ],
    },
    { recurrenceRule: "FREQ=SECONDLY;COUNT=999999999" },
  ])("does not reflect hostile payload fields %#", async (payload) => {
    const calendar = new AppleCalendarWeb();

    const result = await calendar.createEvent(
      payload as Parameters<AppleCalendarWeb["createEvent"]>[0],
    );

    expect(result).toEqual(unsupportedResult);
    expect(JSON.stringify(result)).not.toContain("attacker@example.com");
    expect(JSON.stringify(result)).not.toContain("<script>");
    expect(JSON.stringify(result)).not.toContain("Mars/Olympus_Mons");
    expect(JSON.stringify(result)).not.toContain("FREQ=SECONDLY");
  });

  it("does not reflect fuzzed event payload strings from unsupported web calls", async () => {
    const calendar = new AppleCalendarWeb();
    let seed = 0x5eed;
    const alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>\"'`;/\\\n\t";
    const nextString = () => {
      let value = "";
      for (let index = 0; index < 48; index += 1) {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
        value += alphabet[seed % alphabet.length];
      }
      return value;
    };

    for (let index = 0; index < 64; index += 1) {
      const marker = nextString();
      const result = await calendar.updateEvent({
        eventId: marker,
        title: marker,
        description: marker,
        location: marker,
        timeZone: marker,
      });

      expect(result).toEqual(unsupportedResult);
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });

  it("returns a fresh unsupported object per call so callers cannot mutate shared state", async () => {
    const calendar = new AppleCalendarWeb();

    const first = await calendar.listCalendars();
    first.message = "mutated";

    await expect(calendar.listCalendars()).resolves.toEqual(unsupportedResult);
  });
});
