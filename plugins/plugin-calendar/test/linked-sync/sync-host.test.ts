/**
 * Foreground local-first Google Calendar sync host: saved opt-in, target
 * isolation, serialized operations, the device calendar gate and foreground
 * scheduling, against in-memory storage, a synthetic Cloud sync-v1 route and
 * an in-memory local calendar. No Google account, network or device is used.
 */
import type {
  LinkedCalendarLocalPort,
  LinkedCalendarLocalSnapshot,
  LinkedCalendarSemanticEvent,
} from "@elizaos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readGoogleCalendarSyncCapabilities,
  readGoogleCalendarSyncDestination,
} from "../../src/linked-sync/google-sync-port.ts";
import type { CalendarSyncBinding } from "../../src/linked-sync/linked-store.ts";
import {
  type CalendarSyncDeviceGate,
  type CalendarSyncPrepared,
  type CalendarSyncSettings,
  type CalendarSyncTarget,
  calendarSyncFailureMessage,
  calendarSyncReportMessage,
  calendarSyncSettingsSlot,
  calendarSyncTargetMatches,
  createCalendarSyncHost,
  readCalendarSyncSettings,
} from "../../src/linked-sync/sync-host.ts";
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
const target = (
  patch: Partial<CalendarSyncTarget> = {},
): CalendarSyncTarget => ({
  environment: "production",
  userId: "owner",
  organizationId: "org",
  connectionId: GRANT,
  calendarId: "primary",
  agentId: "agent",
  ...patch,
});

