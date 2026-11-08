/** Managed Calendar write host against a scripted Cloud: sync-v1 keeps text as
 * written and the feed expands series and trims text, as Cloud does. */
import type {
  LinkedCalendarProviderSnapshot,
  LinkedCalendarSemanticEvent,
} from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
  type CalendarSyncRequest,
  calendarAgentWrite,
  type ManagedCalendarHostApi,
} from "./managed-calendar-host.js";

const scope = "a".repeat(64);
const source = `google:${scope}`;
type FeedRow = Awaited<
  ReturnType<ManagedCalendarHostApi["googleCalendarFeed"]>
>["events"][number];

function cloud(initial: LinkedCalendarProviderSnapshot | null = null) {
  let remote = initial;
  let revision = 1;
  const commands: CalendarSyncRequest[] = [];
  // The feed row for a single event: externalId is the event id, text trimmed.
  const row = (
    snapshot: LinkedCalendarProviderSnapshot,
    patch: Partial<FeedRow> = {},
  ): FeedRow => ({
    externalId: snapshot.eventId,
    title: snapshot.event.title.trim(),
    description: snapshot.event.description.trim(),
    location: snapshot.event.location.trim(),
    isAllDay: snapshot.event.isAllDay,
    startAt: snapshot.event.startAt,
    endAt: snapshot.event.endAt,
    attendees: snapshot.event.attendees,
    metadata: { recurringEventId: null },
    ...patch,
  });
  let feedRows = (snapshot: LinkedCalendarProviderSnapshot) => [row(snapshot)];
  const client: ManagedCalendarHostApi = {
    async googleCalendarSync(command) {
      commands.push(structuredClone(command));
      if (command.kind === "capabilities")
        return {
          version: 1,
          calendarId: command.selection.calendarId,
          accountId: "account",
          read: true,
          write: true,
          idempotentCreate: true,
          conditionalWrites: true,
          providerExactlyOnce: false,
        };
      if (command.kind === "get") return { event: remote };
      if (command.kind === "delete") {
        remote = null;
        return { deleted: true };
      }
      remote = {
        eventId: command.kind === "update" ? command.eventId : "series-1",
        etag: `"v${++revision}"`,
        event: structuredClone(command.event),
      };
      return { event: remote };
    },
    async googleCalendarFeed() {
      return {
        syncedAt: "2026-11-08T00:00:00.000Z",
        events: remote ? feedRows(remote) : [],
      };
    },
  };
  const execute = (payload: Record<string, unknown>) =>
    calendarAgentWrite(
      client,
      "owner-grant",
      scope,
      {
        operation: "write-execute",
        grantId: source,
        calendarId: "primary",
        accountId: "account",
        payload: {
          grantId: source,
          calendarId: "primary",
          side: "owner",
          ...payload,
        },
        preflight: remote
          ? { providerEventId: remote.eventId, providerVersion: remote.etag }
          : { idempotencyKey: "stable-key" },
      },
      new AbortController().signal,
    ) as Promise<{ event: Record<string, unknown> }>;
  return {
    commands,
    execute,
    row,
    feed: (rows: (snapshot: LinkedCalendarProviderSnapshot) => FeedRow[]) => {
      feedRows = rows;
    },
    writes: () =>
      commands.filter(
        (command) => command.kind === "create" || command.kind === "update",
      ) as Extract<CalendarSyncRequest, { kind: "create" | "update" }>[],
  };
}

const weekly = {
  action: "schedule_event",
  title: "Weekly standup",
  description: "",
  location: "",
  startsAtMs: Date.parse("2026-11-09T15:00:00.000Z"),
  endsAtMs: Date.parse("2026-11-09T15:30:00.000Z"),
  timeZone: "America/New_York",
  attendees: ["lead@example.com"],
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
};

