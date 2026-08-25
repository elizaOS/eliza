/**
 * `listEvents`/`listCalendars` drain pages via `nextPageToken`, which must
 * terminate when the Google Calendar API (or a misbehaving proxy)
 * repeats a page token. Mirrors the
 * equivalent Google Meet pagination coverage in
 * `meet.canonical-artifact.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient } from "./calendar";
import type { GoogleApiClientFactory } from "./client-factory";

function clientFor(calendar: object): GoogleCalendarClient {
  const factory = {
    calendar: vi.fn(async () => calendar),
  } as unknown as GoogleApiClientFactory;
  return new GoogleCalendarClient(factory);
}

describe("listEvents pagination", () => {
  it("drains pages until the API stops returning a next cursor", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [{ id: "e1" }], nextPageToken: "c1" } })
      .mockResolvedValueOnce({ data: { items: [{ id: "e2" }], nextPageToken: "c2" } })
      .mockResolvedValueOnce({ data: { items: [{ id: "e3" }] } });
    const client = clientFor({ events: { list } });

    const events = await client.listEvents({ accountId: "acct-1" });

    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: "c1" }));
    expect(list).toHaveBeenNthCalledWith(3, expect.objectContaining({ pageToken: "c2" }));
  });

  it("rejects a repeated event-list page token instead of looping forever", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [{ id: "e1" }], nextPageToken: "stuck" } })
      .mockResolvedValueOnce({ data: { items: [{ id: "e2" }], nextPageToken: "stuck" } });
    const client = clientFor({ events: { list } });

    await expect(client.listEvents({ accountId: "acct-1" })).rejects.toMatchObject({
      code: "GOOGLE_CALENDAR_PAGINATION_LOOP",
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("accepts a terminal response beyond the former fixed page ceiling", async () => {
    let page = 0;
    const list = vi.fn(async () => {
      page += 1;
      return {
        data: {
          items: page === 1_001 ? [{ id: "last-event" }] : [],
          ...(page < 1_001 && { nextPageToken: `unique-token-${page}` }),
        },
      };
    });
    const client = clientFor({ events: { list } });

    await expect(client.listEvents({ accountId: "acct-1" })).resolves.toMatchObject([
      { id: "last-event" },
    ]);
    expect(list).toHaveBeenCalledTimes(1_001);
  });
});

describe("listCalendars pagination", () => {
  it("drains pages until the API stops returning a next cursor", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [{ id: "cal-1" }], nextPageToken: "c1" } })
      .mockResolvedValueOnce({ data: { items: [{ id: "cal-2" }] } });
    const client = clientFor({ calendarList: { list } });

    const calendars = await client.listCalendars({ accountId: "acct-1" });

    expect(calendars.map((c) => c.calendarId)).toEqual(["cal-1", "cal-2"]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: "c1" }));
  });

  it("accepts a calendar beyond the former fixed page ceiling", async () => {
    let page = 0;
    const list = vi.fn(async () => {
      page += 1;
      return {
        data: {
          items: page === 1_001 ? [{ id: "late-calendar" }] : [],
          ...(page < 1_001 && { nextPageToken: `unique-token-${page}` }),
        },
      };
    });
    const client = clientFor({ calendarList: { list } });

    await expect(client.listCalendars({ accountId: "acct-1" })).resolves.toMatchObject([
      { calendarId: "late-calendar" },
    ]);
    expect(list).toHaveBeenCalledTimes(1_001);
  });
});
