/**
 * Read-only Google Calendar reader: explicit source choice, owner/connection
 * isolation, revision checks around the feed read and all-day civil dates.
 * Synthetic Cloud client only; no OAuth, provider traffic or device calendar.
 */
import { describe, expect, it } from "vitest";
import {
  type GoogleCalendarAccount,
  type GoogleCalendarBinding,
  type GoogleCalendarClient,
  type GoogleCalendarErrorKind,
  type GoogleCalendarEvent,
  GoogleCalendarReader,
  type GoogleCalendarSummary,
} from "../../src/linked-sync/google-reader.ts";

class FixtureCloudError extends Error {
  readonly kind: GoogleCalendarErrorKind;
  constructor(kind: GoogleCalendarErrorKind) {
    super(kind);
    this.kind = kind;
  }
}
const classify = (error: unknown): GoogleCalendarErrorKind =>
  error instanceof FixtureCloudError ? error.kind : "unavailable";

const binding: GoogleCalendarBinding = {
  environment: "production",
  userId: "owner",
  organizationId: "org",
  credentialId: "credential",
  sessionId: "session",
  connectionId: "grant",
};
const summary: GoogleCalendarSummary = {
  calendarId: "primary@example.test",
  summary: "My calendar",
  description: null,
  primary: true,
  accessRole: "owner",
  backgroundColor: null,
  foregroundColor: null,
  timeZone: "America/Los_Angeles",
  selected: true,
};
const account: GoogleCalendarAccount = {
  connected: true,
  connectionId: "grant",
  grantedCapabilities: ["google.calendar.read"],
  label: "owner@example.test",
};
const range = {
  timeMin: "2026-10-13T00:00:00Z",
  timeMax: "2026-10-16T00:00:00Z",
  timeZone: "America/Los_Angeles",
};
const event: GoogleCalendarEvent = {
  externalId: "event",
  calendarId: summary.calendarId,
  title: "Appointment",
  description: "Read-only detail",
  location: "Office",
  status: "confirmed",
  startAt: "2026-10-13T18:00:00Z",
  endAt: "2026-10-13T19:00:00Z",
  isAllDay: false,
  timezone: "America/Los_Angeles",
  htmlLink: null,
  conferenceLink: null,
  organizer: null,
  attendees: [],
  metadata: {},
};
const signal = () => new AbortController().signal;

function fixture() {
  let active: GoogleCalendarBinding | null = { ...binding };
  const state = {
    accounts: [structuredClone(account)],
    calendars: [structuredClone(summary)],
    events: [structuredClone(event)],
    reads: [] as string[],
    lists: 0,
    fail: null as Error | null,
    duringFeed: undefined as (() => void | Promise<void>) | undefined,
  };
  const client: GoogleCalendarClient = {
    gmailAccounts: async () => structuredClone(state.accounts),
    googleCalendars: async () => {
      state.lists++;
      if (state.fail) throw state.fail;
      return structuredClone(state.calendars);
    },
    googleCalendarFeed: async (_grant, calendarId) => {
      state.reads.push(calendarId);
      await state.duringFeed?.();
      if (state.fail) throw state.fail;
      return {
        calendarId,
        events: structuredClone(state.events),
        syncedAt: "2026-10-13T20:00:00Z",
      };
    },
  };
  const reader = new GoogleCalendarReader(client, () => active, { classify });
  return {
    reader,
    state,
    setBinding(value: GoogleCalendarBinding | null) {
      active = value;
    },
    async select() {
      const result = await reader.listSources(signal());
      if (result.status !== "ready") throw new Error("fixture");
      reader.selectSource(result.calendars[0].id);
      return result;
    },
  };
}

