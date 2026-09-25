/**
 * Service-level CAL-03 admission for external calendar mutations.
 *
 * The conversational action checks availability before create/update, but
 * scripted, route and sibling callers reach `CalendarService` directly. These
 * cases drive the real create/update methods over a stubbed owner feed and a
 * connected-Google host gate, asserting the provider write is blocked on an
 * overlapping busy event or non-definitive coverage and admitted when the fresh
 * proposal is free. The move case asserts the edited event excludes itself.
 */

import type { IAgentRuntime, IGoogleWorkspaceService } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/core/contracts/calendar";
import { describe, expect, it, vi } from "vitest";
import { CalendarService } from "./CalendarService.js";
import type { CalendarHostGate } from "./gate.js";

const url = new URL("http://127.0.0.1/");
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const START = "2027-09-18T20:00:00.000Z";
const END = "2027-09-18T20:30:00.000Z";
const TZ = "America/New_York";
const GRANT_ID = "connector-account:work";
const ACCOUNT_ID = "work";
const CALENDAR_ID = "primary";

function googleEvent(id: string, start: string, end: string) {
  return {
    id,
    calendarId: CALENDAR_ID,
    title: id,
    status: "confirmed",
    start,
    end,
    timeZone: TZ,
    metadata: {},
  };
}

