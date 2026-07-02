/**
 * Multi-account prune scoping — real PGlite.
 *
 * Every Google account names its default calendar "primary", so two connected
 * accounts produce cached events with identical (agent_id, provider, side,
 * calendar_id) tuples that differ only by grant_id. The window prune that runs
 * on every feed sync keeps only the syncing grant's event ids, so before the
 * grant scope was added, account A's sync deleted account B's cached "primary"
 * events (and their reminder plans) on every alternating sync.
 *
 * Two layers are covered against a live PGlite database:
 *   1. `CalendarRepository.pruneCalendarEventsInWindow` — grant-scoped prune
 *      deletes only the syncing grant's stale rows (plus unattributed legacy
 *      rows) and never another grant's rows.
 *   2. `CalendarService.getCalendarFeed` (Google provider, gate + google
 *      service mocked, DB real) — alternating syncs of two accounts' "primary"
 *      calendars leave both accounts' events cached.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsConnectorGrant,
} from "@elizaos/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CalendarHostGate,
  CalendarRepository,
  CalendarService,
} from "../src/service/index.js";

const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const AGENT_ID = "agent-prune-scope-test";

const WINDOW_MIN = "2026-06-01T00:00:00.000Z";
const WINDOW_MAX = "2026-06-08T00:00:00.000Z";

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
  UNIQUE (agent_id, provider, side, calendar_id, external_event_id)
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
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, provider, side, calendar_id)
)`;

function googleGrant(accountId: string): LifeOpsConnectorGrant {
  return {
    id: `connector-account:${accountId}`,
    agentId: AGENT_ID,
    provider: "google",
    connectorAccountId: accountId,
    side: "owner",
    identity: { email: `${accountId}@example.com` },
    identityEmail: `${accountId}@example.com`,
    grantedScopes: ["https://www.googleapis.com/auth/calendar.events"],
    capabilities: ["google.calendar.read", "google.calendar.write"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

const GRANT_A = googleGrant("acct-a");
const GRANT_B = googleGrant("acct-b");

/** Google event shape as produced by @elizaos/plugin-google's mapEvent. */
function googleEvent(externalId: string, title: string) {
  return {
    id: externalId,
    calendarId: "primary",
    title,
    status: "confirmed",
    start: "2026-06-03T15:00:00.000Z",
    end: "2026-06-03T16:00:00.000Z",
    isAllDay: false,
    timeZone: "UTC",
    htmlLink: null,
    meetLink: null,
    attendees: [],
    location: "",
    description: "",
    organizer: null,
    metadata: {},
  };
}

/** Per-account Google event fixtures the fake `google` service serves. */
const GOOGLE_EVENTS_BY_ACCOUNT: Record<
  string,
  ReturnType<typeof googleEvent>[]
> = {
  "acct-a": [googleEvent("evt-a-1", "Standup (account A)")],
  "acct-b": [googleEvent("evt-b-1", "Design review (account B)")],
};