describe("GoogleCalendarReader", () => {
  it("reads only an explicitly chosen, currently listed calendar", async () => {
    const f = fixture();
    expect((await f.reader.read(range, signal())).status).toBe(
      "selection-required",
    );
    await f.reader.listSources(signal());
    // Google's own `selected` flag is not the owner's choice.
    expect((await f.reader.read(range, signal())).status).toBe(
      "selection-required",
    );
    expect(f.state.reads).toEqual([]);
    expect(() => f.reader.selectSource("local")).toThrow("currently listed");
  });

  it("maps the chosen calendar's events as read-only display rows", async () => {
    const f = fixture();
    const list = await f.select();
    const result = await f.reader.read(range, signal());
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.events).toEqual([
      expect.objectContaining({
        calendarId: list.calendars[0].id,
        providerEventId: "event",
        begin: Date.parse(event.startAt),
        end: Date.parse(event.endAt),
        body: "Read-only detail",
        timeZone: "America/Los_Angeles",
        readOnly: true,
        source: "google",
      }),
    ]);
    expect(result.truncated).toBe(false);
    expect(f.state.reads).toEqual([summary.calendarId]);
  });

  it("keeps signed-out, missing permission and unavailable separate", async () => {
    const f = fixture();
    f.setBinding(null);
    expect((await f.reader.listSources(signal())).status).toBe("not-connected");
    f.setBinding({ ...binding });
    f.state.accounts[0].grantedCapabilities = ["google.gmail.triage"];
    expect((await f.reader.listSources(signal())).status).toBe(
      "permission-required",
    );
    expect(f.state.lists).toBe(0);
    const g = fixture();
    await g.select();
    g.state.fail = new Error("network failed");
    expect((await g.reader.read(range, signal())).status).toBe("unavailable");
    g.state.fail = new FixtureCloudError("permission-required");
    expect((await g.reader.read(range, signal())).status).toBe(
      "permission-required",
    );
  });

  it("never offers a free/busy-only calendar as event detail", async () => {
    const f = fixture();
    f.state.calendars[0].accessRole = "freeBusyReader";
    const list = await f.reader.listSources(signal());
    expect(list).toEqual({ status: "ready", calendars: [] });
  });

  it("rejects late data after any owner, session or connection change", async () => {
    for (const field of Object.keys(
      binding,
    ) as (keyof GoogleCalendarBinding)[]) {
      const f = fixture();
      await f.select();
      f.state.duringFeed = () =>
        f.setBinding({
          ...binding,
          [field]: field === "environment" ? "staging" : "other",
        });
      await expect(f.reader.read(range, signal())).rejects.toMatchObject({
        name: "AbortError",
      });
    }
  });

  it("rejects late data after a new choice, invalidation or an account switch", async () => {
    for (const change of ["select", "invalidate", "classified"] as const) {
      const f = fixture();
      await f.select();
      if (change === "classified")
        f.state.fail = new FixtureCloudError("account-changed");
      else
        f.state.duringFeed = () =>
          change === "invalidate"
            ? f.reader.invalidate()
            : f.reader.selectSource(null);
      await expect(f.reader.read(range, signal())).rejects.toMatchObject({
        name: "AbortError",
      });
    }
  });

  it("shows nothing when access or the calendar changes during the read", async () => {
    const revoked = fixture();
    await revoked.select();
    revoked.state.duringFeed = () => {
      revoked.state.accounts = [];
    };
    expect((await revoked.reader.read(range, signal())).status).toBe(
      "not-connected",
    );
    expect((await revoked.reader.read(range, signal())).status).toBe(
      "selection-required",
    );
    for (const change of ["capability", "role", "zone", "removed"] as const) {
      const f = fixture();
      await f.select();
      f.state.duringFeed = () => {
        if (change === "capability")
          f.state.accounts[0].grantedCapabilities = [];
        else if (change === "role")
          f.state.calendars[0].accessRole = "freeBusyReader";
        else if (change === "zone") f.state.calendars[0].timeZone = "UTC";
        else f.state.calendars = [];
      };
      expect((await f.reader.read(range, signal())).status).toBe(
        "permission-required",
      );
    }
  });

  it("keeps all-day civil dates with an exclusive end through DST", async () => {
    for (const [startAt, endAt, startDay, endDay] of [
      [
        "2026-03-08T08:00:00Z",
        "2026-03-09T07:00:00Z",
        "2026-03-08",
        "2026-03-09",
      ],
      [
        "2026-11-01T07:00:00Z",
        "2026-11-02T08:00:00Z",
        "2026-11-01",
        "2026-11-02",
      ],
      [
        "2026-10-31T07:00:00Z",
        "2026-11-02T08:00:00Z",
        "2026-10-31",
        "2026-11-02",
      ],
    ]) {
      const window = {
        ...range,
        timeMin: `${startDay}T00:00:00Z`,
        timeMax: `${endDay}T23:59:59Z`,
      };
      const f = fixture();
      await f.select();
      f.state.events = [
        { ...event, isAllDay: true, timezone: null, startAt, endAt },
      ];
      const result = await f.reader.read(window, signal());
      if (result.status !== "ready") throw new Error(result.status);
      expect(result.events[0]).toMatchObject({
        begin: Date.parse(`${startDay}T00:00:00Z`),
        end: Date.parse(`${endDay}T00:00:00Z`),
        allDay: true,
        timeZone: "UTC",
      });
    }
    const f = fixture();
    await f.select();
    f.state.events = [
      { ...event, isAllDay: true, timezone: "Invalid/Calendar" },
    ];
    expect((await f.reader.read(range, signal())).status).toBe("unavailable");
  });

  it("omits cancelled and out-of-window events and refuses foreign or duplicate rows", async () => {
    const f = fixture();
    await f.select();
    f.state.events = [
      { ...event, externalId: "cancelled", status: "cancelled" },
      {
        ...event,
        externalId: "past",
        startAt: "2026-10-12T00:00:00Z",
        endAt: range.timeMin,
      },
      {
        ...event,
        externalId: "later",
        startAt: "2026-10-14T18:00:00Z",
        endAt: "2026-10-14T19:00:00Z",
      },
      { ...event, externalId: "first" },
    ];
    const result = await f.reader.read(range, signal());
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.events.map((row) => row.providerEventId)).toEqual([
      "first",
      "later",
    ]);
    for (const rows of [[event, event], [{ ...event, calendarId: "other" }]]) {
      const g = fixture();
      await g.select();
      g.state.events = rows;
      expect((await g.reader.read(range, signal())).status).toBe("unavailable");
    }
  });

  it("refuses invalid ranges before any provider read", async () => {
    const f = fixture();
    await f.select();
    await expect(
      f.reader.read({ ...range, timeMax: range.timeMin }, signal()),
    ).rejects.toThrow(TypeError);
    await expect(
      f.reader.read({ ...range, timeZone: "invalid/zone" }, signal()),
    ).rejects.toThrow(RangeError);
    expect(f.state.reads).toEqual([]);
  });
});
