/**
 * Reviewed foreground free/busy reads over a synthetic device calendar that
 * holds titles and unrelated calendars. No device calendar, permission dialog or
 * agent is exercised.
 */
import { describe, expect, it } from "vitest";
import {
  type AvailabilityProvider,
  type AvailabilityReview,
  executeCalendarAvailability,
  parseAvailabilityEvents,
  parseAvailabilitySources,
} from "../../src/client/availability-review.ts";

const ZONE = "America/New_York";
// 2026-10-13 is a Tuesday; New York is UTC-4. The window is the whole local day.
const day = {
  type: "calendar_availability" as const,
  start: "2026-10-13T04:00:00.000Z",
  end: "2026-10-14T04:00:00.000Z",
  timeZone: ZONE,
};
const rev = (letter: string) => letter.repeat(64);
type Row = {
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  availability: "busy" | "free" | "tentative";
};

function fixture() {
  const state = {
    permission: "granted",
    freshness: "local",
    extraField: false,
    reads: 0,
    calendars: [
      {
        id: "1",
        name: "WORK",
        account: "owner@work.example",
        sourceRevision: rev("a"),
      },
      {
        id: "2",
        name: "UNRELATED",
        account: "partner@else.example",
        sourceRevision: rev("b"),
      },
    ],
    rows: [
      {
        calendarId: "1",
        title: "SECRET_STANDUP",
        start: "2026-10-13T13:00:00.000Z",
        end: "2026-10-13T13:30:00.000Z",
        allDay: false,
        availability: "busy",
      },
      {
        calendarId: "1",
        title: "SECRET_FOCUS",
        start: "2026-10-13T19:00:00.000Z",
        end: "2026-10-13T20:00:00.000Z",
        allDay: false,
        availability: "free",
      },
      {
        calendarId: "1",
        title: "SECRET_MAYBE",
        start: "2026-10-13T21:00:00.000Z",
        end: "2026-10-13T22:00:00.000Z",
        allDay: false,
        availability: "tentative",
      },
      {
        calendarId: "2",
        title: "PARTNER",
        start: "2026-10-13T15:00:00.000Z",
        end: "2026-10-13T16:00:00.000Z",
        allDay: false,
        availability: "busy",
      },
    ] as Row[],
  };
  const provider: AvailabilityProvider = {
    requestWorkflowReadAccess: async () => ({ status: state.permission }),
    availabilitySources: async (input) => ({
      status: "ready",
      timeZone: input.timeZone,
      calendars: structuredClone(state.calendars),
    }),
    readAvailability: async (input) => {
      state.reads++;
      for (const chosen of input.calendars)
        if (
          state.calendars.find((item) => item.id === chosen.id)
            ?.sourceRevision !== chosen.revision
        )
          return { status: "changed" };
      const ids = new Set(input.calendars.map((item) => item.id));
      return {
        status: "ready",
        freshness: state.freshness,
        events: state.rows
          .filter((row) => ids.has(row.calendarId))
          .map((row) => ({
            start: row.start,
            end: row.end,
            allDay: row.allDay,
            availability: row.availability,
            ...(state.extraField ? { title: row.title } : {}),
          })),
      };
    },
  };
  return { state, provider };
}

function reviews(choice: string[] | null, after?: () => void) {
  const seen = { offered: [] as string[] };
  const review: AvailabilityReview = {
    chooseCalendars: async (sources, _op, _signal, current) => {
      current();
      seen.offered = sources.map((source) => source.name);
      return choice;
    },
    confirmResult: async (_result, _chosen, _signal, current) => {
      current();
      after?.();
      return true;
    },
  };
  return { seen, review };
}

const run = (
  provider: AvailabilityProvider,
  review: AvailabilityReview,
  device = ZONE,
) =>
  executeCalendarAvailability(
    provider,
    day,
    ZONE,
    new AbortController().signal,
    () => {},
    review,
    () => device,
    async () => {},
  );

describe("executeCalendarAvailability", () => {
  it("shares only busy intervals of the chosen calendars; free entries are not busy, tentative counts", async () => {
    const { provider, state } = fixture();
    const { review, seen } = reviews(["1"]);
    const outcome = await run(provider, review);
    expect(outcome.status).toBe("succeeded");
    expect(seen.offered).toEqual(["WORK", "UNRELATED"]);
    const text = JSON.stringify(outcome);
    for (const secret of ["SECRET", "PARTNER", "WORK", "owner@"])
      expect(text).not.toContain(secret);
    expect(outcome.foregroundResult?.status).toBe("busy");
    expect(outcome.foregroundResult?.busy).toHaveLength(2);
    expect(outcome.summary).toMatch(/1 event marked free was ignored/);
    expect(state.reads).toBe(2);
  });

  it("refuses a result whose calendar changed between review and sharing", async () => {
    const { provider, state } = fixture();
    const { review } = reviews(["1"], () => {
      state.rows.push({
        calendarId: "1",
        title: "LATE",
        start: "2026-10-13T17:00:00.000Z",
        end: "2026-10-13T18:00:00.000Z",
        allDay: false,
        availability: "busy",
      });
    });
    const outcome = await run(provider, review);
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toMatch(/changed during this review/);
    expect(outcome.foregroundResult).toBeUndefined();
  });

  it("treats unknown freshness, denial, zone changes and cancellation as nothing shared", async () => {
    const stale = fixture();
    stale.state.freshness = "remote";
    expect((await run(stale.provider, reviews(["1"]).review)).summary).toMatch(
      /availability is unknown\. Nothing was shared\.$/,
    );
    const denied = fixture();
    denied.state.permission = "denied";
    expect((await run(denied.provider, reviews(["1"]).review)).summary).toMatch(
      /not allowed/,
    );
    const moved = fixture();
    expect(
      (await run(moved.provider, reviews(["1"]).review, "Europe/Paris"))
        .summary,
    ).toMatch(/different time zone/);
    const cancelled = fixture();
    const outcome = await run(cancelled.provider, reviews(null).review);
    expect(outcome.summary).toMatch(/cancelled\. No calendar was read/);
    expect(cancelled.state.reads).toBe(0);
  });

  it("rejects provider rows that carry event content and malformed sources", async () => {
    const { provider, state } = fixture();
    state.extraField = true;
    const outcome = await run(provider, reviews(["1"]).review);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
    expect(() =>
      parseAvailabilityEvents([
        {
          start: "a",
          end: "b",
          allDay: false,
          availability: "busy",
          title: "x",
        },
      ]),
    ).toThrow("Unexpected Calendar availability provider fields");
    expect(() =>
      parseAvailabilitySources([
        { id: "1", sourceRevision: rev("a") },
        { id: "1", sourceRevision: rev("b") },
      ]),
    ).toThrow("Invalid Calendar source identity");
  });
});