function cachedEvent(args: {
  externalId: string;
  grantId: string | undefined;
  title: string;
}): LifeOpsCalendarEvent {
  return {
    id: `${AGENT_ID}:google:owner:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-06-03T15:00:00.000Z",
    endAt: "2026-06-03T16:00:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    grantId: args.grantId,
  };
}

function gateForBothGrants(): CalendarHostGate {
  const requireGrant = async (
    _requestUrl: URL,
    _mode?: unknown,
    _side?: unknown,
    grantId?: string,
  ) => {
    const grant = [GRANT_A, GRANT_B].find((entry) => entry.id === grantId);
    if (!grant) {
      throw new Error(`unexpected grantId in test gate: ${grantId}`);
    }
    return grant;
  };
  return {
    getGoogleConnectorAccounts: async () => [],
    requireGoogleCalendarGrant: requireGrant,
    requireGoogleCalendarWriteGrant: requireGrant,
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  } as unknown as CalendarHostGate;
}

let pg: PGlite;
let runtime: IAgentRuntime;
let repository: CalendarRepository;
let calendar: CalendarService;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_calendar"));
  await db.execute(sql.raw(CREATE_EVENTS_TABLE));
  await db.execute(sql.raw(CREATE_SYNC_TABLE));

  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getCache: async () => undefined,
    setCache: async () => undefined,
    getService: (name: string) =>
      name === "google"
        ? {
            listEvents: async (args: { accountId: string }) =>
              GOOGLE_EVENTS_BY_ACCOUNT[args.accountId] ?? [],
          }
        : null,
  } as unknown as IAgentRuntime;

  repository = new CalendarRepository(runtime);
  calendar = new CalendarService(runtime);
  calendar.setGate(gateForBothGrants());
});

afterAll(async () => {
  await pg.close();
});

async function listPrimaryEvents(): Promise<LifeOpsCalendarEvent[]> {
  return repository.listCalendarEvents(
    AGENT_ID,
    "google",
    WINDOW_MIN,
    WINDOW_MAX,
    "owner",
  );
}

async function clearEvents(): Promise<void> {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
}

describe("CalendarRepository.pruneCalendarEventsInWindow — grant scoping", () => {
  it("prunes only the syncing grant's stale rows; another grant's rows survive", async () => {
    await clearEvents();
    await repository.upsertCalendarEvent(
      cachedEvent({
        externalId: "evt-a-1",
        grantId: GRANT_A.id,
        title: "A keep",
      }),
    );
    await repository.upsertCalendarEvent(
      cachedEvent({
        externalId: "evt-a-stale",
        grantId: GRANT_A.id,
        title: "A stale",
      }),
    );
    await repository.upsertCalendarEvent(
      cachedEvent({
        externalId: "evt-b-1",
        grantId: GRANT_B.id,
        title: "B keep",
      }),
    );

    // Grant A syncs: Google now returns only evt-a-1 for account A.
    await repository.pruneCalendarEventsInWindow(
      AGENT_ID,
      "google",
      "primary",
      WINDOW_MIN,
      WINDOW_MAX,
      ["evt-a-1"],
      "owner",
      GRANT_A.id,
    );

    const remaining = await listPrimaryEvents();
    const externalIds = remaining.map((event) => event.externalId).sort();
    // A's stale row is pruned; A's kept row and B's row both survive.
    expect(externalIds).toEqual(["evt-a-1", "evt-b-1"]);
  });

  it("prunes unattributed legacy rows (grant_id IS NULL) so they converge instead of going stale", async () => {
    await clearEvents();
    await repository.upsertCalendarEvent(
      cachedEvent({
        externalId: "evt-legacy",
        grantId: undefined,
        title: "Legacy row without grant attribution",
      }),
    );

    await repository.pruneCalendarEventsInWindow(
      AGENT_ID,
      "google",
      "primary",
      WINDOW_MIN,
      WINDOW_MAX,
      ["evt-a-1"],
      "owner",
      GRANT_A.id,
    );

    const remaining = await listPrimaryEvents();
    expect(remaining.some((event) => event.externalId === "evt-legacy")).toBe(
      false,
    );
  });

  it("keeps the unscoped prune behavior when no grant is given (Apple path)", async () => {
    await clearEvents();
    await repository.upsertCalendarEvent(
      cachedEvent({
        externalId: "evt-a-1",
        grantId: GRANT_A.id,
        title: "A row",
      }),
    );
    await repository.upsertCalendarEvent(
      cachedEvent({
        externalId: "evt-b-1",
        grantId: GRANT_B.id,
        title: "B row",
      }),
    );

    await repository.pruneCalendarEventsInWindow(
      AGENT_ID,
      "google",
      "primary",
      WINDOW_MIN,
      WINDOW_MAX,
      [],
      "owner",
    );

    expect(await listPrimaryEvents()).toEqual([]);
  });
});

describe("CalendarService feed sync — two Google accounts, both named 'primary'", () => {
  it("alternating syncs do not cross-delete the other account's cached events", async () => {
    await clearEvents();

    const syncFeed = (grantId: string) =>
      calendar.getCalendarFeed(
        INTERNAL_URL,
        {
          grantId,
          calendarId: "primary",
          timeMin: WINDOW_MIN,
          timeMax: WINDOW_MAX,
          forceSync: true,
        },
        new Date("2026-06-02T12:00:00.000Z"),
      );

    await syncFeed(GRANT_A.id);
    let cached = await listPrimaryEvents();
    expect(cached.map((event) => event.externalId)).toEqual(["evt-a-1"]);

    // Account B syncs the SAME calendarId ("primary"). Before the grant-scoped
    // prune, this deleted account A's cached events.
    await syncFeed(GRANT_B.id);
    cached = await listPrimaryEvents();
    expect(cached.map((event) => event.externalId).sort()).toEqual([
      "evt-a-1",
      "evt-b-1",
    ]);

    // And the reverse pass must not delete account B's events either.
    await syncFeed(GRANT_A.id);
    cached = await listPrimaryEvents();
    expect(cached.map((event) => event.externalId).sort()).toEqual([
      "evt-a-1",
      "evt-b-1",
    ]);

    const grantsById = new Map(
      cached.map((event) => [event.externalId, event.grantId]),
    );
    expect(grantsById.get("evt-a-1")).toBe(GRANT_A.id);
    expect(grantsById.get("evt-b-1")).toBe(GRANT_B.id);
  });
});