function storage() {
  const slots = new Map<string, unknown>();
  let conflicts = 0;
  return {
    slots,
    conflict(count: number) {
      conflicts = count;
    },
    async read(slot: string) {
      return structuredClone(slots.get(slot) ?? null);
    },
    async compareExchange(slot: string, expected: unknown, value: unknown) {
      if (
        conflicts > 0 ||
        JSON.stringify(slots.get(slot) ?? null) !== JSON.stringify(expected)
      ) {
        conflicts = Math.max(0, conflicts - 1);
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

function cloud() {
  const events = new Map<
    string,
    { etag: string; event: LinkedCalendarSemanticEvent }
  >();
  const byKey = new Map<string, string>();
  const calls: CalendarSyncRequest["kind"][] = [];
  let next = 1;
  let capabilities: Record<string, unknown> = {
    accountId: "fixture-google-subject",
    accountEmail: "owner@gmail.com",
    calendarLabel: "Personal",
    read: true,
    write: true,
    idempotentCreate: true,
    conditionalWrites: true,
  };
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
    capabilities(patch: Record<string, unknown>) {
      capabilities = { ...capabilities, ...patch };
    },
    client: {
      async googleCalendarSync(input: CalendarSyncRequest) {
        calls.push(input.kind);
        if (input.kind === "capabilities") return envelope(capabilities);
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
          events.set(id, { etag: `"v1"`, event: input.event });
          byKey.set(input.idempotencyKey, id);
          return envelope({ event: snapshot(id) });
        }
        throw new Error(`unexpected ${input.kind}`);
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
      const value = { eventId, revision: `${expectedRevision}+`, event: next };
      rows.set(eventId, value);
      return structuredClone(value);
    },
    async delete(eventId) {
      rows.delete(eventId);
    },
  };
}

/** One host over synthetic Cloud, local calendar and storage; `owner` names the current target. */
function fixture(options: { device?: CalendarSyncDeviceGate } = {}) {
  const remote = cloud(),
    local = localCalendar(),
    slots = storage(),
    settingsSlots = storage();
  local.rows.set("event-1", {
    eventId: "event-1",
    revision: "r1",
    event: event(),
  });
  const state = {
    owner: target(),
    identity: "owner-1",
    foreground: true,
    sourceRevision: "source-1",
    deviceEnabled: true,
  };
  const prepared: Array<{ interactive: boolean }> = [];
  const written: number[] = [];
  const host = createCalendarSyncHost({
    async prepare(signal, request) {
      prepared.push(request);
      const key = state.identity;
      const current = () =>
        !signal.aborted && state.foreground && state.identity === key;
      const destination = await readGoogleCalendarSyncDestination(
        remote.client,
        { grantId: state.owner.connectionId, calendarId: "primary" },
        current,
        signal,
      );
      const context: CalendarSyncPrepared = {
        reviewIdentity: key,
        binding: {
          ...binding,
          agentId: state.owner.agentId,
          providerAccountId: destination.providerAccountId,
          localSourceRevision: state.sourceRevision,
        },
        client: remote.client,
        local,
        storage: slots,
        current,
        events: async () =>
          [...local.rows.values()]
            .map((row) => ({ id: row.eventId, revision: row.revision }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        destination: {
          account: destination.accountEmail,
          calendar: destination.calendarLabel,
        },
      };
      return context;
    },
    settings: calendarSyncSettingsSlot(settingsSlots, "settings"),
    target: () => state.owner,
    identity: () => state.identity,
    foreground: () => state.foreground,
    source: async () => ({
      revision: state.sourceRevision,
      ...(options.device ? { deviceEnabled: state.deviceEnabled } : {}),
    }),
    storage: slots,
    device: options.device ? () => options.device : undefined,
    controller: { idempotencyNamespace: "fixture-sync" },
    settingsWritten: () => written.push(1),
    reviewMessage: (count) => `Ready to link ${count} fixture events.`,
  });
  const saved = () =>
    settingsSlots.slots.get("settings") as CalendarSyncSettings | undefined;
  return {
    host,
    remote,
    local,
    state,
    prepared,
    written,
    saved,
    settingsSlots,
  };
}

function deviceGate() {
  const calls: string[] = [];
  let granted = false;
  let failEnable = false;
  const gate: CalendarSyncDeviceGate = {
    async enabled() {
      return granted;
    },
    async enable(current) {
      calls.push("enable");
      if (failEnable || !current()) throw new Error("device refused");
      granted = true;
    },
    async pause() {
      calls.push("pause");
      granted = false;
    },
    cancel() {
      calls.push("cancel");
    },
  };
  return {
    gate,
    calls,
    refuse() {
      failEnable = true;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("saved opt-in and target", () => {
  it("reads only the exact four-field record and never treats damage as off", () => {
    expect(readCalendarSyncSettings(null)).toBeNull();
    const value = { version: 1, scope: "s", binding, enabled: true };
    expect(readCalendarSyncSettings(value)).toEqual(value);
    for (const damaged of [
      { ...value, extra: 1 },
      { ...value, version: 2 },
      { ...value, enabled: "yes" },
      { ...value, binding: null },
      [value],
    ])
      expect(() => readCalendarSyncSettings(damaged)).toThrow("need recovery");
  });

  it("matches only the same owner, organization, grant, calendar and agent", () => {
    expect(calendarSyncTargetMatches(binding, target())).toBe(true);
    expect(calendarSyncTargetMatches(undefined, target())).toBe(false);
    for (const patch of [
      { environment: "staging" as const },
      { userId: "other" },
      { organizationId: "other" },
      { connectionId: "other" },
      { calendarId: "other" },
      { agentId: "other" },
    ])
      expect(calendarSyncTargetMatches(binding, target(patch))).toBe(false);
  });

  it("retries a compare-and-exchange conflict and stops after the attempt limit", async () => {
    const slots = storage();
    const store = calendarSyncSettingsSlot(slots, "s", 3);
    slots.conflict(2);
    await store.edit(() => ({
      version: 1,
      scope: "a",
      binding,
      enabled: true,
    }));
    expect(slots.slots.get("s")).toMatchObject({ enabled: true });
    slots.conflict(3);
    await expect(store.edit(() => null)).rejects.toThrow(
      "settings changed. Review them again",
    );
    expect(slots.slots.get("s")).toMatchObject({ enabled: true });
  });

  it("offers a calendar only with safe provider semantics and verifiable names", () => {
    const caps = {
      version: 1,
      calendarId: "primary",
      accountId: "subject",
      accountEmail: "owner@gmail.com",
      calendarLabel: "Personal",
      read: true,
      write: true,
      conditionalWrites: true,
      idempotentCreate: true,
      providerExactlyOnce: false,
    };
    expect(readGoogleCalendarSyncCapabilities(caps, "primary")).toEqual({
      providerAccountId: "subject",
      accountEmail: "owner@gmail.com",
      calendarLabel: "Personal",
    });
    for (const unsafe of [
      { providerExactlyOnce: true },
      { conditionalWrites: false },
      { idempotentCreate: false },
      { accountId: "" },
      { calendarId: "other" },
    ])
      expect(() =>
        readGoogleCalendarSyncCapabilities({ ...caps, ...unsafe }, "primary"),
      ).toThrow("does not support safe sync");
    for (const unnamed of [{ accountEmail: "owner" }, { calendarLabel: " " }])
      expect(() =>
        readGoogleCalendarSyncCapabilities({ ...caps, ...unnamed }, "primary"),
      ).toThrow("names could not be verified");
  });

  it("states failures and pass results in plain text", () => {
    expect(calendarSyncFailureMessage({ status: 404 })).toContain(
      "not available on this server yet",
    );
    expect(
      calendarSyncFailureMessage(new DOMException("x", "AbortError")),
    ).toContain("Sync paused or the selected account changed");
    expect(calendarSyncFailureMessage(new Error("Exact reason."))).toBe(
      "Exact reason.",
    );
    const clean = {
      clean: 2,
      pushed: 1,
      pulled: 0,
      conflicted: 0,
      quarantined: 0,
      paused: 1,
      dirty: 0,
    };
    expect(calendarSyncReportMessage(clean)).toBe(
      "Synced: 1 sent to Google, 0 received, 2 unchanged. 1 links paused.",
    );
    expect(calendarSyncReportMessage({ ...clean, quarantined: 1 })).toBe(
      "Sync needs review: 0 conflicts, 1 unconfirmed changes, 0 refused changes.",
    );
  });
});

describe("createCalendarSyncHost", () => {
  it("reviews, enables, syncs, lists links and pauses one exact destination", async () => {
    const f = fixture();
    const review = await f.host.review();
    expect(f.prepared[0]).toEqual({ interactive: true });
    expect(f.host.snapshot()).toEqual({
      status: "Ready to link 1 fixture events.",
      running: false,
      enabled: false,
    });
    expect(f.host.destination()).toEqual({
      account: "owner@gmail.com",
      calendar: "Personal",
    });
    expect(f.remote.calls).toEqual(["capabilities", "capabilities"]);
    const report = await f.host.enable(review);
    expect(report.pushed).toBe(1);
    expect(f.prepared.slice(1).every((row) => !row.interactive)).toBe(true);
    expect(f.saved()).toMatchObject({
      version: 1,
      enabled: true,
      binding: { ...binding },
    });
    expect(f.written.length).toBe(1);
    expect(f.host.snapshot()).toEqual({
      status: "Synced: 1 sent to Google, 0 received, 0 unchanged.",
      running: false,
      enabled: true,
    });
    expect(await f.host.linkedProviderEvents()).toEqual(new Set(["remote-1"]));
    // A different local source generation hides nothing.
    f.state.sourceRevision = "source-2";
    expect(await f.host.linkedProviderEvents()).toEqual(new Set());
    f.state.sourceRevision = "source-1";

    await f.host.pause();
    expect(f.saved()).toMatchObject({ enabled: false });
    expect(f.host.snapshot()).toEqual({
      status: "Sync is off. Saved events and links are retained.",
      running: false,
      enabled: false,
    });
    const calls = f.remote.calls.length;
    await f.host.resume();
    expect(f.remote.calls.length).toBe(calls);
    expect(await f.host.linkedProviderEvents()).toEqual(new Set());
  });

  it("serializes operations and reports the failure of a refused one", async () => {
    const f = fixture();
    const first = f.host.review();
    await expect(f.host.sync()).rejects.toThrow(
      "Calendar sync is already running.",
    );
    await first;
    f.remote.capabilities({ providerExactlyOnce: true });
    await expect(f.host.review()).rejects.toThrow("does not support safe sync");
    expect(f.host.snapshot().status).toBe(
      "This Google calendar does not support safe sync.",
    );
  });

  it("never reuses an opt-in for a different agent, grant or calendar", async () => {
    const f = fixture();
    await f.host.enable(await f.host.review());
    const calls = f.remote.calls.length;
    f.state.owner = target({ agentId: "other-agent" });
    f.state.identity = "owner-2";
    await f.host.resume();
    expect(f.remote.calls.length).toBe(calls);
    await f.host.settings();
    expect(f.host.snapshot().enabled).toBe(false);
    expect(await f.host.linkedProviderEvents()).toEqual(new Set());
    f.state.owner = target();
    f.state.identity = "owner-1";
    await f.host.settings();
    expect(f.host.snapshot().enabled).toBe(true);
  });

  it("refuses a damaged record before any provider request", async () => {
    const f = fixture();
    f.settingsSlots.slots.set("settings", { version: 1, enabled: true });
    await expect(f.host.settings()).rejects.toThrow("need recovery");
    await f.host.resume();
    expect(f.remote.calls).toEqual([]);
    expect(f.host.snapshot().status).toBe(
      "Calendar sync settings need recovery. Saved events are retained.",
    );
  });

  it("grants the device opt-in before saving, and withdraws it when enabling fails", async () => {
    const device = deviceGate();
    const f = fixture({ device: device.gate });
    const review = await f.host.review();
    f.state.identity = "changed";
    await expect(f.host.enable(review)).rejects.toThrow(
      "Calendar account changed. Review sync again.",
    );
    expect(device.calls).toEqual([]);
    expect(f.saved()).toBeUndefined();

    f.state.identity = "owner-1";
    const fresh = await f.host.review();
    // A local edit after the review is enabled only through a fresh review.
    f.local.rows.set("event-2", {
      eventId: "event-2",
      revision: "r1",
      event: event("Second"),
    });
    const report = await f.host.enable(fresh);
    expect(device.calls).toEqual(["enable"]);
    expect(report.pushed).toBe(2);
    expect(f.host.snapshot().enabled).toBe(true);

    const refused = fixture({ device: device.gate });
    const refusedReview = await refused.host.review();
    device.calls.length = 0;
    refused.remote.capabilities({ conditionalWrites: false });
    await expect(refused.host.enable(refusedReview)).rejects.toThrow(
      "does not support safe sync",
    );
    expect(device.calls).toEqual(["enable", "pause"]);
    expect(refused.saved()).toBeUndefined();
  });

  it("asks for a new review when the device source or its opt-in changed", async () => {
    const device = deviceGate();
    const f = fixture({ device: device.gate });
    await f.host.enable(await f.host.review());
    await f.host.settings();
    expect(f.host.snapshot().enabled).toBe(true);
    f.state.deviceEnabled = false;
    await f.host.settings();
    expect(f.host.snapshot()).toMatchObject({
      enabled: false,
      status: "Device sync needs a new review. Saved events are retained.",
    });
    f.state.deviceEnabled = true;
    f.state.sourceRevision = "source-2";
    await f.host.settings();
    expect(f.host.snapshot().enabled).toBe(false);
  });
});

/** Counts completed operations through the host's own notifications; no timers involved. */
function passes(host: ReturnType<typeof createCalendarSyncHost>) {
  let completed = 0,
    wasRunning = false;
  const waiters: Array<() => void> = [];
  host.subscribe(() => {
    const running = host.snapshot().running;
    if (wasRunning && !running) {
      completed++;
      for (const wake of waiters.splice(0)) wake();
    }
    wasRunning = running;
  });
  return {
    get completed() {
      return completed;
    },
    async until(count: number) {
      while (completed < count)
        await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

/** Lets a resume that already started reach its first operation. */
async function flush() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

describe("foreground scheduling", () => {
  it("debounces local edits, defers one during a pass and stops in the background", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    await f.host.enable(await f.host.review());
    const counter = passes(f.host);
    const foreground = f.host.start();
    await counter.until(1);

    foreground.localChanged();
    foreground.localChanged();
    await vi.advanceTimersByTimeAsync(399);
    await flush();
    expect(counter.completed).toBe(1);
    expect(f.host.snapshot().running).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await counter.until(2);

    // An edit during a running pass runs once after that pass settles.
    const running = f.host.sync();
    foreground.localChanged();
    await running;
    await vi.advanceTimersByTimeAsync(400);
    await counter.until(4);
    await flush();
    expect(counter.completed).toBe(4);

    f.state.foreground = false;
    foreground.localChanged();
    foreground.visibilityChanged();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(counter.completed).toBe(4);
    f.state.foreground = true;
    foreground.visibilityChanged();
    await counter.until(5);
    foreground.stop();
    foreground.localChanged();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(counter.completed).toBe(5);
    expect(f.host.snapshot().status).toBe(
      "Synced: 0 sent to Google, 0 received, 1 unchanged.",
    );
  });

  it("an owner change cancels, withdraws the device opt-in and resumes only a matching opt-in", async () => {
    const device = deviceGate();
    const f = fixture({ device: device.gate });
    await f.host.enable(await f.host.review());
    const counter = passes(f.host);
    const foreground = f.host.start();
    await counter.until(1);
    device.calls.length = 0;
    const calls = f.remote.calls.length;
    f.state.owner = target({
      connectionId: "00000000-0000-4000-8000-000000000002",
    });
    f.state.identity = "owner-2";
    foreground.ownerChanged();
    expect(device.calls).toEqual(["cancel", "pause"]);
    expect(f.host.snapshot()).toMatchObject({
      status: "Sync is off.",
      enabled: false,
    });
    await flush();
    expect(f.host.snapshot().running).toBe(false);
    expect(counter.completed).toBe(1);
    expect(f.remote.calls.length).toBe(calls);
    // The same identity again is not a change.
    foreground.ownerChanged();
    expect(device.calls).toEqual(["cancel", "pause"]);
    foreground.settingsChangedElsewhere();
    expect(f.host.snapshot().status).toBe(
      "Sync settings changed in another view.",
    );
    foreground.stop();
  });
});
