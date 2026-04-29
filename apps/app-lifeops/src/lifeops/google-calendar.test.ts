import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleCalendarEvents } from "./google-calendar.js";

function googleEvent(id: string, startAt: string) {
  return {
    id,
    status: "confirmed",
    summary: `Event ${id}`,
    start: { dateTime: startAt },
    end: { dateTime: new Date(Date.parse(startAt) + 3_600_000).toISOString() },
  };
}

describe("fetchGoogleCalendarEvents", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("follows Google Calendar pagination until nextPageToken is exhausted", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      const pageToken = new URL(url).searchParams.get("pageToken");
      return new Response(
        JSON.stringify(
          pageToken === "page-2"
            ? {
                items: [googleEvent("event-2", "2026-04-23T16:00:00.000Z")],
              }
            : {
                nextPageToken: "page-2",
                items: [googleEvent("event-1", "2026-04-23T15:00:00.000Z")],
              },
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const events = await fetchGoogleCalendarEvents({
      accessToken: "token",
      calendarId: "primary",
      timeMin: "2026-04-23T00:00:00.000Z",
      timeMax: "2026-04-24T00:00:00.000Z",
      timeZone: "UTC",
    });

    expect(events.map((event) => event.externalId)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get("maxResults")).toBe("2500");
    expect(new URL(urls[0]).searchParams.get("pageToken")).toBeNull();
    expect(new URL(urls[1]).searchParams.get("pageToken")).toBe("page-2");
  });
});
