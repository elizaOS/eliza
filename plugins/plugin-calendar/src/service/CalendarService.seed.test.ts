/**
 * Exercises the server-side bounded calendar seed receipt over a stubbed feed:
 * exact-source selection, provider-neutral duplicate counting, and the refusal
 * to issue a receipt when any source failed. No provider or store is touched.
 */

import { describe, expect, it, vi } from "vitest";
import { CalendarService } from "./CalendarService.js";

const url = new URL("http://127.0.0.1/");

function event(overrides: Record<string, unknown>) {
  return {
    provider: "google",
    side: "owner",
    grantId: "connector-account:account-a",
    connectorAccountId: "account-a",
    calendarId: "primary",
    externalId: "evt-1",
    recurringEventId: null,
    startAt: "2026-08-24T16:00:00.000Z",
    ...overrides,
  };
}

function seedWithFeed(feed: Record<string, unknown>) {
  const getCalendarFeed = vi.fn(async () => feed);
  const service = { getCalendarFeed } as unknown as CalendarService;
  return {
    getCalendarFeed,
    seed: (
      request: Parameters<CalendarService["seedImportedCalendarData"]>[1],
    ) =>
      CalendarService.prototype.seedImportedCalendarData.call(
        service,
        url,
        request,
        new Date("2026-08-22T10:00:00.000Z"),
      ),
  };
}

const googleSource = {
  provider: "google" as const,
  side: "owner" as const,
  grantId: "connector-account:account-a",
  connectorAccountId: "account-a",
  calendarId: "primary",
};
const googleSourceHealth = {
  key: googleSource,
  summary: "Primary",
  accessRole: "owner",
  visibility: "details" as const,
  status: "fresh" as const,
  syncedAt: "2026-08-22T10:00:00.000Z",
  error: null,
};
const appleSource = {
  provider: "apple_calendar" as const,
  side: "owner" as const,
  grantId: "apple-calendar",
  connectorAccountId: "apple-calendar",
  calendarId: "apple-work",
};
const appleSourceHealth = {
  key: appleSource,
  summary: "Work",
  accessRole: "owner",
  visibility: "details" as const,
  status: "fresh" as const,
  syncedAt: "2026-08-22T10:00:00.000Z",
  error: null,
};

describe("CalendarService.seedImportedCalendarData", () => {
  it("force-syncs the window and counts only the selected sources", async () => {
    const { seed, getCalendarFeed } = seedWithFeed({
      state: "complete",
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      sources: [googleSourceHealth, appleSourceHealth],
      events: [
        event({}),
        event({ externalId: "evt-1" }),
        event({ externalId: "evt-2", recurringEventId: "series" }),
        event({
          externalId: "evt-2",
          recurringEventId: "series",
          startAt: "2026-08-31T16:00:00.000Z",
        }),
        event({
          provider: "apple_calendar",
          grantId: "apple-calendar",
          connectorAccountId: "apple-calendar",
          calendarId: "apple-work",
          externalId: "apple-1",
        }),
        event({
          provider: "apple_calendar",
          grantId: "apple-calendar",
          connectorAccountId: "apple-calendar",
          calendarId: "apple-home",
          externalId: "apple-2",
        }),
      ],
    });

    const receipt = await seed({
      side: "owner",
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      timeZone: "UTC",
      calendars: [googleSource, appleSource],
    });

    expect(getCalendarFeed).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        side: "owner",
        timeMin: "2026-08-15T00:00:00.000Z",
        timeMax: "2026-11-20T00:00:00.000Z",
        timeZone: "UTC",
        forceSync: true,
      }),
      expect.any(Date),
    );
    expect(receipt).toEqual({
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      feedState: "complete",
      selectedSourceCount: 2,
      eventCount: 4,
      duplicateEventCount: 1,
      seededAt: "2026-08-22T10:00:00.000Z",
    });
  });

  it("refuses a receipt when the forced sync left any source stale", async () => {
    const { seed } = seedWithFeed({
      state: "partial",
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      sources: [
        { summary: "Work", error: { code: "provider_unavailable" } },
        { summary: "Home", error: null },
      ],
      events: [event({})],
    });

    await expect(
      seed({
        timeMin: "2026-08-15T00:00:00.000Z",
        timeMax: "2026-11-20T00:00:00.000Z",
        calendars: [googleSource],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "CALENDAR_SEED_INCOMPLETE",
      message: expect.stringContaining("Work"),
    });
  });

  it("requires at least one selected calendar before touching the feed", async () => {
    const { seed, getCalendarFeed } = seedWithFeed({ state: "complete" });

    await expect(
      seed({
        timeMin: "2026-08-15T00:00:00.000Z",
        timeMax: "2026-11-20T00:00:00.000Z",
        calendars: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(getCalendarFeed).not.toHaveBeenCalled();
  });

  it("rejects a caller-invented source absent from the authoritative feed", async () => {
    const { seed } = seedWithFeed({
      state: "complete",
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      sources: [],
      events: [],
    });

    await expect(
      seed({
        timeMin: "2026-08-15T00:00:00.000Z",
        timeMax: "2026-11-20T00:00:00.000Z",
        calendars: [googleSource],
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "CALENDAR_SEED_SOURCE_NOT_AUTHORIZED",
    });
  });

  it("rejects duplicate and wrong-side source selections", async () => {
    const { seed } = seedWithFeed({
      state: "complete",
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      sources: [googleSourceHealth],
      events: [],
    });

    await expect(
      seed({
        side: "owner",
        timeMin: "2026-08-15T00:00:00.000Z",
        timeMax: "2026-11-20T00:00:00.000Z",
        calendars: [googleSource, googleSource],
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_SEED_SELECTION_DUPLICATE" });
    await expect(
      seed({
        side: "agent",
        timeMin: "2026-08-15T00:00:00.000Z",
        timeMax: "2026-11-20T00:00:00.000Z",
        calendars: [googleSource],
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_SEED_SIDE_MISMATCH" });
  });
});
