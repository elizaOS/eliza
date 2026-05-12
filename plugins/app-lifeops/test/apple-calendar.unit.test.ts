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
} from "../src/lifeops/apple-calendar.js";

function bridge(overrides = {}) {
  return {
    platform: "darwin",
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
    });
  });
});

describe("createNativeAppleCalendarEvent", () => {
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
