/**
 * Guarded ICS subscriptions are exercised through CalendarService against real
 * PGlite tables. Only the HTTP wire and secrets backend are in-memory; source
 * leases, health, validators, events, tombstones, and reconciliation are real.
 */

import { PGlite } from "@electric-sql/pglite";
import { type IAgentRuntime, SECRETS_SERVICE_TYPE } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createCalendarFeedConflictLoader } from "../src/actions/conflict-detect.js";
import {
  type CalendarHostGate,
  CalendarService,
} from "../src/service/index.js";

const AGENT_ID = "ics-pglite-agent";
const SOURCE_URL =
  "https://calendar.example.test/private/family.ics?token=never-in-db";
const WINDOW = {
  timeMin: "2026-07-01T00:00:00.000Z",
  timeMax: "2026-07-03T00:00:00.000Z",
};

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
  UNIQUE (
    agent_id, provider, side, grant_id, calendar_id, external_event_id
  )
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
  UNIQUE (agent_id, provider, side, grant_id, calendar_id)
)`;

const CREATE_SOURCES_TABLE = `CREATE TABLE app_calendar.life_calendar_sources (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ics',
  side TEXT NOT NULL DEFAULT 'owner',
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  secret_ref TEXT NOT NULL,
  url_fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  content_hash TEXT,
  sync_status TEXT NOT NULL DEFAULT 'never',
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_retryable BOOLEAN,
  last_synced_at TEXT,
  last_attempted_at TEXT,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, url_fingerprint)
)`;

function gate(): CalendarHostGate {
  return {
    getGoogleConnectorAccounts: async () => [],
    requireGoogleCalendarGrant: async () => {
      throw new Error("Google is outside this test.");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("Google is outside this test.");
    },
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

function vevent(args: {
  uid: string;
  title: string;
  sequence?: number;
  revision?: string;
  status?: string;
  recurrenceId?: string;
}): string {
  return [
    "BEGIN:VEVENT",
    `UID:${args.uid}`,
    `SEQUENCE:${args.sequence ?? 0}`,
    `LAST-MODIFIED:${args.revision ?? "20260701T080000Z"}`,
    `DTSTAMP:${args.revision ?? "20260701T080000Z"}`,
    "DTSTART:20260701T100000Z",
    "DTEND:20260701T110000Z",
    ...(args.recurrenceId ? [`RECURRENCE-ID:${args.recurrenceId}`] : []),
    `SUMMARY:${args.title}`,
    ...(args.status ? [`STATUS:${args.status}`] : []),
    "END:VEVENT",
  ].join("\r\n");
}

function calendar(...events: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//elizaOS//ICS integration test//EN",
    ...events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function response(
  body: string,
  args: { etag?: string; lastModified?: string } = {},
): Response {
  const headers = new Headers({ "content-type": "text/calendar" });
  if (args.etag) headers.set("etag", args.etag);
  if (args.lastModified) headers.set("last-modified", args.lastModified);
  return new Response(body, { status: 200, headers });
}

let pg: PGlite;
let runtime: IAgentRuntime;
let service: CalendarService;
const secrets = new Map<string, string>();

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_calendar"));
  await db.execute(sql.raw(CREATE_EVENTS_TABLE));
  await db.execute(sql.raw(CREATE_SYNC_TABLE));
  await db.execute(sql.raw(CREATE_SOURCES_TABLE));
  const secretsService = {
    getGlobal: async (key: string) => secrets.get(key) ?? null,
    setGlobal: async (key: string, value: string) => {
      secrets.set(key, value);
      return true;
    },
    delete: async (key: string) => secrets.delete(key),
  };
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    getService: (serviceType: string) =>
      serviceType === SECRETS_SERVICE_TYPE
        ? secretsService
        : serviceType === "calendar"
          ? service
          : null,
    getCache: async () => undefined,
    setCache: async () => undefined,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate(gate());
});

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_sources");
  secrets.clear();
  vi.clearAllMocks();
});

afterAll(async () => {
  await pg.close();
});

async function createSource(url = SOURCE_URL) {
  return service.createIcsCalendarSource({
    name: "Family calendar",
    url,
  });
}

async function syncBody(
  sourceId: string,
  body: string,
  args: {
    now?: Date;
    leaseMs?: number;
    etag?: string;
    lastModified?: string;
  } = {},
) {
  return service.syncIcsCalendarSource(sourceId, {
    now: args.now,
    leaseMs: args.leaseMs,
    transport: {
      fetchImpl: async () =>
        response(body, {
          etag: args.etag,
          lastModified: args.lastModified,
        }),
    },
  });
}

describe("CalendarService guarded ICS sources (real PGlite)", () => {
  it("persists only a secret reference, fingerprint, and origin across restart", async () => {
    const created = await createSource();
    const raw = await pg.query<Record<string, unknown>>(
      "SELECT * FROM app_calendar.life_calendar_sources",
    );
    const persisted = JSON.stringify(raw.rows);

    expect(created).not.toHaveProperty("url");
    expect(created).not.toHaveProperty("secretRef");
    expect(created.origin).toBe("https://calendar.example.test");
    expect(persisted).not.toContain("/private/family.ics");
    expect(persisted).not.toContain("never-in-db");
    expect(secrets.size).toBe(1);
    expect([...secrets.values()]).toEqual([SOURCE_URL]);

    const restarted = new CalendarService(runtime);
    restarted.setGate(gate());
    await expect(restarted.listIcsCalendarSources()).resolves.toEqual([
      created,
    ]);
  });

  it("sends durable validators and preserves events on a 304", async () => {
    const source = await createSource();
    await syncBody(source.id, calendar(vevent({ uid: "a", title: "School" })), {
      etag: '"revision-1"',
      lastModified: "Wed, 01 Jul 2026 08:00:00 GMT",
    });
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("if-none-match")).toBe('"revision-1"');
        expect(headers.get("if-modified-since")).toBe(
          "Wed, 01 Jul 2026 08:00:00 GMT",
        );
        return new Response(null, { status: 304 });
      },
    );

    const result = await service.syncIcsCalendarSource(source.id, {
      transport: { fetchImpl },
    });
    const events = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );

    expect(result.outcome).toBe("not_modified");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(events.rows).toEqual([{ title: "School" }]);
  });

  it("rejects a 304 before any durable snapshot exists", async () => {
    const source = await createSource();
    await expect(
      service.syncIcsCalendarSource(source.id, {
        transport: {
          fetchImpl: async () => new Response(null, { status: 304 }),
        },
      }),
    ).rejects.toMatchObject({
      code: "ICS_UNEXPECTED_NOT_MODIFIED",
    });
    const listed = await service.listIcsCalendarSources();
    const events = await pg.query(
      "SELECT id FROM app_calendar.life_calendar_events",
    );
    expect(listed[0]).toMatchObject({
      syncStatus: "error",
      lastSyncedAt: null,
      error: { code: "ICS_UNEXPECTED_NOT_MODIFIED" },
    });
    expect(events.rows).toEqual([]);
  });

  it("atomically retires the previous snapshot when its URL rotates", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        vevent({ uid: "old-a", title: "Old school event" }),
        vevent({ uid: "old-b", title: "Old sports event" }),
      ),
    );
    const replacementUrl =
      "https://replacement.example.test/new/family.ics?token=new-secret";
    const updated = await service.updateIcsCalendarSource(source.id, {
      url: replacementUrl,
    });
    const afterRotation = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );
    expect(updated).toMatchObject({
      syncStatus: "never",
      lastSyncedAt: null,
      origin: "https://replacement.example.test",
    });
    expect(afterRotation.rows).toEqual([]);
    expect([...secrets.values()]).toEqual([replacementUrl]);

    const malformed = [
      "BEGIN:VEVENT",
      "UID:broken",
      "SUMMARY:No dates",
      "END:VEVENT",
    ].join("\r\n");
    const partial = await syncBody(
      source.id,
      calendar(vevent({ uid: "new-a", title: "New family event" }), malformed),
    );
    const afterPartial = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );
    expect(partial.outcome).toBe("partial");
    expect(afterPartial.rows).toEqual([{ title: "New family event" }]);
  });

  it("keeps absent events after a partial parse but prunes them on a complete snapshot", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        vevent({ uid: "a", title: "School" }),
        vevent({ uid: "b", title: "Soccer" }),
      ),
    );
    const malformed = [
      "BEGIN:VEVENT",
      "UID:broken",
      "SUMMARY:No dates",
      "END:VEVENT",
    ].join("\r\n");
    const partial = await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "School updated",
          sequence: 1,
          revision: "20260701T090000Z",
        }),
        malformed,
      ),
    );
    let titles = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events ORDER BY title",
    );
    expect(partial.outcome).toBe("partial");
    expect(partial.source.error?.code).toBe("ICS_FEED_PARTIAL_PARSE");
    expect(titles.rows.map((row) => row.title)).toEqual([
      "School updated",
      "Soccer",
    ]);

    const complete = await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "School final",
          sequence: 2,
          revision: "20260701T100000Z",
        }),
      ),
    );
    titles = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );
    expect(complete.prunedEvents).toBe(1);
    expect(titles.rows).toEqual([{ title: "School final" }]);
  });

  it("stores cancellation tombstones and never returns them in the feed", async () => {
    const source = await createSource();
    await syncBody(source.id, calendar(vevent({ uid: "a", title: "School" })));
    const cancelled = await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "School",
          sequence: 1,
          revision: "20260701T090000Z",
          status: "CANCELLED",
        }),
      ),
    );
    const raw = await pg.query<{ status: string }>(
      "SELECT status FROM app_calendar.life_calendar_events",
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      { grantId: source.id, ...WINDOW },
      new Date(),
    );

    expect(cancelled.tombstones).toBe(1);
    expect(raw.rows).toEqual([{ status: "cancelled" }]);
    expect(feed.events).toEqual([]);
    expect(feed.sources).toEqual([
      expect.objectContaining({
        status: "fresh",
        key: expect.objectContaining({ provider: "ics" }),
      }),
    ]);

    const afterEmptySnapshot = await syncBody(source.id, calendar());
    const retained = await pg.query<{ status: string }>(
      "SELECT status FROM app_calendar.life_calendar_events",
    );
    expect(afterEmptySnapshot.prunedEvents).toBe(0);
    expect(retained.rows).toEqual([{ status: "cancelled" }]);
  });

  it("aggregates enabled subscriptions into feed and conflict evaluation", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(vevent({ uid: "a", title: "School pickup" })),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      { grantId: source.id, ...WINDOW },
      new Date(),
    );
    const conflictSnapshot = await createCalendarFeedConflictLoader().loadFeed({
      runtime,
      range: {
        start: WINDOW.timeMin,
        end: WINDOW.timeMax,
        timeZone: "UTC",
      },
    });

    expect(feed.events).toEqual([
      expect.objectContaining({
        title: "School pickup",
        provider: "ics",
        grantId: source.id,
      }),
    ]);
    expect(conflictSnapshot).toEqual({
      sources: [
        expect.objectContaining({
          status: "fresh",
          events: [
            expect.objectContaining({
              title: "School pickup",
              status: "confirmed",
            }),
          ],
        }),
      ],
    });
  });

  it("rejects an older SEQUENCE without overwriting the current event", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "Current",
          sequence: 5,
          revision: "20260701T120000Z",
        }),
      ),
    );
    const stale = await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "Stale",
          sequence: 4,
          revision: "20260701T130000Z",
        }),
      ),
    );
    const raw = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );

    expect(stale.acceptedEvents).toBe(0);
    expect(raw.rows).toEqual([{ title: "Current" }]);
  });

  it("uses LAST-MODIFIED when SEQUENCE values tie", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "First",
          sequence: 3,
          revision: "20260701T080000Z",
        }),
      ),
    );
    const newer = await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "Newer revision",
          sequence: 3,
          revision: "20260701T090000Z",
        }),
      ),
    );
    const older = await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "Older revision",
          sequence: 3,
          revision: "20260701T083000Z",
        }),
      ),
    );
    const raw = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );
    expect(newer.acceptedEvents).toBe(1);
    expect(older.acceptedEvents).toBe(0);
    expect(raw.rows).toEqual([{ title: "Newer revision" }]);
  });

  it("uses UID plus RECURRENCE-ID as the stable occurrence identity", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        vevent({ uid: "series-a", title: "Series master" }),
        vevent({
          uid: "series-a",
          title: "Moved occurrence",
          recurrenceId: "20260708T100000Z",
        }),
      ),
    );
    const raw = await pg.query<{
      external_event_id: string;
      metadata_json: string;
    }>(
      `SELECT external_event_id, metadata_json
         FROM app_calendar.life_calendar_events
        ORDER BY external_event_id`,
    );
    expect(raw.rows).toHaveLength(2);
    expect(new Set(raw.rows.map((row) => row.external_event_id)).size).toBe(2);
    expect(
      raw.rows.map((row) => JSON.parse(row.metadata_json).icsRecurrenceId),
    ).toEqual(expect.arrayContaining([null, "2026-07-08T10:00:00.000Z"]));
  });

  it("prevents a slower expired lease from overwriting a newer sync", async () => {
    const source = await createSource();
    let resolveOld: ((response: Response) => void) | null = null;
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const oldFetch = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
          markStarted?.();
        }),
    );
    const first = service.syncIcsCalendarSource(source.id, {
      now: new Date("2026-07-01T08:00:00.000Z"),
      leaseMs: 1,
      transport: { fetchImpl: oldFetch },
    });
    await started;

    await syncBody(
      source.id,
      calendar(
        vevent({
          uid: "a",
          title: "New generation",
          sequence: 2,
          revision: "20260701T090000Z",
        }),
      ),
      { now: new Date("2026-07-01T08:00:00.002Z") },
    );
    resolveOld?.(
      response(
        calendar(
          vevent({
            uid: "a",
            title: "Old generation",
            sequence: 1,
            revision: "20260701T080000Z",
          }),
        ),
      ),
    );

    await expect(first).rejects.toMatchObject({
      code: "ICS_SYNC_SUPERSEDED",
    });
    const raw = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );
    expect(raw.rows).toEqual([{ title: "New generation" }]);
  });

  it("fails closed on missing secrets and preserves the prior snapshot", async () => {
    const source = await createSource();
    await syncBody(source.id, calendar(vevent({ uid: "a", title: "School" })));
    secrets.clear();

    await expect(
      service.syncIcsCalendarSource(source.id),
    ).rejects.toMatchObject({
      code: "ICS_SECRET_MISSING",
    });
    const listed = await service.listIcsCalendarSources();
    const raw = await pg.query<{ title: string }>(
      "SELECT title FROM app_calendar.life_calendar_events",
    );
    expect(listed[0]?.error?.code).toBe("ICS_SECRET_MISSING");
    expect(raw.rows).toEqual([{ title: "School" }]);
  });

  it("fails closed on unresolved broker handles and SSRF targets", async () => {
    const brokered = await createSource();
    const secretKey = [...secrets.keys()][0];
    if (!secretKey) throw new Error("Expected the source secret key.");
    secrets.set(
      secretKey,
      'eliza:secret-handle:v1:{"marker":"eliza:secret-handle:v1","id":"h1","resolveVia":"credential-proxy"}',
    );
    await expect(
      service.syncIcsCalendarSource(brokered.id),
    ).rejects.toMatchObject({
      code: "ICS_SECRET_HANDLE_UNRESOLVED",
    });

    await pg.query("DELETE FROM app_calendar.life_calendar_sources");
    secrets.clear();
    const blocked = await createSource(
      "http://169.254.169.254/latest/meta-data/family.ics?token=blocked",
    );
    await expect(
      service.syncIcsCalendarSource(blocked.id),
    ).rejects.toMatchObject({
      code: "ICS_SOURCE_NETWORK_BLOCKED",
    });
    const listed = await service.listIcsCalendarSources();
    expect(listed[0]?.syncStatus).toBe("error");
  });
});
