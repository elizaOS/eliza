/**
 * Local-first Google Calendar sync: checkpoints, the Cloud sync-v1 provider port
 * and the serialized controller against in-memory storage and a synthetic Cloud
 * route. No Google account, network or device calendar is involved.
 */
import type {
  LinkedCalendarLocalPort,
  LinkedCalendarLocalSnapshot,
  LinkedCalendarSemanticEvent,
} from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
  calendarSyncHttp,
  googleCalendarSyncPort,
} from "../../src/linked-sync/google-sync-port.ts";
import {
  CalendarLinkedStore,
  type CalendarSyncBinding,
} from "../../src/linked-sync/linked-store.ts";
import {
  type CalendarSyncContext,
  CalendarSyncController,
} from "../../src/linked-sync/sync-controller.ts";
import type { CalendarSyncRequest } from "../../src/service/managed-calendar-host.ts";

const GRANT = "00000000-0000-4000-8000-000000000001";
const binding: CalendarSyncBinding = {
  environment: "production",
  userId: "owner",
  organizationId: "org",
  connectionId: GRANT,
  providerAccountId: "fixture-google-subject",
  calendarId: "primary",
  agentId: "agent",
  localSourceId: "local",
  localSourceRevision: "source-1",
};

function storage() {
  const slots = new Map<string, unknown>();
  let conflict = false;
  return {
    slots,
    conflictNext() {
      conflict = true;
    },
    async read(slot: string) {
      return structuredClone(slots.get(slot) ?? null);
    },
    async compareExchange(slot: string, expected: unknown, value: unknown) {
      if (
        conflict ||
        JSON.stringify(slots.get(slot) ?? null) !== JSON.stringify(expected)
      ) {
        conflict = false;
        return { status: "conflict" as const };
      }
      slots.set(slot, structuredClone(value));
      return { status: "saved" as const };
    },
  };
}

const event = (title = "QA"): LinkedCalendarSemanticEvent => ({
  title,
  description: "",
  location: "",
  startAt: "2026-10-15T18:00:00Z",
  endAt: "2026-10-15T19:00:00Z",
  timeZone: "UTC",
  isAllDay: false,
  attendees: [],
});

/** One synthetic Google calendar behind the Cloud sync-v1 contract. */
function cloud(
  store: (
    event: LinkedCalendarSemanticEvent,
  ) => LinkedCalendarSemanticEvent = (value) => value,
) {
  const events = new Map<
    string,
    { etag: string; event: LinkedCalendarSemanticEvent }
  >();
  const byKey = new Map<string, string>();
  const calls: CalendarSyncRequest["kind"][] = [];
  let next = 1;
  const envelope = (extra: Record<string, unknown>) => ({
    version: 1,
    calendarId: "primary",
    providerExactlyOnce: false,
    ...extra,
  });
  const snapshot = (id: string) => {
    const row = events.get(id);
    return row
      ? {
          eventId: id,
          etag: row.etag,
          visibility: "private",
          remindersDisabled: true,
          event: row.event,
        }
      : null;
  };
  return {
    events,
    calls,
    client: {
      async googleCalendarSync(input: CalendarSyncRequest) {
        calls.push(input.kind);
        if (input.kind === "capabilities")
          return envelope({
            accountId: "fixture-google-subject",
            read: true,
            write: true,
            idempotentCreate: true,
            conditionalWrites: true,
          });
        if (input.kind === "get") {
          const reference = input.reference as Record<string, string>;
          const id =
            reference.eventId ?? byKey.get(reference.idempotencyKey ?? "");
          return envelope({ event: id ? snapshot(id) : null });
        }
        if (input.kind === "create") {
          const existing = byKey.get(input.idempotencyKey);
          if (existing) return envelope({ event: snapshot(existing) });
          const id = `remote-${next++}`;
          events.set(id, { etag: `"v1"`, event: store(input.event) });
          byKey.set(input.idempotencyKey, id);
          return envelope({ event: snapshot(id) });
        }
        if (input.kind === "update") {
          const row = events.get(input.eventId);
          if (!row || row.etag !== input.expectedEtag)
            throw Object.assign(new Error("precondition"), {
              status: 412,
              data: {
                code: "CALENDAR_SYNC_PRECONDITION_FAILED",
                outcome: "precondition_failed",
                error: "Google event changed.",
              },
            });
          const etag = `"v${Number(row.etag.slice(2, -1)) + 1}"`;
          events.set(input.eventId, { etag, event: store(input.event) });
          return envelope({ event: snapshot(input.eventId) });
        }
        events.delete(input.eventId);
        return envelope({ deleted: true });
      },
    },
  };
}