describe("managed Calendar write readback", () => {
  it("reads a recurring create back through its first expanded instance", async () => {
    const f = cloud();
    f.feed((snapshot) => [
      f.row(snapshot, {
        externalId: "series-1_20261109T150000Z",
        metadata: { recurringEventId: "series-1" },
      }),
      f.row(snapshot, {
        externalId: "other",
        title: "Other",
        metadata: { recurringEventId: null },
      }),
    ]);
    const { event } = await f.execute(weekly);
    expect(event).toMatchObject({
      id: `${source}:series-1`,
      externalId: "series-1",
      title: "Weekly standup",
      recurrence: weekly.recurrence,
      metadata: { etag: '"v2"' },
    });
    expect(event.metadata).not.toHaveProperty("recurringEventId");
    expect(f.writes()).toHaveLength(1);
  });

  it("builds the receipt from Cloud's snapshot when the window has no instance", async () => {
    const f = cloud();
    f.feed(() => []);
    const { event } = await f.execute(weekly);
    expect(event).toMatchObject({
      id: `${source}:series-1`,
      externalId: "series-1",
      calendarId: "primary",
      startAt: "2026-11-09T15:00:00.000Z",
      attendees: [expect.objectContaining({ email: "lead@example.com" })],
    });
  });

  it("refuses an instance whose title differs from the approved series", async () => {
    const f = cloud();
    f.feed((snapshot) => [
      f.row(snapshot, {
        externalId: "series-1_20261109T150000Z",
        title: "Something else",
        metadata: { recurringEventId: "series-1" },
      }),
    ]);
    await expect(f.execute(weekly)).rejects.toThrow("could not be read back");
  });

  it("still requires the exact id for a single event", async () => {
    const f = cloud();
    f.feed((snapshot) => [
      f.row(snapshot, {
        externalId: "series-1_20261109T150000Z",
        metadata: { recurringEventId: "series-1" },
      }),
    ]);
    await expect(f.execute({ ...weekly, recurrence: [] })).rejects.toThrow(
      "could not be read back",
    );
  });

  it("edits and deletes an event whose description ends in whitespace", async () => {
    const event: LinkedCalendarSemanticEvent = {
      title: "Planning",
      description: "Agenda\n",
      location: " Room 4 ",
      startAt: "2026-11-10T15:00:00.000Z",
      endAt: "2026-11-10T16:00:00.000Z",
      timeZone: "America/New_York",
      isAllDay: false,
      attendees: [],
    };
    const f = cloud({ eventId: "plan", etag: '"v1"', event });
    const edited = await f.execute({
      action: "modify_event",
      eventId: "plan",
      expectedProviderVersion: '"v1"',
      patch: { title: "Planning review", description: "New agenda\n" },
    });
    expect(edited.event).toMatchObject({
      title: "Planning review",
      description: "New agenda",
    });
    const etag = (edited.event.metadata as { etag: string }).etag;
    const deleted = await f.execute({
      action: "cancel_event",
      eventId: "plan",
      expectedProviderVersion: etag,
      cancellationMode: "organizer_cancel",
    });
    expect(deleted.event).toMatchObject({ externalId: "plan" });
    expect(f.commands.at(-2)).toMatchObject({ kind: "delete" });
  });
});

describe("managed all-day Calendar edits", () => {
  const conference: LinkedCalendarProviderSnapshot = {
    eventId: "conf",
    etag: '"v1"',
    event: {
      title: "Conference",
      description: "",
      location: "",
      startAt: "2026-11-10",
      endAt: "2026-11-12",
      timeZone: null,
      isAllDay: true,
      attendees: [],
    },
  };
  const modify = (patch: Record<string, unknown>) => ({
    action: "modify_event",
    eventId: "conf",
    expectedProviderVersion: '"v1"',
    patch,
  });

  it("renames an all-day event with no zone, even when the owner's zone rides along", async () => {
    const f = cloud(structuredClone(conference));
    const { event } = await f.execute(
      modify({ title: "Conference day", timeZone: "America/New_York" }),
    );
    expect(event).toMatchObject({ title: "Conference day", isAllDay: true });
    expect(f.writes()[0].event).toMatchObject({
      isAllDay: true,
      timeZone: null,
      startAt: "2026-11-10",
      endAt: "2026-11-12",
    });
  });

  it("moves an all-day event to timed in the owner's zone", async () => {
    const f = cloud(structuredClone(conference));
    await f.execute(
      modify({
        startsAtMs: Date.parse("2026-11-10T14:00:00.000Z"),
        endsAtMs: Date.parse("2026-11-10T15:00:00.000Z"),
        timeZone: "America/New_York",
      }),
    );
    expect(f.writes()[0].event).toMatchObject({
      isAllDay: false,
      timeZone: "America/New_York",
    });
  });

  it.each([
    ["one bound", { startsAtMs: Date.parse("2026-11-10T14:00:00.000Z") }],
    [
      "no zone",
      {
        startsAtMs: Date.parse("2026-11-10T14:00:00.000Z"),
        endsAtMs: Date.parse("2026-11-10T15:00:00.000Z"),
      },
    ],
  ])(
    "refuses a move to timed with %s before any write",
    async (_label, patch) => {
      const f = cloud(structuredClone(conference));
      await expect(f.execute(modify(patch))).rejects.toThrow(
        "Review this all-day event in Calendar",
      );
      expect(f.writes()).toHaveLength(0);
    },
  );
});