function feedEvent(
  id: string,
  start: string,
  end: string,
): LifeOpsCalendarEvent {
  return {
    id: `row-${id}`,
    externalId: id,
    agentId: OWNER,
    provider: "google",
    side: "owner",
    grantId: GRANT_ID,
    connectorAccountId: ACCOUNT_ID,
    calendarId: CALENDAR_ID,
    title: id,
    description: "",
    location: "",
    status: "confirmed",
    startAt: start,
    endAt: end,
    isAllDay: false,
    timezone: TZ,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function connectedGoogleGate(): CalendarHostGate {
  const timestamp = "2027-09-17T12:00:00.000Z";
  const grant = {
    id: GRANT_ID,
    agentId: OWNER,
    provider: "google",
    connectorAccountId: ACCOUNT_ID,
    side: "owner",
    identity: { email: "work@example.test" },
    identityEmail: "work@example.test",
    grantedScopes: ["https://www.googleapis.com/auth/calendar"],
    capabilities: ["google.calendar.read", "google.calendar.write"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  return {
    getGoogleConnectorAccounts: async () => [
      {
        provider: "google",
        side: "owner",
        mode: "local",
        defaultMode: "local",
        availableModes: ["local"],
        executionTarget: "local",
        sourceOfTruth: "connector_account",
        configured: true,
        connected: true,
        reason: "connected",
        preferredByAgent: true,
        cloudConnectionId: null,
        identity: grant.identity,
        grantedCapabilities: [...grant.capabilities],
        grantedScopes: [...grant.grantedScopes],
        expiresAt: null,
        hasRefreshToken: true,
        grant,
      },
    ],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("No external guest lookup");
    },
    requireGoogleCalendarGrant: async () => grant,
    requireGoogleCalendarWriteGrant: async () => grant,
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  } as CalendarHostGate;
}

function sourceHealth(status: "fresh" | "stale" | "error") {
  return {
    key: {
      provider: "google" as const,
      side: "owner" as const,
      grantId: GRANT_ID,
      connectorAccountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
    },
    summary: "Primary",
    accessRole: "owner",
    visibility: "details" as const,
    status,
    syncedAt: new Date().toISOString(),
    error: null,
  };
}

function harness(args: {
  events: LifeOpsCalendarEvent[];
  status?: "fresh" | "stale" | "error";
  existing?: LifeOpsCalendarEvent;
}) {
  const status = args.status ?? "fresh";
  const updateEvent = vi.fn(
    async (input: { eventId: string; startAt?: string; endAt?: string }) =>
      googleEvent(input.eventId, input.startAt ?? START, input.endAt ?? END),
  );
  const getEvent = vi.fn(async (input: { eventId: string }) =>
    googleEvent(
      input.eventId,
      args.existing?.startAt ?? START,
      args.existing?.endAt ?? END,
    ),
  );
  const createEvent = vi.fn(async (input: { start: string; end: string }) =>
    googleEvent("created", input.start, input.end),
  );
  const googleService = {
    createEvent,
    updateEvent,
    getEvent,
  } as unknown as IGoogleWorkspaceService;

  const feed = {
    calendarId: CALENDAR_ID,
    events: args.events,
    source: "synced" as const,
    state: status === "fresh" ? ("complete" as const) : ("partial" as const),
    sources: [sourceHealth(status)],
    timeMin: START,
    timeMax: END,
    syncedAt: new Date().toISOString(),
  };

  const runtime = {
    agentId: OWNER,
    getService: (name: string) => (name === "google" ? googleService : null),
    reportError: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    getSetting: () => undefined,
    character: { name: "Calendar availability" },
  } as unknown as IAgentRuntime;

  const service = new CalendarService(runtime);
  service.setGate(connectedGoogleGate());
  vi.spyOn(service, "getCalendarFeed").mockResolvedValue(feed);
  // The provider write is what these cases assert; the post-write persistence
  // is exercised by the PGlite service suite and is stubbed here.
  vi.spyOn(
    (
      service as unknown as {
        repo: { upsertCalendarEvent: (...a: unknown[]) => unknown };
      }
    ).repo,
    "upsertCalendarEvent",
  ).mockResolvedValue(undefined);
  vi.spyOn(
    (
      service as unknown as {
        repo: { replaceCalendarEventIfVersion: (...a: unknown[]) => unknown };
      }
    ).repo,
    "replaceCalendarEventIfVersion",
  ).mockResolvedValue(undefined);
  vi.spyOn(service, "getConditionalCalendarMutationTarget").mockImplementation(
    async () => {
      const existing = args.existing;
      if (!existing) throw new Error("no existing target configured");
      return existing;
    },
  );
  return { service, updateEvent, createEvent, runtime };
}

function existingEvent(id: string, start = START, end = END) {
  return {
    ...feedEvent(id, start, end),
    metadata: { etag: `"${id}-1"` },
  } satisfies LifeOpsCalendarEvent;
}

function create(events: LifeOpsCalendarEvent[]) {
  const { service, createEvent } = harness({ events });
  const promise = service.createCalendarEventMutation(
    url,
    {
      grantId: GRANT_ID,
      calendarId: CALENDAR_ID,
      title: "Call dad",
      startAt: START,
      endAt: END,
      timeZone: TZ,
      idempotencyKey: "create-1",
    },
    new Date(START),
  );
  return { promise, createEvent };
}

function move(args: {
  events: LifeOpsCalendarEvent[];
  existing: LifeOpsCalendarEvent;
  status?: "fresh" | "stale" | "error";
}) {
  const { service, updateEvent } = harness(args);
  const promise = service.updateCalendarEvent(url, {
    grantId: GRANT_ID,
    calendarId: CALENDAR_ID,
    eventId: args.existing.externalId,
    startAt: START,
    endAt: END,
    timeZone: TZ,
    expectedProviderVersion: args.existing.metadata?.etag as string,
  });
  return { promise, updateEvent };
}

describe("calendar service-level mutation availability admission", () => {
  it("blocks a Google create over an overlapping busy event", async () => {
    const { promise, createEvent } = create([feedEvent("busy", START, END)]);
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "CALENDAR_AVAILABILITY_CONFLICT",
    });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("admits a Google create when the proposal is free", async () => {
    const { promise, createEvent } = create([
      feedEvent("busy", "2027-09-18T18:00:00.000Z", "2027-09-18T19:00:00.000Z"),
    ]);
    await expect(promise).resolves.toMatchObject({ outcome: "event" });
    expect(createEvent).toHaveBeenCalledOnce();
  });

  it("refuses a Google create on non-definitive coverage", async () => {
    // A stale source makes the evaluation incomplete, so the write is refused
    // rather than assumed free.
    const { service, createEvent } = harness({ events: [], status: "stale" });
    const promise = service.createCalendarEventMutation(
      url,
      {
        grantId: GRANT_ID,
        calendarId: CALENDAR_ID,
        title: "Call dad",
        startAt: START,
        endAt: END,
        timeZone: TZ,
        idempotencyKey: "create-2",
      },
      new Date(START),
    );
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "CALENDAR_AVAILABILITY_INDETERMINATE",
    });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("blocks a Google move over an unrelated overlapping event", async () => {
    const target = existingEvent(
      "mine",
      "2027-09-18T16:00:00.000Z",
      "2027-09-18T16:30:00.000Z",
    );
    const { promise, updateEvent } = move({
      events: [target, feedEvent("other", START, END)],
      existing: target,
    });
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "CALENDAR_AVAILABILITY_CONFLICT",
    });
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it("excludes the edited event so a move does not conflict with itself", async () => {
    const target = existingEvent(
      "mine",
      "2027-09-18T16:00:00.000Z",
      "2027-09-18T16:30:00.000Z",
    );
    const { promise, updateEvent } = move({
      // The edited event's own row sits at the destination window.
      events: [target, feedEvent("mine", START, END)],
      existing: target,
      status: "fresh",
    });
    await expect(promise).resolves.toBeTruthy();
    expect(updateEvent).toHaveBeenCalledOnce();
  });

  it("refuses a non-definitive Google move", async () => {
    const target = existingEvent(
      "mine",
      "2027-09-18T16:00:00.000Z",
      "2027-09-18T16:30:00.000Z",
    );
    const { promise, updateEvent } = move({
      events: [],
      existing: target,
      status: "stale",
    });
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "CALENDAR_AVAILABILITY_INDETERMINATE",
    });
    expect(updateEvent).not.toHaveBeenCalled();
  });
});
