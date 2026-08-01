/**
 * Action-boundary coverage for calendar-owned conflict scans, including honest
 * guest availability and source-health reporting.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type ConflictDetectEvent,
  createConflictDetectAction,
  registerConflictDetectHostAdapter,
} from "../src/actions/conflict-detect.js";

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: "calendar-conflict-agent" as UUID,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getService: () => null,
    ...overrides,
  } as unknown as IAgentRuntime;
}

function message(): Memory {
  return {
    id: "calendar-conflict-message" as UUID,
    entityId: "owner" as UUID,
    roomId: "room" as UUID,
    content: { text: "check this time" },
  } as Memory;
}

async function invoke(
  action: ReturnType<typeof createConflictDetectAction>,
  parameters: Record<string, unknown>,
  testRuntime = runtime(),
) {
  return action.handler(
    testRuntime,
    message(),
    undefined,
    { parameters } as HandlerOptions,
    async () => undefined,
  );
}

const OWNER_EVENT: ConflictDetectEvent = {
  id: "owner-event",
  title: "Owner event",
  startISO: "2026-05-11T09:00:00.000Z",
  endISO: "2026-05-11T10:00:00.000Z",
  attendees: ["owner@example.com"],
};
const GUEST_GRANT_ID = "gav_5ff8ec0542374abf9870736d4bea22a5";
const SECOND_GUEST_GRANT_ID = "gav_fcecd5ee120749ac9381c4d3184ff3ae";

function calendarFeedEvent(args: {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  grantId?: string;
  connectorAccountId?: string;
}): LifeOpsCalendarEvent {
  return {
    id: args.id,
    externalId: args.id,
    agentId: "calendar-conflict-agent",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: args.startAt,
    endAt: args.endAt,
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-05-11T08:00:00.000Z",
    updatedAt: "2026-05-11T08:00:00.000Z",
    ...(args.grantId ? { grantId: args.grantId } : {}),
    ...(args.connectorAccountId
      ? { connectorAccountId: args.connectorAccountId }
      : {}),
  };
}

function testAction(args?: {
  feed?: readonly ConflictDetectEvent[];
  freeBusy?: readonly ConflictDetectEvent[];
}) {
  return createConflictDetectAction({
    authorize: async () => true,
    resolveTimeZone: async () => "UTC",
    now: () => new Date("2026-05-11T12:00:00.000Z"),
    loader: {
      loadFeed: async () => args?.feed ?? [],
      ...(args?.freeBusy
        ? { loadFreeBusy: async () => args.freeBusy ?? [] }
        : {}),
    },
  });
}

describe("calendar-owned CONFLICT_DETECT action", () => {
  it("declares both named and explicit scan ranges in its tool schema", () => {
    const action = testAction();
    const range = action.parameters?.find(
      (parameter) => parameter.name === "range",
    );

    // anyOf, not oneOf: strict-mode provider grammars (Cerebras) reject
    // oneOf, and the invariant under test is that both range forms are
    // declared — not which union keyword carries them.
    expect(range?.schema.anyOf).toEqual([
      { type: "string", enum: ["today", "week"] },
      { type: "object", additionalProperties: true },
    ]);
    expect(range?.schema.oneOf).toBeUndefined();
  });

  it("fails closed when the host authorization adapter denies access", async () => {
    const action = createConflictDetectAction({
      authorize: async () => false,
      resolveTimeZone: async () => "UTC",
      loader: { loadFeed: async () => [] },
    });
    const result = await invoke(action, { subaction: "scan_today" });

    expect(result).toMatchObject({
      success: false,
      data: { error: "PERMISSION_DENIED" },
    });
  });

  it("uses the requested IANA zone for a DST-short local day", async () => {
    const seen: Array<{ start: string; end: string }> = [];
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "America/New_York",
      now: () => new Date("2026-03-08T12:00:00.000Z"),
      loader: {
        loadFeed: async ({ range }) => {
          seen.push(range);
          return [];
        },
      },
    });
    const result = await invoke(action, { subaction: "scan_today" });

    expect(result.success).toBe(true);
    expect(seen).toEqual([
      {
        start: "2026-03-08T05:00:00.000Z",
        end: "2026-03-09T04:00:00.000Z",
      },
    ]);
  });

  it("applies a runtime host adapter even when the calendar action was created first", async () => {
    const seen: Array<{ start: string; end: string }> = [];
    const action = createConflictDetectAction({
      now: () => new Date("2026-03-08T12:00:00.000Z"),
      loader: {
        loadFeed: async ({ range }) => {
          seen.push(range);
          return [];
        },
      },
    });
    const testRuntime = runtime();
    registerConflictDetectHostAdapter(testRuntime, {
      authorize: async () => true,
      resolveTimeZone: async () => "America/New_York",
    });

    const result = await invoke(
      action,
      { subaction: "scan_today" },
      testRuntime,
    );

    expect(result.success).toBe(true);
    expect(seen).toEqual([
      {
        start: "2026-03-08T05:00:00.000Z",
        end: "2026-03-09T04:00:00.000Z",
      },
    ]);
  });

  it("merges host-adapter registrations so a loader binds after authorization", async () => {
    const authorizeCalls: string[] = [];
    const feedCalls: string[] = [];
    const action = createConflictDetectAction({
      now: () => new Date("2026-05-11T12:00:00.000Z"),
    });
    const testRuntime = runtime();
    registerConflictDetectHostAdapter(testRuntime, {
      authorize: async () => {
        authorizeCalls.push("host");
        return true;
      },
      resolveTimeZone: async () => "UTC",
    });
    registerConflictDetectHostAdapter(testRuntime, {
      loader: {
        loadFeed: async () => {
          feedCalls.push("host");
          return [OWNER_EVENT];
        },
      },
    });

    const result = await invoke(
      action,
      { subaction: "scan_today" },
      testRuntime,
    );

    expect(result.success).toBe(true);
    expect(authorizeCalls).toEqual(["host"]);
    expect(feedCalls).toEqual(["host"]);
  });

  it("prefers an instance loader over the runtime host adapter's loader", async () => {
    const feedCalls: string[] = [];
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
      now: () => new Date("2026-05-11T12:00:00.000Z"),
      loader: {
        loadFeed: async () => {
          feedCalls.push("deps");
          return [];
        },
      },
    });
    const testRuntime = runtime();
    registerConflictDetectHostAdapter(testRuntime, {
      loader: {
        loadFeed: async () => {
          feedCalls.push("host");
          return [];
        },
      },
    });

    const result = await invoke(
      action,
      { subaction: "scan_today" },
      testRuntime,
    );

    expect(result.success).toBe(true);
    expect(feedCalls).toEqual(["deps"]);
  });

  it("marks a guest proposal partial when no real free/busy loader exists", async () => {
    const action = testAction({ feed: [] });
    const result = await invoke(action, {
      subaction: "scan_event_proposal",
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
        attendees: ["guest@example.com"],
        guestAvailabilityGrantIds: [GUEST_GRANT_ID],
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        completeness: "partial",
        definitive: false,
        warning: "CALENDAR_INCOMPLETE",
      },
    });
    expect(String(result.text)).toMatch(/availability is incomplete/i);
    expect(String(result.text)).not.toBe("No conflicts detected.");
  });

  it("treats an explicit empty free/busy response as complete coverage", async () => {
    const action = testAction({ feed: [], freeBusy: [] });
    const result = await invoke(action, {
      subaction: "scan_event_proposal",
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
        attendees: ["guest@example.com"],
        guestAvailabilityGrantIds: [GUEST_GRANT_ID],
      },
    });

    expect(result).toMatchObject({
      success: true,
      text: "No conflicts detected.",
      data: {
        completeness: "complete",
        definitive: true,
        checkedEvents: 0,
      },
    });
  });

  it("passes only opaque grants and time bounds to the free/busy loader", async () => {
    const loadFreeBusy = vi.fn(async () => []);
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
      loader: {
        loadFeed: async () => [],
        loadFreeBusy,
      },
    });
    await invoke(action, {
      subaction: "scan_event_proposal",
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
        attendees: ["private-guest@example.com"],
        guestAvailabilityGrantIds: [GUEST_GRANT_ID],
      },
    });

    expect(loadFreeBusy).toHaveBeenCalledWith({
      runtime: expect.any(Object),
      guestAvailabilityGrantIds: [GUEST_GRANT_ID],
      range: {
        start: "2026-05-11T09:00:00.000Z",
        end: "2026-05-11T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(loadFreeBusy.mock.calls)).not.toContain(
      "private-guest@example.com",
    );
  });

  it("uses raw attendees only for local shared-attendee conflicts", async () => {
    const loadFreeBusy = vi.fn(async () => []);
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
      now: () => new Date("2026-05-11T12:00:00.000Z"),
      loader: {
        loadFeed: async () => [OWNER_EVENT],
        loadFreeBusy,
      },
    });
    const result = await invoke(action, {
      subaction: "scan_event_proposal",
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
        attendees: ["owner@example.com"],
      },
    });

    expect(loadFreeBusy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      data: {
        completeness: "partial",
        definitive: false,
        conflicts: [
          expect.objectContaining({
            reasons: expect.arrayContaining(["shared_attendee"]),
          }),
        ],
      },
    });
  });

  it("keeps an empty multi-guest response partial without per-guest coverage", async () => {
    const action = testAction({ feed: [], freeBusy: [] });
    const result = await invoke(action, {
      subaction: "scan_event_proposal",
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
        attendees: ["first@example.com", "second@example.com"],
        guestAvailabilityGrantIds: [GUEST_GRANT_ID, SECOND_GUEST_GRANT_ID],
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        completeness: "partial",
        definitive: false,
        warning: "CALENDAR_INCOMPLETE",
      },
    });
    expect(String(result.text)).toMatch(/incomplete/i);
  });

  it("keeps guest loader failure visible as a redacted partial result", async () => {
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
      loader: {
        loadFeed: async () => [],
        loadFreeBusy: async () => {
          throw new Error(
            "freebusy provider 503 for private-guest@example.com at /freeBusy",
          );
        },
      },
    });
    const testRuntime = runtime();
    const result = await invoke(
      action,
      {
        subaction: "scan_event_proposal",
        proposal: {
          startISO: "2026-05-11T09:00:00.000Z",
          endISO: "2026-05-11T10:00:00.000Z",
          attendees: ["guest@example.com"],
          guestAvailabilityGrantIds: [GUEST_GRANT_ID],
        },
      },
      testRuntime,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        completeness: "partial",
        sources: expect.arrayContaining([
          expect.objectContaining({
            status: "error",
            visibility: "busy_only",
            error: "Private availability source unavailable.",
          }),
        ]),
      },
    });
    expect(JSON.stringify(result.data)).not.toContain(
      "private-guest@example.com",
    );
    const warn = testRuntime.logger.warn as ReturnType<typeof vi.fn>;
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private-guest@example.com",
    );
  });

  it("rejects a proposal outside the requested scan range before loading calendars", async () => {
    const loadFeed = vi.fn(async () => []);
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
      loader: { loadFeed },
    });
    const result = await invoke(action, {
      subaction: "scan_event_proposal",
      range: {
        start: "2026-05-12T00:00:00.000Z",
        end: "2026-05-13T00:00:00.000Z",
      },
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      success: false,
      data: { error: "PROPOSAL_OUTSIDE_RANGE" },
    });
    expect(loadFeed).not.toHaveBeenCalled();
  });

  it("redacts guest busy details in the action result", async () => {
    const action = testAction({
      feed: [],
      freeBusy: [
        {
          id: "guest-private-id",
          title: "Private medical appointment",
          startISO: "2026-05-11T09:15:00.000Z",
          endISO: "2026-05-11T09:45:00.000Z",
          attendees: ["guest@example.com"],
        },
      ],
    });
    const result = await invoke(action, {
      subaction: "scan_event_proposal",
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
        attendees: ["guest@example.com"],
        guestAvailabilityGrantIds: [GUEST_GRANT_ID],
      },
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      conflicts: Array<{ eventB: unknown }>;
    };
    const exposedPrivateBlock = JSON.stringify(data.conflicts[0]?.eventB);
    expect(exposedPrivateBlock).toContain('"title":"Busy"');
    expect(exposedPrivateBlock).not.toContain("Private medical appointment");
    expect(exposedPrivateBlock).not.toContain("guest@example.com");
    expect(exposedPrivateBlock).not.toContain("guest-private-id");
  });

  it("surfaces a stale source even when no overlap is found", async () => {
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
      loader: {
        loadFeed: async () => ({
          events: [],
          source: {
            id: "owner",
            status: "stale",
            visibility: "details",
          },
        }),
      },
    });
    const result = await invoke(action, { subaction: "scan_today" });

    expect(result).toMatchObject({
      success: true,
      data: {
        completeness: "partial",
        definitive: false,
      },
    });
    expect(String(result.text)).toMatch(/incomplete/i);
  });

  it("preserves per-calendar source health and assigns events to the matching account", async () => {
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
    });
    const testRuntime = runtime({
      getService: () => ({
        getCalendarFeed: async () => ({
          calendarId: "all",
          events: [
            calendarFeedEvent({
              id: "fresh-event",
              title: "Fresh source event",
              startAt: "2026-05-11T09:00:00.000Z",
              endAt: "2026-05-11T10:00:00.000Z",
              grantId: "grant-fresh",
              connectorAccountId: "account-fresh",
            }),
            calendarFeedEvent({
              id: "stale-event",
              title: "Stale source event",
              startAt: "2026-05-11T09:30:00.000Z",
              endAt: "2026-05-11T10:30:00.000Z",
              grantId: "grant-stale",
              connectorAccountId: "account-stale",
            }),
          ],
          source: "cache",
          state: "partial",
          sources: [
            {
              key: {
                provider: "google",
                side: "owner",
                grantId: "grant-fresh",
                connectorAccountId: "account-fresh",
                calendarId: "primary",
              },
              summary: "Work",
              status: "fresh",
              syncedAt: "2026-05-11T08:00:00.000Z",
              error: null,
            },
            {
              key: {
                provider: "google",
                side: "owner",
                grantId: "grant-stale",
                connectorAccountId: "account-stale",
                calendarId: "primary",
              },
              summary: "Family",
              status: "stale",
              syncedAt: "2026-05-10T08:00:00.000Z",
              error: null,
            },
            {
              key: {
                provider: "google",
                side: "owner",
                grantId: "grant-error",
                connectorAccountId: "account-error",
                calendarId: "shared",
              },
              summary: "Coparent",
              status: "error",
              syncedAt: null,
              error: {
                code: "UPSTREAM_503",
                message: "Calendar provider unavailable.",
                retryable: true,
              },
            },
          ],
          timeMin: "2026-05-11T00:00:00.000Z",
          timeMax: "2026-05-12T00:00:00.000Z",
          syncedAt: "2026-05-11T08:00:00.000Z",
        }),
      }),
    });

    const result = await invoke(
      action,
      {
        subaction: "scan_today",
        range: {
          start: "2026-05-11T00:00:00.000Z",
          end: "2026-05-12T00:00:00.000Z",
        },
      },
      testRuntime,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        completeness: "partial",
        definitive: false,
        checkedEvents: 2,
        conflicts: [expect.objectContaining({ severity: "hard" })],
        sources: [
          expect.objectContaining({ status: "fresh", eventCount: 1 }),
          expect.objectContaining({ status: "stale", eventCount: 1 }),
          expect.objectContaining({
            status: "error",
            eventCount: 0,
            error: "Calendar provider unavailable.",
          }),
        ],
      },
    });
  });

  it("does not claim a definitive empty result when the feed names no sources", async () => {
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
    });
    const testRuntime = runtime({
      getService: () => ({
        getCalendarFeed: async () => ({
          calendarId: "all",
          events: [],
          source: "cache",
          state: "unavailable",
          sources: [],
          timeMin: "2026-05-11T00:00:00.000Z",
          timeMax: "2026-05-12T00:00:00.000Z",
          syncedAt: null,
        }),
      }),
    });

    const result = await invoke(
      action,
      {
        subaction: "scan_today",
        range: {
          start: "2026-05-11T00:00:00.000Z",
          end: "2026-05-12T00:00:00.000Z",
        },
      },
      testRuntime,
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        completeness: "unavailable",
        definitive: false,
        error: "CALENDAR_UNAVAILABLE",
      },
    });
    expect(String(result.text)).not.toMatch(/no conflicts detected/i);
  });

  it("recovers Apple all-day local dates from EventKit instants east of UTC", async () => {
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "Asia/Tokyo",
    });
    const appleEvent: LifeOpsCalendarEvent = {
      ...calendarFeedEvent({
        id: "apple-school-closure",
        title: "School closed",
        startAt: "2026-05-10T15:00:00.000Z",
        endAt: "2026-05-11T15:00:00.000Z",
        grantId: "apple-calendar",
        connectorAccountId: "apple-calendar",
      }),
      provider: "apple_calendar",
      isAllDay: true,
      timezone: "Asia/Tokyo",
    };
    const testRuntime = runtime({
      getService: () => ({
        getCalendarFeed: async () => ({
          calendarId: "primary",
          events: [appleEvent],
          source: "synced",
          state: "complete",
          sources: [
            {
              key: {
                provider: "apple_calendar",
                side: "owner",
                grantId: "apple-calendar",
                connectorAccountId: "apple-calendar",
                calendarId: "primary",
              },
              summary: "Family",
              status: "fresh",
              syncedAt: "2026-05-10T14:00:00.000Z",
              error: null,
            },
          ],
          timeMin: "2026-05-10T15:00:00.000Z",
          timeMax: "2026-05-11T15:00:00.000Z",
          syncedAt: "2026-05-10T14:00:00.000Z",
        }),
      }),
    });

    const result = await invoke(
      action,
      {
        subaction: "scan_event_proposal",
        range: {
          start: "2026-05-10T15:00:00.000Z",
          end: "2026-05-11T15:00:00.000Z",
        },
        proposal: {
          startISO: "2026-05-11T00:00:00.000Z",
          endISO: "2026-05-11T01:00:00.000Z",
        },
      },
      testRuntime,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        completeness: "complete",
        conflicts: [
          {
            severity: "warning",
            reasons: ["time_overlap", "all_day"],
            eventB: {
              id: "apple-school-closure",
              startISO: "2026-05-10T15:00:00.000Z",
              endISO: "2026-05-11T15:00:00.000Z",
            },
          },
        ],
      },
    });
  });

  it("uses the real CalendarService loader and fails honestly when it is absent", async () => {
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "UTC",
    });
    const result = await invoke(action, { subaction: "scan_today" });

    expect(result).toMatchObject({
      success: false,
      data: { error: "CALENDAR_UNAVAILABLE" },
    });
    expect(String(result.text)).not.toMatch(/no conflicts/i);
  });

  it("fails instead of silently ignoring malformed provider intervals", async () => {
    const action = testAction({
      feed: [
        {
          ...OWNER_EVENT,
          startISO: "not-a-date",
        },
      ],
    });
    const result = await invoke(action, { subaction: "scan_today" });

    expect(result).toMatchObject({
      success: false,
      data: { error: "CALENDAR_INVALID_DATA" },
    });
  });
});
