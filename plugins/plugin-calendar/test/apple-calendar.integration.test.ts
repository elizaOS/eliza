/**
 * Unit coverage for the native Apple Calendar FeatureResult contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  createNativeAppleCalendarEvent,
  getNativeAppleCalendarFeed,
  listNativeAppleCalendars,
} from "../src/apple-calendar.js";

function bridge(overrides = {}) {
  return {
    platform: "darwin",
    checkPermissions: vi.fn(async () => ({
      calendar: "granted",
      canRequest: false,
    })),
    listCalendars: vi.fn(async () => ({ ok: true, calendars: [] })),
    listEvents: vi.fn(async () => ({ ok: true, events: [] })),
    createEvent: vi.fn(async () => ({
      ok: true,
      event: {
        id: "event-1",
        externalId: "event-1",
        calendarId: "cal-1",
        title: "Dentist",
        startAt: "2026-05-12T17:00:00.000Z",
        endAt: "2026-05-12T18:00:00.000Z",
      },
    })),
    updateEvent: vi.fn(async () => ({ ok: false, error: "not_found" })),
    deleteEvent: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function runtimeWithRegistry(canRequest = true) {
  const recordBlock = vi.fn();
  return {
    recordBlock,
    runtime: {
      getService: vi.fn(() => ({
        recordBlock,
        get: vi.fn(() => ({ canRequest })),
      })),
    },
  };
}

afterEach(() => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
});

describe("native Apple Calendar bridge dylib candidates", () => {
  it("keeps packaged and local bridge candidates available", () => {
    const candidatePaths = __testing
      .nativeDylibCandidates()
      .map((candidate) => candidate.path);

    expect(candidatePaths).toContain(
      "../../../../../../../libMacWindowEffects.dylib",
    );
    expect(candidatePaths).toContain(
      "../../../../packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib",
    );
  });
});

describe("listNativeAppleCalendars", () => {
  it("maps native calendars into LifeOps Apple Calendar summaries", async () => {
    __testing.setNativeCalendarBridgeForTest(
      bridge({
        listCalendars: vi.fn(async () => ({
          ok: true,
          calendars: [
            {
              calendarId: "cal-1",
              summary: "Home",
              primary: true,
              accessRole: "writer",
            },
          ],
        })),
      }) as never,
    );

    const result = await listNativeAppleCalendars({ agentId: "agent-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({
      provider: APPLE_CALENDAR_PROVIDER,
      grantId: APPLE_CALENDAR_GRANT_ID,
      calendarId: "cal-1",
      summary: "Home",
      includeInFeed: true,
      selectionVersion: 0,
    });
  });
});

describe("getNativeAppleCalendarFeed", () => {
  it("maps native events into LifeOps Apple Calendar events", async () => {
    __testing.setNativeCalendarBridgeForTest(
      bridge({
        listEvents: vi.fn(async () => ({
          ok: true,
          events: [
            {
              id: "event-1",
              externalId: "event-1",
              calendarId: "cal-1",
              calendarSummary: "Home",
              title: "Dentist",
              availability: "free",
              startAt: "2026-05-12T17:00:00.000Z",
              endAt: "2026-05-12T18:00:00.000Z",
              attendees: [],
            },
          ],
        })),
      }) as never,
    );

    const result = await getNativeAppleCalendarFeed({
      agentId: "agent-1",
      calendarId: "cal-1",
      timeMin: "2026-05-12T00:00:00.000Z",
      timeMax: "2026-05-13T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.events[0]).toMatchObject({
      provider: APPLE_CALENDAR_PROVIDER,
      grantId: APPLE_CALENDAR_GRANT_ID,
      externalId: "event-1",
      calendarId: "cal-1",
      title: "Dentist",
      metadata: {
        appleCalendar: true,
        appleAvailability: "free",
        transparency: "transparent",
      },
    });
    expect(result.data.sources[0]).toMatchObject({
      accessRole: "writer",
      visibility: "details",
    });
  });
});

describe("createNativeAppleCalendarEvent", () => {
  it("preserves the exact writable calendar id through a full-access create receipt", async () => {
    const createEvent = vi.fn(async () => ({
      ok: true,
      event: {
        id: "event-1",
        externalId: "event-1",
        calendarId: "eventkit-default-calendar-id",
        title: "Dentist",
        startAt: "2026-05-12T17:00:00.000Z",
        endAt: "2026-05-12T18:00:00.000Z",
        attendees: [],
      },
      receipt: {
        accessLevel: "full_access",
        destination: "resolved_calendar",
        eventId: "event-1",
        readBackAvailable: true,
      },
    }));
    __testing.setNativeCalendarBridgeForTest(bridge({ createEvent }) as never);

    const result = await createNativeAppleCalendarEvent({
      agentId: "agent-1",
      request: {
        calendarId: "eventkit-default-calendar-id",
        title: "Dentist",
        startAt: "2026-05-12T17:00:00.000Z",
        endAt: "2026-05-12T18:00:00.000Z",
      },
    });

    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "eventkit-default-calendar-id",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        kind: "event",
        event: {
          provider: "apple_calendar",
          calendarId: "eventkit-default-calendar-id",
          externalId: "event-1",
        },
      },
    });
  });

  it("returns an explicit non-readable receipt for add-only access", async () => {
    __testing.setNativeCalendarBridgeForTest(
      bridge({
        checkPermissions: vi.fn(async () => ({
          calendar: "write_only",
          canRequest: false,
        })),
        createEvent: vi.fn(async () => ({
          ok: true,
          receipt: {
            accessLevel: "write_only",
            destination: "default_calendar",
            eventId: null,
            readBackAvailable: false,
          },
        })),
      }) as never,
    );

    const result = await createNativeAppleCalendarEvent({
      agentId: "agent-1",
      request: {
        calendarId: "primary",
        title: "Dentist",
        startAt: "2026-05-12T17:00:00.000Z",
        endAt: "2026-05-12T18:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        kind: "accepted_without_readback",
        receipt: {
          provider: "apple_calendar",
          calendarId: "primary",
          accessLevel: "write_only",
          providerEventId: null,
          readBackAvailable: false,
        },
      },
    });
  });

  it("records a calendar permission block on native permission denial", async () => {
    __testing.setNativeCalendarBridgeForTest(
      bridge({
        createEvent: vi.fn(async () => ({
          ok: false,
          error: "permission",
          message: "Calendar denied.",
        })),
      }) as never,
    );
    const { runtime, recordBlock } = runtimeWithRegistry(false);

    const result = await createNativeAppleCalendarEvent({
      agentId: "agent-1",
      runtime: runtime as never,
      request: {
        title: "Dentist",
        startAt: "2026-05-12T17:00:00.000Z",
        endAt: "2026-05-12T18:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "permission",
      permission: "calendar",
      canRequest: false,
    });
    expect(recordBlock).toHaveBeenCalledWith("calendar", {
      app: "lifeops",
      action: "calendar.create",
    });
  });

  it("returns native_error instead of silently dropping unsupported attendees", async () => {
    __testing.setNativeCalendarBridgeForTest(
      bridge({
        createEvent: vi.fn(async () => ({
          ok: false,
          error: "unsupported_feature",
          message: "Apple Calendar does not support attendees.",
        })),
      }) as never,
    );

    const result = await createNativeAppleCalendarEvent({
      agentId: "agent-1",
      request: {
        title: "Dentist",
        startAt: "2026-05-12T17:00:00.000Z",
        endAt: "2026-05-12T18:00:00.000Z",
        attendees: [{ email: "pat@example.com" }],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "native_error",
      message: "Apple Calendar does not support attendees.",
    });
  });
});
