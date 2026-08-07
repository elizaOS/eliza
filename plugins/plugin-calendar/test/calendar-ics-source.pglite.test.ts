/**
 * Guarded ICS subscriptions are exercised through CalendarService against real
 * PGlite tables. Only the HTTP wire and secrets backend are in-memory; source
 * leases, health, validators, events, tombstones, and reconciliation are real.
 */

import { PGlite } from "@electric-sql/pglite";
import { type IAgentRuntime, SECRETS_SERVICE_TYPE } from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql/runtime-migrator";
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
  calendarSchema,
} from "../src/service/index.js";

const AGENT_ID = "ics-pglite-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const SOURCE_URL =
  "https://calendar.example.test/private/family.ics?token=never-in-db";
const WINDOW = {
  timeMin: "2026-07-01T00:00:00.000Z",
  timeMax: "2026-07-03T00:00:00.000Z",
};

function gate(): CalendarHostGate {
  return {
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("Guest availability is outside this test.");
    },
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
let secretDeleteFailure = false;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  // Tables come from the production drizzle schema applied through plugin-sql's
  // RuntimeMigrator — the same path agent boot runs — so schema drift fails the
  // suite instead of leaving it green against a hand-maintained copy.
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  const secretsService = {
    getGlobal: async (key: string) => secrets.get(key) ?? null,
    setGlobal: async (key: string, value: string) => {
      secrets.set(key, value);
      return true;
    },
    delete: async (key: string) => {
      if (secretDeleteFailure) {
        throw new Error("Secret backend is unavailable.");
      }
      return secrets.delete(key);
    },
  };
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
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
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_sources");
  await pg.query("DELETE FROM app_calendar.life_calendar_secret_cleanup");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
  secrets.clear();
  secretDeleteFailure = false;
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

async function cleanupRows(): Promise<Array<Record<string, unknown>>> {
  return (
    await pg.query<Record<string, unknown>>(
      `SELECT *
         FROM app_calendar.life_calendar_secret_cleanup
        ORDER BY created_at ASC, id ASC`,
    )
  ).rows;
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

describe("CalendarService guarded ICS sources (real PGlite)", {
  timeout: 30_000,
}, () => {
  it("persists explicit source health when a guarded sync blocks the endpoint", async () => {
    const blockedUrl =
      "http://169.254.169.254/latest/meta-data/family.ics?token=private";
    const source = await service.createIcsCalendarSource({
      name: "Blocked endpoint calendar",
      url: blockedUrl,
    });
    await expect(
      service.syncIcsCalendarSource(source.id),
    ).rejects.toMatchObject({
      code: "ICS_SOURCE_NETWORK_BLOCKED",
    });
    const persisted = await pg.query<{
      id: string;
      sync_status: string;
      last_error_code: string | null;
    }>(
      `SELECT id, sync_status, last_error_code
         FROM app_calendar.life_calendar_sources`,
    );

    expect(persisted.rows).toEqual([
      expect.objectContaining({
        id: source.id,
        sync_status: "error",
        last_error_code: "ICS_SOURCE_NETWORK_BLOCKED",
      }),
    ]);
    expect(JSON.stringify(persisted.rows)).not.toContain(
      "169.254.169.254/latest/meta-data",
    );
    expect([...secrets.values()]).toEqual([blockedUrl]);
  });

  it("routes direct enabled updates through the exact-source CAS", async () => {
    const source = await createSource();
    const listed = await service.listCalendars(INTERNAL_URL, {
      grantId: source.id,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      calendarId: source.id,
      includeInFeed: true,
      selectionVersion: 0,
    });

    await expect(
      service.updateIcsCalendarSource(source.id, { enabled: false }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_SOURCE_VERSION_INVALID",
    });
    await expect(
      service.updateIcsCalendarSource(source.id, {
        enabled: false,
        expectedSelectionVersion: 0,
        name: "Ambiguous mixed update",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "CALENDAR_SOURCE_SELECTION_COMBINATION_INVALID",
    });

    const selected = await service.updateIcsCalendarSource(source.id, {
      enabled: false,
      expectedSelectionVersion: 0,
    });
    expect(selected.enabled).toBe(false);
    const renamed = await service.updateIcsCalendarSource(source.id, {
      name: "Renamed family calendar",
    });
    expect(renamed).toMatchObject({
      enabled: false,
      name: "Renamed family calendar",
    });

    const preference = await pg.query<{
      included: boolean;
      version: number;
    }>(
      `SELECT included, version
         FROM app_calendar.life_calendar_feed_preferences
        WHERE agent_id = $1 AND calendar_id = $2`,
      [AGENT_ID, source.id],
    );
    expect(preference.rows).toEqual([{ included: false, version: 1 }]);
    await expect(
      service.updateIcsCalendarSource(source.id, {
        enabled: false,
        expectedSelectionVersion: 0,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "CALENDAR_SOURCE_SELECTION_CONFLICT",
    });
  });

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

  it("retains failed URL-rotation cleanup and retries it on the next operation", async () => {
    const source = await createSource();
    const retiredSecretRef = [...secrets.keys()][0];
    if (!retiredSecretRef) throw new Error("Expected the original secret.");
    secretDeleteFailure = true;

    const replacementUrl =
      "https://replacement.example.test/retry/family.ics?token=replacement";
    await expect(
      service.updateIcsCalendarSource(source.id, { url: replacementUrl }),
    ).resolves.toMatchObject({
      origin: "https://replacement.example.test",
      syncStatus: "never",
    });

    const retained = await cleanupRows();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      source_id: source.id,
      secret_ref: retiredSecretRef,
      reason: "url_rotated",
      attempt_count: 1,
      last_error_code: "ICS_SECRET_DELETE_FAILED",
    });
    expect(JSON.stringify(retained)).not.toContain("replacement");
    expect(secrets.has(retiredSecretRef)).toBe(true);
    expect([...secrets.values()]).toContain(replacementUrl);

    secretDeleteFailure = false;
    await service.listIcsCalendarSources();

    expect(await cleanupRows()).toEqual([]);
    expect(secrets.has(retiredSecretRef)).toBe(false);
    expect([...secrets.values()]).toEqual([replacementUrl]);
  });

  it("retries retained cleanup from recurring maintenance after a failed restart drain", async () => {
    const source = await createSource();
    const secretRef = [...secrets.keys()][0];
    if (!secretRef) throw new Error("Expected the source secret.");
    secretDeleteFailure = true;

    await service.deleteIcsCalendarSource(source.id);

    expect(
      (
        await pg.query(
          "SELECT id FROM app_calendar.life_calendar_sources WHERE id = $1",
          [source.id],
        )
      ).rows,
    ).toEqual([]);
    expect(await cleanupRows()).toHaveLength(1);
    expect(secrets.has(secretRef)).toBe(true);

    const restarted = await CalendarService.start(runtime);
    restarted.setGate(gate());
    service = restarted;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const retained = await cleanupRows();
      if (Number(retained[0]?.attempt_count) >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await cleanupRows()).toEqual([
      expect.objectContaining({ attempt_count: 2 }),
    ]);
    secretDeleteFailure = false;
    await restarted.runGoogleCalendarWatchScheduledTask({
      taskId: "calendar-maintenance",
      metadata: { calendarGoogleWatchOperation: "maintenance" },
    } as Parameters<CalendarService["runGoogleCalendarWatchScheduledTask"]>[0]);

    expect(await cleanupRows()).toEqual([]);
    expect(secrets.has(secretRef)).toBe(false);
  });

  it("rolls back source deletion when its cleanup intent cannot commit", async () => {
    const source = await createSource();
    const secretRef = [...secrets.keys()][0];
    if (!secretRef) throw new Error("Expected the source secret.");
    await pg.exec(`
      CREATE FUNCTION reject_calendar_secret_cleanup() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced cleanup outbox failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_calendar_secret_cleanup_insert
        BEFORE INSERT ON app_calendar.life_calendar_secret_cleanup
        FOR EACH ROW EXECUTE FUNCTION reject_calendar_secret_cleanup();
    `);

    try {
      await expect(
        service.deleteIcsCalendarSource(source.id),
      ).rejects.toThrow();

      expect(
        (
          await pg.query(
            "SELECT id FROM app_calendar.life_calendar_sources WHERE id = $1",
            [source.id],
          )
        ).rows,
      ).toEqual([{ id: source.id }]);
      expect(await cleanupRows()).toEqual([]);
      expect(secrets.has(secretRef)).toBe(true);
    } finally {
      await pg.exec(`
        DROP TRIGGER reject_calendar_secret_cleanup_insert
          ON app_calendar.life_calendar_secret_cleanup;
        DROP FUNCTION reject_calendar_secret_cleanup();
      `);
    }
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
          id: expect.stringContaining(":eliza:"),
          status: "fresh",
          events: [],
        }),
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
