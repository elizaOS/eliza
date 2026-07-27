/**
 * Multi-account source identity and partial-failure semantics against real
 * PGlite persistence, with only the external Google transport substituted.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { GoogleCalendarSyncTokenExpiredError } from "@elizaos/plugin-google";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetConflictDetectLoaderForTests,
  createConflictDetectAction,
} from "../src/actions/conflict-detect.js";
import {
  type CalendarHostGate,
  CalendarService,
} from "../src/service/index.js";

const AGENT_ID = "calendar-source-health-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const TIME_MIN = "2026-07-27T00:00:00.000Z";
const TIME_MAX = "2026-07-28T00:00:00.000Z";

const CREATE_EVENTS_TABLE = `CREATE TABLE app_calendar.life_calendar_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  connector_account_id TEXT,
  purge_resync_required BOOLEAN NOT NULL DEFAULT false,
  purge_resync_reason TEXT,
  grant_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_all_day BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT,
  html_link TEXT,
  conference_link TEXT,
  organizer_json TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT calendar_events_source_external_unique
    UNIQUE (agent_id, provider, side, grant_id, calendar_id, external_event_id)
)`;

const CREATE_SYNC_TABLE = `CREATE TABLE app_calendar.life_calendar_sync_states (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  connector_account_id TEXT,
  grant_id TEXT,
  purge_resync_required BOOLEAN NOT NULL DEFAULT false,
  purge_resync_reason TEXT,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  next_sync_token TEXT,
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT calendar_sync_states_source_unique
    UNIQUE (agent_id, provider, side, grant_id, calendar_id)
)`;

function grant(accountId: string): LifeOpsConnectorGrant {
  const timestamp = "2026-07-26T00:00:00.000Z";
  return {
    id: `connector-account:${accountId}`,
    agentId: AGENT_ID,
    provider: "google",
    connectorAccountId: accountId,
    side: "owner",
    identity: { email: `${accountId}@example.test` },
    identityEmail: `${accountId}@example.test`,
    grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    capabilities: ["google.calendar.read"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function status(
  sourceGrant: LifeOpsConnectorGrant,
): LifeOpsGoogleConnectorStatus {
  return {
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
    preferredByAgent: false,
    cloudConnectionId: null,
    identity: sourceGrant.identity,
    grantedCapabilities: ["google.calendar.read"],
    grantedScopes: [...sourceGrant.grantedScopes],
    expiresAt: null,
    hasRefreshToken: true,
    grant: sourceGrant,
  };
}

const GRANT_A = grant("account-a");
const GRANT_B = grant("account-b");

function googleEvent(accountId: string) {
  return {
    id: "same-provider-event-id",
    calendarId: "primary",
    title: `Family logistics (${accountId})`,
    status: "confirmed",
    start: "2026-07-27T16:00:00.000Z",
    end: "2026-07-27T17:00:00.000Z",
    isAllDay: false,
    timeZone: "UTC",
    htmlLink: null,
    meetLink: null,
    attendees: [],
    location: "",
    description: "",
    organizer: null,
    recurrence: null,
    recurringEventId: null,
    metadata: {},
  };
}

let pg: PGlite;
let calendar: CalendarService;
let runtime: IAgentRuntime;
let failAccountA = false;
let failAccountB = false;
let incrementalSyncEnabled = false;
let expireSyncTokenForAccount: string | null = null;
let accountAAccessRole = "owner";
const freeBusyErrors = new Map<string, Set<string>>();
const freeBusyRequests: Array<{
  accountId: string;
  calendarIds: readonly string[];
}> = [];
const eventPageRequests: Array<{
  accountId: string;
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
}> = [];

async function runConflictAction(parameters: Record<string, unknown>) {
  const action = createConflictDetectAction({
    authorize: async () => true,
    resolveTimeZone: async () => "UTC",
  });
  return action.handler(
    runtime,
    {
      id: "00000000-0000-0000-0000-000000000201",
      entityId: "00000000-0000-0000-0000-000000000202",
      roomId: "00000000-0000-0000-0000-000000000203",
      content: { text: "check this time" },
    } as Memory,
    undefined,
    { parameters },
    undefined,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_calendar"));
  await db.execute(sql.raw(CREATE_EVENTS_TABLE));
  await db.execute(sql.raw(CREATE_SYNC_TABLE));

  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    getCache: async () => undefined,
    setCache: async () => undefined,
    reportError: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getService: (name: string) =>
      name === "calendar"
        ? calendar
        : name === "google"
          ? {
              listCalendars: async (request: { accountId: string }) => [
                {
                  calendarId: "primary",
                  summary: "Primary",
                  description: null,
                  primary: true,
                  accessRole:
                    request.accountId === "account-a"
                      ? accountAAccessRole
                      : "owner",
                  backgroundColor: null,
                  foregroundColor: null,
                  timeZone: "UTC",
                  selected: true,
                },
              ],
              listEventPage: async (request: {
                accountId: string;
                syncToken?: string;
                timeMin?: string;
                timeMax?: string;
              }) => {
                const { accountId } = request;
                eventPageRequests.push({ ...request });
                if (
                  (accountId === "account-a" && failAccountA) ||
                  (accountId === "account-b" && failAccountB)
                ) {
                  throw new Error(`calendar transport failed for ${accountId}`);
                }
                if (
                  request.syncToken &&
                  expireSyncTokenForAccount === accountId
                ) {
                  expireSyncTokenForAccount = null;
                  throw new GoogleCalendarSyncTokenExpiredError({
                    resource: "events",
                    accountId,
                    calendarId: "primary",
                    cause: new Error("HTTP 410 Gone"),
                  });
                }
                if (request.syncToken) {
                  return {
                    events:
                      accountId === "account-a"
                        ? [
                            {
                              id: "same-provider-event-id",
                              calendarId: "primary",
                              status: "cancelled",
                            },
                          ]
                        : [
                            {
                              ...googleEvent(accountId),
                              title: "Updated family logistics",
                            },
                          ],
                    nextPageToken: null,
                    nextSyncToken: `sync-${accountId}-2`,
                  };
                }
                return {
                  events: [googleEvent(accountId)],
                  nextPageToken: null,
                  nextSyncToken: incrementalSyncEnabled
                    ? `sync-${accountId}-1`
                    : null,
                };
              },
              queryFreeBusy: async (request: {
                accountId: string;
                calendarIds: readonly string[];
                timeMin: string;
                timeMax: string;
              }) => {
                freeBusyRequests.push({
                  accountId: request.accountId,
                  calendarIds: [...request.calendarIds],
                });
                const failing =
                  freeBusyErrors.get(request.accountId) ?? new Set<string>();
                return {
                  timeMin: request.timeMin,
                  timeMax: request.timeMax,
                  calendars: Object.fromEntries(
                    request.calendarIds.map((calendarId) => [
                      calendarId,
                      {
                        busy: failing.has(calendarId)
                          ? []
                          : [
                              {
                                start: "2026-07-27T15:30:00.000Z",
                                end: "2026-07-27T16:00:00.000Z",
                              },
                            ],
                        errors: failing.has(calendarId)
                          ? [{ domain: "calendar", reason: "notFound" }]
                          : [],
                      },
                    ]),
                  ),
                };
              },
            }
          : null,
  } as unknown as IAgentRuntime;

  const gate: CalendarHostGate = {
    getGoogleConnectorAccounts: async () => [status(GRANT_A), status(GRANT_B)],
    requireGoogleCalendarGrant: async (_requestUrl, _mode, _side, grantId) => {
      const resolved = [GRANT_A, GRANT_B].find(
        (candidate) => candidate.id === grantId,
      );
      if (!resolved) {
        throw new Error(`Unknown test grant: ${grantId}`);
      }
      return resolved;
    },
    requireGoogleCalendarWriteGrant: async () => GRANT_A,
    createReminderPlan: async () => undefined,
    updateReminderPlan: async () => undefined,
    deleteReminderPlan: async () => undefined,
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => undefined,
  };

  calendar = new CalendarService(runtime);
  calendar.setGate(gate);
});

beforeEach(async () => {
  failAccountA = false;
  failAccountB = false;
  incrementalSyncEnabled = false;
  expireSyncTokenForAccount = null;
  accountAAccessRole = "owner";
  freeBusyErrors.clear();
  freeBusyRequests.length = 0;
  __resetConflictDetectLoaderForTests();
  eventPageRequests.length = 0;
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
});

afterAll(async () => {
  await pg.close();
});

describe("CalendarService source truth", () => {
  it("keeps identical calendar and event ids distinct across accounts", async () => {
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      {
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
        forceSync: true,
      },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(2);
    expect(new Set(feed.events.map((event) => event.id)).size).toBe(2);
    expect(new Set(feed.sources.map((source) => source.key.grantId))).toEqual(
      new Set([GRANT_A.id, GRANT_B.id]),
    );
  });

  it("returns a partial feed when one live account fails", async () => {
    failAccountB = true;
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      {
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
        forceSync: true,
      },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(feed.state).toBe("partial");
    expect(feed.events).toHaveLength(1);
    expect(
      feed.sources.find((source) => source.key.grantId === GRANT_B.id)?.status,
    ).toBe("error");
  });

  it("retains a failed account as explicitly stale when cache exists", async () => {
    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );
    failAccountB = true;

    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    expect(feed.state).toBe("partial");
    expect(feed.events).toHaveLength(2);
    const stale = feed.sources.find(
      (source) => source.key.grantId === GRANT_B.id,
    );
    expect(stale?.status).toBe("stale");
    expect(stale?.error?.code).toBe("CALENDAR_SOURCE_ERROR");
  });

  it("never reports a healthy empty feed when every source fails", async () => {
    failAccountA = true;
    failAccountB = true;

    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      {
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
        forceSync: true,
      },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expect(feed.events).toEqual([]);
    expect(feed.state).toBe("unavailable");
    expect(feed.sources.every((source) => source.status === "error")).toBe(
      true,
    );
  });

  it("applies account-scoped incremental tombstones and updates without rereading full windows", async () => {
    incrementalSyncEnabled = true;
    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    eventPageRequests.length = 0;
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]?.grantId).toBe(GRANT_B.id);
    expect(feed.events[0]?.title).toBe("Updated family logistics");
    expect(eventPageRequests).toHaveLength(2);
    expect(
      eventPageRequests.every(
        (request) =>
          Boolean(request.syncToken) &&
          request.timeMin === undefined &&
          request.timeMax === undefined,
      ),
    ).toBe(true);
  });

  it("recovers an expired account cursor with a full snapshot while other accounts stay incremental", async () => {
    incrementalSyncEnabled = true;
    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );

    expireSyncTokenForAccount = "account-a";
    eventPageRequests.length = 0;
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events).toHaveLength(2);
    expect(
      eventPageRequests.filter((request) => request.accountId === "account-a"),
    ).toHaveLength(2);
    expect(
      eventPageRequests.some(
        (request) => request.accountId === "account-a" && !request.syncToken,
      ),
    ).toBe(true);
  });

  it("resolves each guest through eligible owner accounts without returning guest identifiers", async () => {
    const firstGuest = "child-one@example.test";
    const secondGuest = "child-two@example.test";
    freeBusyErrors.set("account-a", new Set([secondGuest]));

    const result = await calendar.getCalendarFreeBusy(INTERNAL_URL, {
      calendarIds: [firstGuest, secondGuest],
      timeMin: "2026-07-27T15:30:00.000Z",
      timeMax: "2026-07-27T16:00:00.000Z",
      timeZone: "UTC",
    });

    expect(freeBusyRequests).toEqual([
      {
        accountId: "account-a",
        calendarIds: [firstGuest, secondGuest],
      },
      { accountId: "account-b", calendarIds: [secondGuest] },
    ]);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.status === "fresh")).toBe(
      true,
    );
    expect(
      result.sources.every((source) => source.visibility === "busy_only"),
    ).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(firstGuest);
    expect(serialized).not.toContain(secondGuest);
    expect(serialized).not.toContain("notFound");
  });

  it("fails closed per guest when every owner account lacks that calendar", async () => {
    const firstGuest = "child-one@example.test";
    const missingGuest = "unshared-child@example.test";
    freeBusyErrors.set("account-a", new Set([missingGuest]));
    freeBusyErrors.set("account-b", new Set([missingGuest]));

    const result = await calendar.getCalendarFreeBusy(INTERNAL_URL, {
      calendarIds: [firstGuest, missingGuest],
      timeMin: "2026-07-27T15:30:00.000Z",
      timeMax: "2026-07-27T16:00:00.000Z",
    });

    expect(result.sources.map((source) => source.status)).toEqual([
      "fresh",
      "error",
    ]);
    expect(JSON.stringify(result)).not.toContain(missingGuest);
  });

  it("uses production free/busy by default and exposes only anonymous busy conflicts", async () => {
    const result = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T15:30:00.000Z",
        end: "2026-07-27T16:00:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T15:30:00.000Z",
        endISO: "2026-07-27T16:00:00.000Z",
        attendees: ["child@example.test"],
      },
    })) as {
      success: boolean;
      data: {
        completeness: string;
        conflicts: Array<{
          eventA: { title: string; kind: string; attendees: string[] };
          eventB: { title: string; kind: string; attendees: string[] };
        }>;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data.completeness).toBe("complete");
    const busy = result.data.conflicts
      .flatMap((conflict) => [conflict.eventA, conflict.eventB])
      .find((event) => event.kind === "guest_busy");
    expect(busy).toMatchObject({
      title: "Busy",
      kind: "guest_busy",
      attendees: [],
    });
  });

  it("propagates freeBusyReader visibility into anonymous owner-calendar conflicts", async () => {
    accountAAccessRole = "freeBusyReader";
    const feed = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );
    const privateSource = feed.sources.find(
      (source) => source.key.grantId === GRANT_A.id,
    );
    expect(privateSource).toMatchObject({
      accessRole: "freeBusyReader",
      visibility: "busy_only",
    });

    const result = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T16:15:00.000Z",
        end: "2026-07-27T16:30:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T16:15:00.000Z",
        endISO: "2026-07-27T16:30:00.000Z",
      },
    })) as { data: { conflicts: unknown[] } };

    expect(JSON.stringify(result.data.conflicts)).not.toContain(
      "Family logistics (account-a)",
    );
    expect(JSON.stringify(result.data.conflicts)).toContain('"title":"Busy"');
  });

  it("persists idempotent travel and hold reservations that block through the real feed", async () => {
    const initial = await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:00:00.000Z"),
    );
    const parent = initial.events.find((event) => event.grantId === GRANT_A.id);
    expect(parent).toBeDefined();
    if (!parent) return;

    await calendar.reserveTravelBuffer({
      eventId: parent.id,
      bufferMinutes: 30,
      method: "driving",
    });
    await calendar.reserveTravelBuffer({
      eventId: parent.id,
      bufferMinutes: 30,
      method: "driving",
    });
    await calendar.reserveCalendarAvailability({
      eventId: parent.id,
      kind: "hold",
      startAt: "2026-07-27T14:00:00.000Z",
      endAt: "2026-07-27T14:30:00.000Z",
      idempotencyKey: "school-pickup-hold",
    });

    const rows = await pg.query<{
      metadata_json: string;
      start_at: string;
      end_at: string;
    }>(
      "SELECT metadata_json, start_at, end_at FROM app_calendar.life_calendar_events WHERE metadata_json LIKE '%locallyManagedAvailability%' ORDER BY start_at",
    );
    expect(rows.rows).toHaveLength(2);
    const travelRow = rows.rows.find((row) =>
      row.metadata_json.includes('"availabilityKind":"travel"'),
    );
    expect(travelRow).toMatchObject({
      start_at: "2026-07-27T15:30:00.000Z",
      end_at: "2026-07-27T16:00:00.000Z",
    });

    await calendar.getCalendarFeed(
      INTERNAL_URL,
      { timeMin: TIME_MIN, timeMax: TIME_MAX, forceSync: true },
      new Date("2026-07-26T12:01:00.000Z"),
    );

    const travelResult = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T15:45:00.000Z",
        end: "2026-07-27T16:00:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T15:45:00.000Z",
        endISO: "2026-07-27T16:00:00.000Z",
      },
    })) as {
      data: {
        conflicts: Array<{
          reasons: string[];
          eventA: { kind: string };
          eventB: { kind: string };
        }>;
      };
    };
    expect(
      travelResult.data.conflicts.some(
        (conflict) =>
          conflict.reasons.includes("travel") &&
          [conflict.eventA.kind, conflict.eventB.kind].includes("travel"),
      ),
    ).toBe(true);

    const holdResult = (await runConflictAction({
      action: "scan_event_proposal",
      range: {
        start: "2026-07-27T14:15:00.000Z",
        end: "2026-07-27T14:30:00.000Z",
      },
      proposal: {
        startISO: "2026-07-27T14:15:00.000Z",
        endISO: "2026-07-27T14:30:00.000Z",
      },
    })) as {
      data: {
        conflicts: Array<{
          eventA: { kind: string };
          eventB: { kind: string };
        }>;
      };
    };
    expect(
      holdResult.data.conflicts.some((conflict) =>
        [conflict.eventA.kind, conflict.eventB.kind].includes("hold"),
      ),
    ).toBe(true);
  });
});
