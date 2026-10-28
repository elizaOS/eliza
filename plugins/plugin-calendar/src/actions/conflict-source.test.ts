import { expect, it } from "vitest";
import { evaluateCalendarWriteAvailability } from "./conflict-detect.js";

const start = "2026-10-14T18:00:00Z",
  end = "2026-10-14T18:02:00Z";
function runtime(owner: string, events: unknown[] = []) {
  const requests: unknown[] = [];
  return {
    requests,
    host: {
      getService: () => ({
        getCalendarFeed: async (
          _url: URL,
          request: { grantId?: string; calendarId?: string },
        ) => {
          requests.push(request);
          const exact =
            request.grantId === owner + "-grant" &&
            request.calendarId === owner + "-calendar";
          return {
            calendarId: request.calendarId,
            events: exact ? events : [],
            source: "synced",
            state: exact ? "complete" : "unavailable",
            syncedAt: start,
            sources: [
              {
                key: {
                  provider: "google",
                  side: "owner",
                  grantId: owner + "-grant",
                  connectorAccountId: owner + "-grant",
                  calendarId: owner + "-calendar",
                },
                status: exact ? "fresh" : "error",
                visibility: "details",
                summary: "Owner calendar",
                error: exact ? null : { message: "Source unavailable" },
              },
            ],
          };
        },
      }),
    } as never,
  };
}
it("checks the explicit destination even when no calendars are selected in the merged feed", async () => {
  const { host, requests } = runtime("one");
  const result = await evaluateCalendarWriteAvailability({
    runtime: host,
    grantId: "one-grant",
    calendarId: "one-calendar",
    startAt: start,
    endAt: end,
    timeZone: "UTC",
  });
  expect(result.definitive).toBe(true);
  expect(result.conflicts).toHaveLength(0);
  expect(requests[0]).toMatchObject({
    grantId: "one-grant",
    calendarId: "one-calendar",
    timeZone: "UTC",
  });
});
it("never reports another owner source as available", async () => {
  const { host } = runtime("two");
  const result = await evaluateCalendarWriteAvailability({
    runtime: host,
    grantId: "one-grant",
    calendarId: "one-calendar",
    startAt: start,
    endAt: end,
    timeZone: "UTC",
  });
  expect(result.definitive).toBe(false);
});
it("still refuses overlapping commitments on the selected source", async () => {
  const event = {
    id: "event",
    title: "Busy",
    startAt: start,
    endAt: end,
    isAllDay: false,
    timezone: "UTC",
    status: "confirmed",
    attendees: [],
    metadata: {},
    provider: "google",
    side: "owner",
    grantId: "one-grant",
    connectorAccountId: "one-grant",
    calendarId: "one-calendar",
  };
  const { host } = runtime("one", [event]);
  const result = await evaluateCalendarWriteAvailability({
    runtime: host,
    grantId: "one-grant",
    calendarId: "one-calendar",
    startAt: start,
    endAt: end,
    timeZone: "UTC",
  });
  expect(result.definitive).toBe(true);
  expect(result.conflicts.length).toBeGreaterThan(0);
});