function localCalendar(): LinkedCalendarLocalPort<string> & {
  rows: Map<string, LinkedCalendarLocalSnapshot<string>>;
} {
  const rows = new Map<string, LinkedCalendarLocalSnapshot<string>>();
  return {
    rows,
    async get(eventId) {
      return structuredClone(rows.get(eventId) ?? null);
    },
    async applyProviderEvent(eventId, next, expectedRevision) {
      const row = rows.get(eventId);
      if (row && row.revision !== expectedRevision)
        throw new Error("local changed");
      const value = {
        eventId,
        revision: `${expectedRevision}+`,
        event: next,
      };
      rows.set(eventId, value);
      return structuredClone(value);
    },
    async delete(eventId, expectedRevision) {
      if (rows.get(eventId)?.revision !== expectedRevision)
        throw new Error("local changed");
      rows.delete(eventId);
    },
  };
}

describe("CalendarLinkedStore", () => {
  it("keeps the idempotency key and checkpoint across reopening after an uncertain write", async () => {
    const slots = storage();
    const store = await CalendarLinkedStore.open(binding, () => true, slots, {
      idempotencyNamespace: "example-calendar-sync",
    });
    const link = await store.link("event-1", "rev-1");
    expect(link.idempotencyKey).toMatch(
      /^example-calendar-sync:[a-f0-9]{64}:event-1$/,
    );
    const pending = await store.save(link, {
      state: "quarantined",
      pendingOperation: "create",
      lastErrorCode: "OUTCOME_UNKNOWN",
      lastErrorMessage: "",
    });
    const reopened = await CalendarLinkedStore.open(
      binding,
      () => true,
      slots,
      {
        idempotencyNamespace: "example-calendar-sync",
      },
    );
    expect(await reopened.list()).toEqual([pending]);
    expect(await reopened.link("event-1", "rev-2")).toEqual(pending);
    // A different namespace does not adopt these checkpoints as its own keys.
    await expect(
      CalendarLinkedStore.open(binding, () => true, slots),
    ).rejects.toThrow("changed or need recovery");
  });

  it("isolates owners, grants, calendars, agents and local-source generations", async () => {
    const slots = storage();
    const store = await CalendarLinkedStore.open(binding, () => true, slots);
    await store.link("local-event", "r1");
    for (const patch of [
      { userId: "other" },
      { connectionId: "other" },
      { providerAccountId: "other" },
      { calendarId: "other" },
      { agentId: "other" },
      { localSourceRevision: "other" },
      { environment: "staging" as const },
    ]) {
      const other = await CalendarLinkedStore.open(
        { ...binding, ...patch },
        () => true,
        slots,
      );
      expect(other.scope).not.toBe(store.scope);
      expect(await other.list()).toEqual([]);
    }
    expect(slots.slots.size).toBe(1);
  });

  it("retains the original bytes after a storage conflict and refuses foreign patches", async () => {
    const slots = storage();
    const store = await CalendarLinkedStore.open(binding, () => true, slots);
    const link = await store.link("event", "r1");
    const before = structuredClone([...slots.slots]);
    slots.conflictNext();
    await expect(store.save(link, { state: "paused" })).rejects.toThrow(
      "changed or need recovery",
    );
    expect([...slots.slots]).toEqual(before);
    await expect(
      store.save(link, { connectorAccountId: "x" } as never),
    ).rejects.toThrow("changed or need recovery");
    const next = await store.save(link, { state: "paused" }, new Date(0));
    expect(Date.parse(next.updatedAt)).toBeGreaterThan(
      Date.parse(link.updatedAt),
    );
  });
});

