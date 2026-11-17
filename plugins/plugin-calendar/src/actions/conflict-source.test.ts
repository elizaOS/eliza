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
it("lets a write through when only another calendar is unreadable, without calling the slot free", async () => {
  const source = (grantId: string, status: "fresh" | "error") => ({
    key: {
      provider: grantId === "eliza-calendar" ? "eliza" : "google",
      side: "owner",
      grantId,
      connectorAccountId: grantId,
      calendarId: "primary",
    },
    status,
    visibility: "details",
    summary: grantId,
    error: status === "fresh" ? null : { message: "Source unavailable" },
  });
  const check = (statuses: ["fresh" | "error", "fresh" | "error"]) =>
    evaluateCalendarWriteAvailability({
      runtime: {
        getService: () => ({
          getCalendarFeed: async () => ({
            calendarId: "primary",
            events: [],
            source: "synced",
            state: "partial",
            syncedAt: start,
            sources: [
              source("eliza-calendar", statuses[0]),
              source("connector-account:linked", statuses[1]),
            ],
          }),
        }),
      } as never,
      destination: { grantId: "eliza-calendar", calendarId: "primary" },
      startAt: start,
      endAt: end,
      timeZone: "UTC",
    });
  expect(await check(["fresh", "error"])).toMatchObject({
    writable: true,
    definitive: false,
  });
  expect(await check(["error", "fresh"])).toMatchObject({
    writable: false,
    definitive: false,
  });
});
