import { describe, expect, test, vi } from "vitest";

import { withCalendar } from "../src/lifeops/service-mixin-calendar.js";
import { LifeOpsServiceError } from "../src/lifeops/service-types.js";

class StubBase {
  repository = {
    getCalendarSyncState: vi.fn(async () => ({
      calendarId: "primary",
      provider: "google",
      side: "owner",
      syncedAt: "2025-01-01T00:00:00.000Z",
      windowStartAt: "2025-01-01T00:00:00.000Z",
      windowEndAt: "2025-01-02T00:00:00.000Z",
    })),
    listCalendarEvents: vi.fn(async () => [
      {
        id: "cached-event",
        calendarId: "primary",
        provider: "google",
        title: "Cached Event",
        startAt: "2025-01-01T10:00:00.000Z",
        endAt: "2025-01-01T11:00:00.000Z",
        timeZone: "UTC",
      },
    ]),
  };

  agentId(): string {
    return "calendar-auth-test-agent";
  }

  logLifeOpsWarn = vi.fn();
}

const CalendarService = withCalendar(StubBase as never);
type CalendarServiceInstance = StubBase & {
  getCalendarFeed: (requestUrl: URL, request: Record<string, unknown>) => Promise<unknown>;
  requireGoogleCalendarGrant: ReturnType<typeof vi.fn>;
  syncGoogleCalendarFeed: ReturnType<typeof vi.fn>;
};

describe("calendar feed auth failures", () => {
  test("does not return cached events after Google sync returns 401", async () => {
    const ServiceCtor = CalendarService as unknown as new () => CalendarServiceInstance;
    const service = new ServiceCtor();
    service.requireGoogleCalendarGrant = vi.fn(async () => ({
      id: "grant-1",
      provider: "google",
      side: "owner",
      mode: "local",
      tokenRef: "token-ref",
      identity: { email: "owner@example.com" },
      capabilities: ["google.calendar.read"],
    }));
    service.syncGoogleCalendarFeed = vi.fn(async () => {
      throw new LifeOpsServiceError(401, "Google Calendar requires reauthorization.");
    });

    await expect(
      service.getCalendarFeed(new URL("http://127.0.0.1:31337"), {
        calendarId: "primary",
        forceSync: true,
        grantId: "grant-1",
        timeMax: "2025-01-02T00:00:00.000Z",
        timeMin: "2025-01-01T00:00:00.000Z",
        timeZone: "UTC",
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: "Google Calendar requires reauthorization.",
    });
    expect(service.repository.listCalendarEvents).not.toHaveBeenCalled();
    expect(service.logLifeOpsWarn).not.toHaveBeenCalledWith(
      "calendar_feed_cache_fallback",
      expect.any(String),
      expect.any(Object),
    );
  });
});