describe("Google sync-v1 port", () => {
  it("builds exact requests and refuses unsafe selections", () => {
    const selection = { grantId: GRANT, calendarId: "primary", accountId: "a" };
    expect(
      calendarSyncHttp({
        kind: "capabilities",
        selection: { grantId: GRANT, calendarId: "primary" },
      }).path,
    ).toBe(
      "/api/v1/eliza/google/calendar/sync-v1/capabilities?grantId=00000000-0000-4000-8000-000000000001&calendarId=primary",
    );
    expect(
      calendarSyncHttp({
        kind: "update",
        selection,
        eventId: "e",
        expectedEtag: '"1"',
        event: event(),
      }).method,
    ).toBe("PATCH");
    expect(() =>
      calendarSyncHttp({
        kind: "delete",
        selection,
        eventId: "e",
        expectedEtag: "*",
      }),
    ).toThrow("exact Google event revision");
    expect(() =>
      calendarSyncHttp({
        kind: "get",
        selection: { ...selection, grantId: "not-a-uuid" },
        reference: { eventId: "e" },
      }),
    ).toThrow("Review the selected Google account");
  });

  it("checks capabilities, owner fence and create privacy", async () => {
    // Google answers recurrence in its own form; the canonical form is what
    // the local record holds and what the readback must hash to.
    const remote = cloud((value) => ({
      ...value,
      ...(value.recurrence
        ? { recurrence: value.recurrence.map((line) => line.toLowerCase()) }
        : {}),
    }));
    let current = true;
    const port = await googleCalendarSyncPort(
      remote.client,
      binding,
      () => current,
      new AbortController().signal,
      {
        canonicalRecurrence: (lines) => lines.map((line) => line.toUpperCase()),
      },
    );
    const store = await CalendarLinkedStore.open(
      binding,
      () => true,
      storage(),
    );
    const link = await store.link("e1", "r1");
    const created = await port.create(link, {
      ...event(),
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    expect(remote.events.get(created.eventId)?.event.recurrence).toEqual([
      "rrule:freq=daily",
    ]);
    expect(created.event.recurrence).toEqual(["RRULE:FREQ=DAILY"]);
    current = false;
    await expect(port.get(link)).rejects.toThrow("owner changed");
    await expect(
      googleCalendarSyncPort(
        {
          googleCalendarSync: async () => ({
            version: 1,
            calendarId: "primary",
            providerExactlyOnce: true,
          }),
        },
        binding,
        () => true,
        new AbortController().signal,
      ),
    ).rejects.toThrow("protocol is unavailable");
  });

  it("refuses a write whose readback differs from the requested event", async () => {
    // Google stores the time with an offset the local record never holds.
    const remote = cloud((value) => ({
      ...value,
      startAt: "2026-10-15T14:00:00-04:00",
    }));
    const port = await googleCalendarSyncPort(
      remote.client,
      binding,
      () => true,
      new AbortController().signal,
    );
    const store = await CalendarLinkedStore.open(
      binding,
      () => true,
      storage(),
    );
    const link = await store.link("e1", "r1");
    await expect(port.create(link, event())).rejects.toThrow(
      "different Calendar event than requested",
    );
    remote.events.set("remote-9", { etag: '"v1"', event: event() });
    await expect(
      port.update(
        { ...link, providerEventId: "remote-9", providerEtag: '"v1"' },
        event("Renamed"),
      ),
    ).rejects.toThrow("different Calendar event than requested");
  });

  it("refuses an answer for a different Google event", async () => {
    const remote = cloud();
    const port = await googleCalendarSyncPort(
      {
        async googleCalendarSync(input: CalendarSyncRequest) {
          const answer = (await remote.client.googleCalendarSync(
            input,
          )) as Record<string, unknown>;
          if (input.kind === "get" && answer.event)
            return {
              ...answer,
              event: {
                ...(answer.event as Record<string, unknown>),
                eventId: "someone-else",
              },
            };
          return answer;
        },
      },
      binding,
      () => true,
      new AbortController().signal,
    );
    const store = await CalendarLinkedStore.open(
      binding,
      () => true,
      storage(),
    );
    const link = await store.link("e1", "r1");
    const created = await port.create(link, event());
    await expect(
      port.get({ ...link, providerEventId: created.eventId }),
    ).rejects.toThrow("different Calendar event");
  });
});

describe("CalendarSyncController", () => {
  function setup() {
    const remote = cloud(),
      local = localCalendar(),
      slots = storage();
    local.rows.set("e1", {
      eventId: "e1",
      revision: "r1",
      event: event("Planning"),
    });
    const enabled = new Map<string, boolean>();
    let current = true;
    const context = (): CalendarSyncContext => ({
      reviewIdentity: "review-1",
      binding,
      client: remote.client,
      local,
      storage: slots,
      current: () => current,
      events: async () =>
        [...local.rows.values()].map((row) => ({
          id: row.eventId,
          revision: row.revision,
        })),
    });
    const controller = new CalendarSyncController(
      async () => context(),
      {
        read: async (scope) => enabled.get(scope) === true,
        write: async (scope, value) => {
          enabled.set(scope, value);
        },
      },
      { idempotencyNamespace: "example-calendar-sync" },
    );
    return {
      remote,
      local,
      controller,
      enabled,
      retire: () => {
        current = false;
      },
    };
  }

  it("writes nothing until the owner enables the exact reviewed source", async () => {
    const { remote, controller } = setup();
    await expect(controller.sync()).rejects.toThrow("paused");
    const review = await controller.review();
    expect(review.events).toEqual([{ id: "e1", revision: "r1" }]);
    expect(remote.calls.filter((kind) => kind !== "capabilities")).toEqual([]);
    await controller.enable(review);
    const report = await controller.sync();
    expect(report.pushed).toBe(1);
    expect([...remote.events.values()].map((row) => row.event.title)).toEqual([
      "Planning",
    ]);
    // A second pass is clean and creates nothing new.
    expect((await controller.sync()).clean).toBe(1);
    expect(remote.events.size).toBe(1);
  });

  it("refuses an enable whose events changed after review", async () => {
    const { controller, local, enabled } = setup();
    const review = await controller.review();
    local.rows.set("e2", {
      eventId: "e2",
      revision: "r1",
      event: event("New"),
    });
    await expect(controller.enable(review)).rejects.toThrow(
      "event list changed",
    );
    expect([...enabled.values()]).toEqual([]);
  });

  it("pausing stops before the next provider request and keeps links", async () => {
    const { controller, remote } = setup();
    await controller.enable(await controller.review());
    await controller.sync();
    await controller.pause();
    const before = remote.calls.length;
    await expect(controller.sync()).rejects.toThrow("paused");
    expect(remote.calls.length).toBe(before);
  });

  it("propagates a local deletion only for an enabled, linked event", async () => {
    const { controller, local, remote } = setup();
    await controller.enable(await controller.review());
    await controller.sync();
    local.rows.delete("e1");
    const report = await controller.sync();
    expect(report.pushed).toBe(1);
    expect(remote.events.size).toBe(0);
  });

  it("stops when the account or source context changes", async () => {
    const { controller, retire } = setup();
    retire();
    await expect(controller.review()).rejects.toThrow("context changed");
  });
});
