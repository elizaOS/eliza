/**
 * Calendar connector truth-boundary tests exercise paging, incremental-sync
 * failures, privacy-preserving availability, attendee fidelity, and explicit
 * attendee notification policy against deterministic Google API responses.
 */
import type { calendar_v3 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient, GoogleCalendarSyncTokenExpiredError } from "./calendar";
import type { GoogleApiClientFactory } from "./client-factory";

function clientFor(calendar: object): GoogleCalendarClient {
  const factory = {
    calendar: vi.fn(async () => calendar),
  } as unknown as GoogleApiClientFactory;
  return new GoogleCalendarClient(factory);
}

function event(id: string): calendar_v3.Schema$Event {
  return {
    id,
    summary: id,
    start: { dateTime: "2026-08-01T09:00:00-07:00" },
    end: { dateTime: "2026-08-01T10:00:00-07:00" },
  };
}

describe("GoogleCalendarClient truth adapter", () => {
  it("creates and stops account-scoped event channels with the provider channel contract", async () => {
    const expiration = Date.now() + 3_600_000;
    const events = {
      watch: vi.fn(async () => ({
        data: {
          id: "channel-1",
          resourceId: "resource-1",
          resourceUri: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          token: "capability-token",
          expiration: String(expiration),
        },
      })),
    };
    const channels = {
      stop: vi.fn(async () => ({ data: {} })),
    };
    const client = clientFor({ events, channels });

    await expect(
      client.watchEvents({
        accountId: "acct-1",
        calendarId: "primary",
        channelId: "channel-1",
        address: "https://calendar.example.test/api/lifeops/calendar/google/webhook",
        token: "capability-token",
        ttlSeconds: 3600,
      })
    ).resolves.toEqual({
      channelId: "channel-1",
      resourceId: "resource-1",
      resourceUri: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      token: "capability-token",
      expirationAt: new Date(expiration).toISOString(),
    });
    expect(events.watch).toHaveBeenCalledWith({
      calendarId: "primary",
      requestBody: {
        id: "channel-1",
        type: "web_hook",
        address: "https://calendar.example.test/api/lifeops/calendar/google/webhook",
        token: "capability-token",
        params: { ttl: "3600" },
      },
    });

    await client.stopCalendarChannel({
      accountId: "acct-1",
      channelId: "channel-1",
      resourceId: "resource-1",
    });
    expect(channels.stop).toHaveBeenCalledWith({
      requestBody: {
        id: "channel-1",
        resourceId: "resource-1",
      },
    });
  });

  it("rejects private callback targets and provider TTL overflow before channel creation", async () => {
    const watch = vi.fn();
    const client = clientFor({ events: { watch } });
    const baseRequest = {
      accountId: "acct-1",
      calendarId: "primary",
      channelId: "channel-1",
      token: "capability-token",
      ttlSeconds: 3600,
    };

    await expect(
      client.watchEvents({
        ...baseRequest,
        address: "https://127.0.0.1/api/lifeops/calendar/google/webhook",
      })
    ).rejects.toMatchObject({
      code: "GOOGLE_CALENDAR_INVALID_WATCH_ADDRESS",
    });
    await expect(
      client.watchEvents({
        ...baseRequest,
        address: "https://calendar.example.test/api/lifeops/calendar/google/webhook",
        ttlSeconds: 604_801,
      })
    ).rejects.toMatchObject({
      code: "GOOGLE_CALENDAR_INVALID_REQUEST",
    });
    expect(watch).not.toHaveBeenCalled();
  });

  it("exhausts calendar and event pages while page DTOs retain continuation tokens", async () => {
    const calendarList = {
      list: vi.fn(async (request: calendar_v3.Params$Resource$Calendarlist$List) => ({
        data: request.pageToken
          ? {
              items: [{ id: "family", summary: "Family" }],
              nextSyncToken: "calendar-sync-2",
            }
          : {
              items: [{ id: "primary", summary: "Owner", primary: true }],
              nextPageToken: "calendar-page-2",
            },
      })),
    };
    const events = {
      list: vi.fn(async (request: calendar_v3.Params$Resource$Events$List) => ({
        data: request.pageToken
          ? { items: [event("event-2")], nextSyncToken: "event-sync-2" }
          : { items: [event("event-1")], nextPageToken: "event-page-2" },
      })),
    };
    const client = clientFor({ calendarList, events });

    await expect(client.listCalendars({ accountId: "acct-1" })).resolves.toMatchObject([
      { calendarId: "primary", summary: "Owner" },
      { calendarId: "family", summary: "Family" },
    ]);
    await expect(client.listEvents({ accountId: "acct-1", limit: 1 })).resolves.toMatchObject([
      { id: "event-1" },
      { id: "event-2" },
    ]);

    expect(calendarList.list).toHaveBeenCalledTimes(2);
    expect(calendarList.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: "calendar-page-2" })
    );
    expect(events.list).toHaveBeenCalledTimes(2);
    expect(events.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: "event-page-2" })
    );

    await expect(
      client.listCalendarPage({
        accountId: "acct-1",
        pageToken: "calendar-page-2",
        maxResults: 50,
      })
    ).resolves.toMatchObject({
      nextPageToken: null,
      nextSyncToken: "calendar-sync-2",
    });
    await expect(
      client.listEventPage({
        accountId: "acct-1",
        pageToken: "event-page-2",
        maxResults: 50,
      })
    ).resolves.toMatchObject({
      nextPageToken: null,
      nextSyncToken: "event-sync-2",
    });
  });

  it("preserves attendee state, transparency, and visibility as first-class fields", async () => {
    const events = {
      list: vi.fn(async () => ({
        data: {
          items: [
            {
              ...event("guest-event"),
              transparency: "transparent",
              visibility: "private",
              attendees: [
                {
                  email: "owner@example.com",
                  displayName: "Owner",
                  responseStatus: "accepted",
                  self: true,
                  organizer: true,
                  optional: false,
                },
                {
                  email: "guest@example.net",
                  displayName: "Guest",
                  responseStatus: "tentative",
                  self: false,
                  organizer: false,
                  optional: true,
                },
              ],
            },
          ],
        },
      })),
    };
    const client = clientFor({ events });

    const page = await client.listEventPage({ accountId: "acct-1" });

    expect(page.events[0]).toMatchObject({
      transparency: "transparent",
      visibility: "private",
      attendees: [
        {
          email: "owner@example.com",
          name: "Owner",
          responseStatus: "accepted",
          self: true,
          organizer: true,
          optional: false,
        },
        {
          email: "guest@example.net",
          name: "Guest",
          responseStatus: "tentative",
          self: false,
          organizer: false,
          optional: true,
        },
      ],
    });
  });

  it("returns busy-only guest availability without event content or group membership", async () => {
    const freebusy = {
      query: vi.fn(async () => ({
        data: {
          calendars: {
            "guest@example.net": {
              busy: [
                {
                  start: "2026-08-01T16:00:00.000Z",
                  end: "2026-08-01T17:00:00.000Z",
                },
              ],
              errors: [],
            },
            "unrequested-private-calendar@example.net": {
              busy: [
                {
                  start: "2026-08-01T18:00:00.000Z",
                  end: "2026-08-01T19:00:00.000Z",
                },
              ],
            },
          },
          groups: {
            "family@example.net": {
              calendars: ["private-member@example.net"],
            },
          },
        },
      })),
    };
    const client = clientFor({ freebusy });

    const result = await client.queryFreeBusy({
      accountId: "acct-1",
      timeMin: "2026-08-01T00:00:00.000Z",
      timeMax: "2026-08-02T00:00:00.000Z",
      calendarIds: ["guest@example.net"],
    });

    expect(result).toEqual({
      timeMin: "2026-08-01T00:00:00.000Z",
      timeMax: "2026-08-02T00:00:00.000Z",
      calendars: {
        "guest@example.net": {
          busy: [
            {
              start: "2026-08-01T16:00:00.000Z",
              end: "2026-08-01T17:00:00.000Z",
            },
          ],
          errors: [],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-member@example.net");
    expect(JSON.stringify(result)).not.toContain("unrequested-private-calendar@example.net");
  });

  it("turns an expired list or event sync token into a typed full-resync signal", async () => {
    const expired = { response: { status: 410 } };
    const calendarList = {
      list: vi.fn(async () => Promise.reject(expired)),
    };
    const events = {
      list: vi.fn(async () => Promise.reject(expired)),
    };
    const client = clientFor({
      calendarList,
      events,
    });

    await expect(
      client.listCalendarPage({
        accountId: "acct-1",
        syncToken: "expired-calendar-token",
      })
    ).rejects.toBeInstanceOf(GoogleCalendarSyncTokenExpiredError);
    await expect(
      client.listCalendarPage({
        accountId: "acct-1",
        syncToken: "expired-calendar-token",
      })
    ).rejects.toMatchObject({
      name: "GoogleCalendarSyncTokenExpiredError",
      code: "GOOGLE_CALENDAR_SYNC_TOKEN_EXPIRED",
      resource: "calendarList",
      cause: expired,
    });

    await expect(
      client.listEventPage({
        accountId: "acct-1",
        calendarId: "family",
        syncToken: "expired-event-token",
      })
    ).rejects.toBeInstanceOf(GoogleCalendarSyncTokenExpiredError);
    await expect(
      client.listEventPage({
        accountId: "acct-1",
        calendarId: "family",
        syncToken: "expired-event-token",
      })
    ).rejects.toMatchObject({
      name: "GoogleCalendarSyncTokenExpiredError",
      code: "GOOGLE_CALENDAR_SYNC_TOKEN_EXPIRED",
      resource: "events",
      cause: expired,
    });

    expect(calendarList.list).toHaveBeenLastCalledWith({
      syncToken: "expired-calendar-token",
      showDeleted: true,
      showHidden: true,
    });
    expect(events.list).toHaveBeenLastCalledWith({
      calendarId: "family",
      syncToken: "expired-event-token",
      singleEvents: true,
      showDeleted: true,
    });
  });

  it("always sends an explicit attendee notification policy for mutations", async () => {
    const events = {
      insert: vi.fn(async () => ({ data: event("created") })),
      patch: vi.fn(async () => ({ data: event("updated") })),
      delete: vi.fn(async () => ({ data: {} })),
    };
    const client = clientFor({ events });

    await client.createEvent({
      accountId: "acct-1",
      title: "Created",
      start: "2026-08-01T16:00:00.000Z",
      end: "2026-08-01T17:00:00.000Z",
      sendUpdates: "all",
    });
    await client.updateEvent({
      accountId: "acct-1",
      eventId: "updated",
      title: "Updated",
      sendUpdates: "externalOnly",
    });
    await client.deleteEvent({
      accountId: "acct-1",
      eventId: "deleted",
    });

    expect(events.insert).toHaveBeenCalledWith(expect.objectContaining({ sendUpdates: "all" }));
    expect(events.patch).toHaveBeenCalledWith(
      expect.objectContaining({ sendUpdates: "externalOnly" })
    );
    expect(events.delete).toHaveBeenCalledWith(expect.objectContaining({ sendUpdates: "none" }));
  });
});
