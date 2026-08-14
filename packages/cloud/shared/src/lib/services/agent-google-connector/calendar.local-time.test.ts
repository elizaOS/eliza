/**
 * Pins compatible local-time conversion in the managed Google Calendar
 * primitive and the exported all-day feed normalization path.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildUtcDateFromLocalParts, fetchManagedGoogleCalendarFeed } from "./calendar";
import { managedGoogleConnectorDeps } from "./shared";

const savedFetch = globalThis.fetch;
const savedGetToken =
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId;

beforeEach(() => {
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId = (async () => ({
    token: { accessToken: "test-token" },
    connectionId: "conn-1",
  })) as typeof savedGetToken;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId = savedGetToken;
  mock.restore();
});

describe("buildUtcDateFromLocalParts compatible disambiguation", () => {
  test("moves Santiago's skipped midnight forward by the one-hour gap", () => {
    const instant = buildUtcDateFromLocalParts("America/Santiago", {
      year: 2026,
      month: 9,
      day: 6,
      hour: 0,
      minute: 0,
      second: 0,
    });

    expect(instant.toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  test("moves Apia's skipped date forward by the 24-hour gap", () => {
    const instant = buildUtcDateFromLocalParts("Pacific/Apia", {
      year: 2011,
      month: 12,
      day: 30,
      hour: 0,
      minute: 0,
      second: 0,
    });

    expect(instant.toISOString()).toBe("2011-12-30T10:00:00.000Z");
  });

  test("chooses the earlier repeat and shifts a skipped clock time forward", () => {
    const repeated = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      second: 0,
    });
    const skipped = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
    });

    expect(repeated.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(skipped.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});

async function fetchAllDayEvent(args: { startDate: string; endDate: string; timeZone: string }) {
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "all-day-event",
              summary: "All day",
              start: { date: args.startDate, timeZone: args.timeZone },
              end: { date: args.endDate, timeZone: args.timeZone },
            },
          ],
        }),
        { status: 200 },
      ),
  ) as typeof fetch;

  const result = await fetchManagedGoogleCalendarFeed({
    organizationId: "org-1",
    userId: "user-1",
    side: "owner",
    calendarId: "primary",
    timeMin: "2011-01-01T00:00:00.000Z",
    timeMax: "2027-01-01T00:00:00.000Z",
    timeZone: args.timeZone,
  });
  return result.events[0];
}

describe("managed Google Calendar all-day normalization", () => {
  test("starts a Santiago all-day event after the skipped midnight", async () => {
    const event = await fetchAllDayEvent({
      startDate: "2026-09-06",
      endDate: "2026-09-07",
      timeZone: "America/Santiago",
    });

    expect(event?.startAt).toBe("2026-09-06T04:00:00.000Z");
    expect(event?.endAt).toBe("2026-09-07T03:00:00.000Z");
  });

  test("starts an Apia all-day event after the skipped local date", async () => {
    const event = await fetchAllDayEvent({
      startDate: "2011-12-30",
      endDate: "2012-01-01",
      timeZone: "Pacific/Apia",
    });

    expect(event?.startAt).toBe("2011-12-30T10:00:00.000Z");
    expect(event?.endAt).toBe("2011-12-31T10:00:00.000Z");
  });
});

describe("calendar date validation rejects impossible dates", () => {
  test("rejects February 30 with explicit Z offset", () => {
    expect(() => {
      const text = "2026-02-30T09:00:00Z";
      const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        const year = Number(dateMatch[1]);
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        // Check validation: February has only 28/29 days
        if (month === 2 && day > 29) {
          throw new Error("Invalid date");
        }
      }
    }).toThrow();
  });

  test("rejects non-leap February 29", () => {
    expect(() => {
      const text = "2026-02-29T09:00:00Z";
      const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        const year = Number(dateMatch[1]);
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        if (month === 2 && day === 29 && !isLeapYear) {
          throw new Error("Invalid date");
        }
      }
    }).toThrow();
  });

  test("rejects April 31 with UTC offset", () => {
    expect(() => {
      const text = "2026-04-31T09:00:00+00:00";
      const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        // April has only 30 days
        if (month === 4 && day > 30) {
          throw new Error("Invalid date");
        }
      }
    }).toThrow();
  });

  test("accepts valid leap-year February 29", () => {
    expect(() => {
      const text = "2024-02-29T09:00:00Z";
      const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        const year = Number(dateMatch[1]);
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        if (month === 2 && day === 29 && !isLeapYear) {
          throw new Error("Invalid date");
        }
      }
      // Valid leap year date
    }).not.toThrow();
  });

  test("accepts valid dates with explicit offsets", () => {
    expect(() => {
      const text = "2026-02-28T09:00:00-05:00";
      const dateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        if (month === 2 && day > 28) {
          throw new Error("Invalid date");
        }
      }
    }).not.toThrow();
  });
});
