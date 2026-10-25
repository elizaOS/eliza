/**
 * Guarded ICS subscriptions are exercised through CalendarService against real
 * PGlite tables. Only the HTTP wire and secrets backend are in-memory; source
 * leases, health, validators, events, tombstones, and reconciliation are real.
 */

import { PGlite } from "@electric-sql/pglite";
import { type IAgentRuntime, logger, type Memory } from "@elizaos/core";
import { SECRETS_SERVICE_TYPE } from "@elizaos/plugin-assistant";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
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
import {
  createCalendarFeedConflictLoader,
  createConflictDetectAction,
  evaluateCalendarWriteAvailability,
} from "../src/actions/conflict-detect.js";
import {
  type CalendarHostGate,
  CalendarRepository,
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

  it("does not report a free subscribed event as a conflict", async () => {
    const source = await createSource();
    const event = (
      title: string,
      start: string,
      end: string,
      extra: string[],
    ) =>
      [
        "BEGIN:VEVENT",
        `UID:${title}`,
        "DTSTAMP:20260701T080000Z",
        `DTSTART:${start}`,
        `DTEND:${end}`,
        ...extra,
        `SUMMARY:${title}`,
        "END:VEVENT",
      ].join("\r\n");
    await syncBody(
      source.id,
      calendar(
        event("Lunch reminder", "20260701T100000Z", "20260701T110000Z", [
          "TRANSP:TRANSPARENT",
        ]),
        event("School pickup", "20260701T140000Z", "20260701T150000Z", []),
      ),
    );
    const conflictsAt = async (startAt: string, endAt: string) =>
      (
        await evaluateCalendarWriteAvailability({
          runtime,
          startAt,
          endAt,
          timeZone: "UTC",
        })
      ).conflicts.map((conflict) => conflict.eventB.title);

    // TRANSP:TRANSPARENT marks time that stays free (RFC 5545 3.8.2.7).
    expect(
      await conflictsAt("2026-07-01T10:15:00.000Z", "2026-07-01T10:45:00.000Z"),
    ).toEqual([]);
    expect(
      await conflictsAt("2026-07-01T14:15:00.000Z", "2026-07-01T14:45:00.000Z"),
    ).toEqual(["School pickup"]);
  });

  it("scans a subscribed all-day event on the owner's local day", async () => {
    const source = await createSource();
    // No X-WR-TIMEZONE, so the parser stores the all-day date with zone UTC.
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:offsite",
          "DTSTAMP:20260601T000000Z",
          "DTSTART;VALUE=DATE:20260702",
          "DTEND;VALUE=DATE:20260703",
          "SUMMARY:Team offsite",
          "END:VEVENT",
          // 18:00 to 19:00 on July 1 in Los Angeles.
          "BEGIN:VEVENT",
          "UID:call",
          "DTSTAMP:20260601T000000Z",
          "DTSTART:20260702T010000Z",
          "DTEND:20260702T020000Z",
          "SUMMARY:Call",
          "END:VEVENT",
          // 18:00 to 19:00 on July 2 in Los Angeles.
          "BEGIN:VEVENT",
          "UID:dinner",
          "DTSTAMP:20260601T000000Z",
          "DTSTART:20260703T010000Z",
          "DTEND:20260703T020000Z",
          "SUMMARY:Dinner",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const action = createConflictDetectAction({
      authorize: async () => true,
      resolveTimeZone: async () => "America/Los_Angeles",
      now: () => new Date("2026-07-01T19:00:00.000Z"),
    });

    const result = await action.handler(
      { ...runtime, logger } as IAgentRuntime,
      {
        id: "00000000-0000-0000-0000-000000000301",
        entityId: "00000000-0000-0000-0000-000000000302",
        roomId: "00000000-0000-0000-0000-000000000303",
        content: { text: "any conflicts this week?" },
      } as Memory,
      undefined,
      { parameters: { action: "scan_week" } },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        conflicts: [
          { eventA: { title: "Team offsite" }, eventB: { title: "Dinner" } },
        ],
      },
    });
  });

  it.each(["ü", "€", "😀"])(
    "reads a feed folded between every UTF-8 octet of %s",
    async (character) => {
      const source = await createSource();
      // The first fold falls at 75 octets. Further folds inside the same
      // scalar must also be removed before the strict UTF-8 decode.
      const title = `${"a".repeat(66)}${character}ber`;
      const line = new TextEncoder().encode(`SUMMARY:${title}`);
      const body = Buffer.concat([
        Buffer.from(
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:folded\r\nDTSTAMP:20260701T080000Z\r\n" +
            "DTSTART:20260701T100000Z\r\nDTEND:20260701T110000Z\r\n",
        ),
        line.subarray(0, 74),
        ...Array.from(Buffer.from(character)).flatMap((octet, index) =>
          index === 0
            ? [Buffer.from([octet])]
            : [Buffer.from("\r\n "), Buffer.from([octet])],
        ),
        line.subarray(74 + Buffer.byteLength(character)),
        Buffer.from("\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"),
      ]);
      expect(line[74]).toBe(Buffer.from(character)[0]);

      await service.syncIcsCalendarSource(source.id, {
        transport: {
          fetchImpl: async () =>
            new Response(body, {
              status: 200,
              headers: { "content-type": "text/calendar" },
            }),
        },
      });
      const feed = await service.getCalendarFeed(
        new URL("http://internal.test/api/calendar"),
        { grantId: source.id, ...WINDOW },
        new Date(),
      );

      expect(feed.events.map((event) => event.title)).toEqual([title]);
    },
  );

  it("keeps decoded parameter names through subscription sync and feed reads", async () => {
    const source = await createSource();
    const cases = [
      ["George Herman ^'Babe^' Ruth", 'George Herman "Babe" Ruth'],
      ["Team^nNorth", "Team\nNorth"],
      ["A^^nB", "A^nB"],
      ["A^xB^NB^", "A^xB^NB^"],
    ];
    const body = calendar(
      ...cases.map(([encoded], index) =>
        vevent({
          uid: `parameter-${index}`,
          title: `Parameter ${index}`,
        }).replace(
          "END:VEVENT",
          [
            `ORGANIZER;CN="${encoded}":mailto:organizer@example.com`,
            `ATTENDEE;CN="${encoded}":mailto:attendee@example.com`,
            "END:VEVENT",
          ].join("\r\n"),
        ),
      ),
    );
    const sync = await syncBody(source.id, body);
    expect(sync.acceptedEvents).toBe(cases.length);
    const feed = await service.getCalendarFeed(
      INTERNAL_URL,
      { grantId: source.id, ...WINDOW },
      new Date(),
    );
    expect(feed.events).toHaveLength(cases.length);
    for (const [index, [, expected]] of cases.entries()) {
      expect(
        feed.events.find((event) => event.title === `Parameter ${index}`),
      ).toMatchObject({
        organizer: { displayName: expected },
        attendees: [expect.objectContaining({ displayName: expected })],
      });
    }
  });

  it("reads the Windows zone names that the 2026 Canada changes added", async () => {
    const source = await createSource();
    const event = (uid: string, tzid: string) =>
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20261001T000000Z",
        `DTSTART;TZID=${tzid}:20261020T180000`,
        `DTEND;TZID=${tzid}:20261020T190000`,
        `SUMMARY:${uid}`,
        "END:VEVENT",
      ].join("\r\n");
    await syncBody(
      source.id,
      calendar(
        event("british-columbia", "British Columbia Standard Time"),
        event("alberta", "Alberta Standard Time"),
        event("manitoba", "Manitoba Standard Time"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-10-20T00:00:00.000Z",
        timeMax: "2026-10-22T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    // On 2026-10-20, 18:00 is UTC-7 in Vancouver, UTC-6 in Edmonton, and
    // UTC-5 in Winnipeg.
    expect(
      feed.events
        .map((item) => [item.title, item.startAt, item.timezone])
        .sort(),
    ).toEqual([
      ["alberta", "2026-10-21T00:00:00.000Z", "America/Edmonton"],
      ["british-columbia", "2026-10-21T01:00:00.000Z", "America/Vancouver"],
      ["manitoba", "2026-10-20T23:00:00.000Z", "America/Winnipeg"],
    ]);
  });

  it("reads a libical TZID as the IANA zone after its prefix", async () => {
    const source = await createSource();
    const event = (uid: string, tzid: string) =>
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20261101T000000Z",
        `DTSTART;TZID=${tzid}:20261201T180000`,
        `DTEND;TZID=${tzid}:20261201T190000`,
        `SUMMARY:${uid}`,
        "END:VEVENT",
      ].join("\r\n");
    await syncBody(
      source.id,
      calendar(
        event("libical", "/freeassociation.sourceforge.net/Europe/Berlin"),
        event(
          "libical-old",
          "/freeassociation.sourceforge.net/Tzfile/Europe/Berlin",
        ),
        event("citadel", "/citadel.org/20190914_1/Europe/Berlin"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-12-01T00:00:00.000Z",
        timeMax: "2026-12-03T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    // 18:00 in Berlin (UTC+1 in December) is 17:00 UTC.
    expect(
      feed.events
        .map((item) => [item.title, item.startAt, item.timezone])
        .sort(),
    ).toEqual([
      ["citadel", "2026-12-01T17:00:00.000Z", "Europe/Berlin"],
      ["libical", "2026-12-01T17:00:00.000Z", "Europe/Berlin"],
      ["libical-old", "2026-12-01T17:00:00.000Z", "Europe/Berlin"],
    ]);
  });

  it("ends a day-length DURATION at the same local time across a DST change", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:dst-trip",
          "DTSTAMP:20261001T080000Z",
          "DTSTART;TZID=America/New_York:20261031T100000",
          "DURATION:P1D",
          "SUMMARY:Overnight trip",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-10-31T00:00:00.000Z",
        timeMax: "2026-11-02T00:00:00.000Z",
      },
      new Date(),
    );

    // RFC 5545 3.3.6: P1D is a nominal day, so 10:00 EDT ends 10:00 EST.
    expect(feed.events).toEqual([
      expect.objectContaining({
        title: "Overnight trip",
        startAt: "2026-10-31T14:00:00.000Z",
        endAt: "2026-11-01T15:00:00.000Z",
      }),
    ]);
  });

  it("keeps each recurring day-length DURATION at the same local time across DST", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:weekly-overnight",
          "DTSTAMP:20261001T080000Z",
          "DTSTART;TZID=America/New_York:20261024T100000",
          "DURATION:P1D",
          "RRULE:FREQ=WEEKLY;COUNT=3",
          "SUMMARY:Weekly overnight",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-10-20T00:00:00.000Z",
        timeMax: "2026-11-10T00:00:00.000Z",
      },
      new Date(),
    );

    expect(
      feed.events.map((event) => ({
        startAt: event.startAt,
        endAt: event.endAt,
      })),
    ).toEqual([
      {
        startAt: "2026-10-24T14:00:00.000Z",
        endAt: "2026-10-25T14:00:00.000Z",
      },
      {
        startAt: "2026-10-31T14:00:00.000Z",
        endAt: "2026-11-01T15:00:00.000Z",
      },
      {
        startAt: "2026-11-07T15:00:00.000Z",
        endAt: "2026-11-08T15:00:00.000Z",
      },
    ]);

    const overlapping = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-11-01T14:30:00.000Z",
        timeMax: "2026-11-01T16:00:00.000Z",
      },
      new Date(),
    );
    expect(overlapping.events).toEqual([
      expect.objectContaining({
        startAt: "2026-10-31T14:00:00.000Z",
        endAt: "2026-11-01T15:00:00.000Z",
      }),
    ]);
  });

  it("keeps a day-length DURATION occurrence when the window starts in the DST gap's next-day hour", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:daily-overnight-gap",
          "DTSTAMP:20260201T080000Z",
          "DTSTART;TZID=America/New_York:20260301T030000",
          "DURATION:P1D",
          "RRULE:FREQ=DAILY",
          "SUMMARY:Daily overnight",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    // 02:30 EDT on Mar 9; one nominal day earlier is 02:30 on Mar 8, which
    // falls inside the spring-forward gap.
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-03-09T06:30:00.000Z",
        timeMax: "2026-03-09T06:50:00.000Z",
      },
      new Date(),
    );

    expect(
      feed.events.map((event) => ({
        startAt: event.startAt,
        endAt: event.endAt,
      })),
    ).toEqual([
      {
        startAt: "2026-03-08T07:00:00.000Z",
        endAt: "2026-03-09T07:00:00.000Z",
      },
    ]);
  });

  it("ignores a spring-forward gap occurrence without consuming COUNT", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:dst-gap",
          "DTSTAMP:20260301T000000Z",
          "DTSTART;TZID=America/New_York:20260307T023000",
          "DURATION:PT30M",
          "RRULE:FREQ=DAILY;COUNT=3",
          "SUMMARY:Night shift",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-03-06T00:00:00.000Z",
        timeMax: "2026-03-15T00:00:00.000Z",
      },
      new Date(),
    );

    // RFC 5545 3.3.10: 02:30 does not exist on March 8, so that occurrence is
    // ignored and the third occurrence is March 10.
    expect(feed.events.map((event) => event.startAt).sort()).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("expands the RFC 5545 weekly examples that set WKST", async () => {
    const source = await createSource();
    const example = (uid: string, wkst: string) =>
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:19970801T000000Z",
        "DTSTART;TZID=America/New_York:19970805T090000",
        "DURATION:PT1H",
        `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${wkst}`,
        `SUMMARY:${uid}`,
        "END:VEVENT",
      ].join("\r\n");
    await syncBody(
      source.id,
      calendar(
        example("week-starts-monday", "MO"),
        example("week-starts-sunday", "SU"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "1997-08-01T00:00:00.000Z",
        timeMax: "1997-09-15T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    const startsOf = (title: string) =>
      feed.events
        .filter((event) => event.title === title)
        .map((event) => event.startAt.slice(0, 10));
    // RFC 5545 3.8.5.3: August 5, 10, 19, 24 for MO; August 5, 17, 19, 31 for SU.
    expect(startsOf("week-starts-monday")).toEqual([
      "1997-08-05",
      "1997-08-10",
      "1997-08-19",
      "1997-08-24",
    ]);
    expect(startsOf("week-starts-sunday")).toEqual([
      "1997-08-05",
      "1997-08-17",
      "1997-08-19",
      "1997-08-31",
    ]);
  });

  it("expands a recurring series minus EXDATE and an instance moved outside the window", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:soccer",
          "DTSTAMP:20260901T000000Z",
          "DTSTART;TZID=America/New_York:20260901T160000",
          "DTEND;TZID=America/New_York:20260901T170000",
          "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T235959Z",
          "EXDATE;TZID=America/New_York:20261020T160000",
          "SUMMARY:Soccer practice",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:soccer",
          "DTSTAMP:20260901T000000Z",
          "RECURRENCE-ID;TZID=America/New_York:20261027T160000",
          "DTSTART;TZID=America/New_York:20261128T160000",
          "DTEND;TZID=America/New_York:20261128T170000",
          "SUMMARY:Soccer practice (moved)",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-10-12T00:00:00.000Z",
        timeMax: "2026-11-05T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    // 16:00 New York each Tuesday: EDT until Nov 1, then EST.
    expect(
      feed.events.map((event) => [event.title, event.startAt, event.endAt]),
    ).toEqual([
      [
        "Soccer practice",
        "2026-10-13T20:00:00.000Z",
        "2026-10-13T21:00:00.000Z",
      ],
      [
        "Soccer practice",
        "2026-11-03T21:00:00.000Z",
        "2026-11-03T22:00:00.000Z",
      ],
    ]);
  });

  it("ends a timed series with a DATE UNTIL on that day in the event time zone", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:evening-west",
          "DTSTAMP:20261101T000000Z",
          "DTSTART;TZID=America/Los_Angeles:20261201T180000",
          "DTEND;TZID=America/Los_Angeles:20261201T190000",
          "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215",
          "SUMMARY:Evening practice",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:morning-east",
          "DTSTAMP:20261101T000000Z",
          "DTSTART;TZID=Asia/Seoul:20261214T083000",
          "DTEND;TZID=Asia/Seoul:20261214T093000",
          "RRULE:FREQ=DAILY;UNTIL=20261215",
          "SUMMARY:Morning class",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-12-01T00:00:00.000Z",
        timeMax: "2026-12-31T00:00:00.000Z",
      },
      new Date(),
    );

    const startsOf = (title: string) =>
      feed.events
        .filter((event) => event.title === title)
        .map((event) => event.startAt);
    // 18:00 Los Angeles on Dec 15 is Dec 16 in UTC; it is the last practice.
    expect(startsOf("Evening practice")).toEqual([
      "2026-12-02T02:00:00.000Z",
      "2026-12-09T02:00:00.000Z",
      "2026-12-16T02:00:00.000Z",
    ]);
    // 08:30 Seoul on Dec 16 is Dec 15 in UTC; it is after the last class.
    expect(startsOf("Morning class")).toEqual([
      "2026-12-13T23:30:00.000Z",
      "2026-12-14T23:30:00.000Z",
    ]);
  });

  it("places each occurrence of a recurring all-day series on the owner's local day", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:trash",
          "DTSTAMP:20260601T000000Z",
          "DTSTART;VALUE=DATE:20260602",
          "DTEND;VALUE=DATE:20260603",
          "RRULE:FREQ=WEEKLY",
          "SUMMARY:Trash day",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:trash",
          "DTSTAMP:20260601T000000Z",
          "RECURRENCE-ID;VALUE=DATE:20260616",
          "DTSTART:20260619T100000Z",
          "DTEND:20260619T110000Z",
          "SUMMARY:Trash pickup (moved)",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const readFeed = (timeZone: string, timeMin: string, timeMax: string) =>
      service.getCalendarFeed(
        new URL("http://internal.test/api/calendar"),
        { grantId: source.id, timeZone, timeMin, timeMax },
        new Date(),
      );

    // 00:00 to 06:00 on June 9 in Tokyo. The June 9 occurrence starts at
    // 2026-06-09T00:00Z, after this window ends.
    const tokyoMorning = await readFeed(
      "Asia/Tokyo",
      "2026-06-08T15:00:00.000Z",
      "2026-06-08T21:00:00.000Z",
    );
    expect(tokyoMorning.state).toBe("complete");
    expect(
      tokyoMorning.events.map((event) => [event.title, event.startAt]),
    ).toEqual([["Trash day", "2026-06-09T00:00:00.000Z"]]);

    // June 8 in Los Angeles. The June 9 occurrence overlaps its evening in
    // UTC but is on the next local day.
    const losAngelesMonday = await readFeed(
      "America/Los_Angeles",
      "2026-06-08T07:00:00.000Z",
      "2026-06-09T07:00:00.000Z",
    );
    expect(losAngelesMonday.state).toBe("complete");
    expect(losAngelesMonday.events).toEqual([]);

    // 00:00 to 06:00 on June 16 in Tokyo. A timed override replaced the
    // June 16 occurrence, and its recurrence instant is after this window.
    const tokyoMovedMorning = await readFeed(
      "Asia/Tokyo",
      "2026-06-15T15:00:00.000Z",
      "2026-06-15T21:00:00.000Z",
    );
    expect(tokyoMovedMorning.state).toBe("complete");
    expect(tokyoMovedMorning.events).toEqual([]);
  });

  it("expands an established daily series after more than 1000 prior occurrences", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:daily-standup",
          "DTSTAMP:20230102T000000Z",
          "DTSTART:20230102T100000Z",
          "DTEND:20230102T101500Z",
          "RRULE:FREQ=DAILY",
          "SUMMARY:Daily standup",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-10-12T00:00:00.000Z",
        timeMax: "2026-10-19T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events.map((event) => event.startAt)).toEqual([
      "2026-10-12T10:00:00.000Z",
      "2026-10-13T10:00:00.000Z",
      "2026-10-14T10:00:00.000Z",
      "2026-10-15T10:00:00.000Z",
      "2026-10-16T10:00:00.000Z",
      "2026-10-17T10:00:00.000Z",
      "2026-10-18T10:00:00.000Z",
    ]);
    expect(feed.events.every((event) => event.recurringEventId)).toBe(true);
  });

  it.each([false, true])(
    "includes an ICS instant at the feed window start (recurring=%s)",
    async (recurring) => {
      const source = await createSource();
      await syncBody(
        source.id,
        calendar(
          [
            "BEGIN:VEVENT",
            "UID:instant-reminder",
            "DTSTAMP:20260701T080000Z",
            "DTSTART:20260701T100000Z",
            ...(recurring ? ["RRULE:FREQ=DAILY;COUNT=3"] : []),
            "SUMMARY:Instant reminder",
            "END:VEVENT",
          ].join("\r\n"),
          vevent({
            uid: "ended-meeting",
            title: "Meeting ended at the boundary",
          })
            .replace("DTSTART:20260701T100000Z", "DTSTART:20260701T090000Z")
            .replace("DTEND:20260701T110000Z", "DTEND:20260701T100000Z"),
        ),
      );
      const read = (timeMin: string, timeMax: string) =>
        service.getCalendarFeed(
          INTERNAL_URL,
          { grantId: source.id, timeMin, timeMax },
          new Date(),
        );
      const boundary = await read(
        "2026-07-01T10:00:00.000Z",
        "2026-07-02T10:00:00.000Z",
      );
      expect(boundary.state).toBe("complete");
      expect(
        boundary.events.map((event) => [event.startAt, event.endAt]),
      ).toEqual([["2026-07-01T10:00:00.000Z", "2026-07-01T10:00:00.000Z"]]);
      const after = await read(
        "2026-07-01T10:00:00.001Z",
        "2026-07-02T10:00:00.000Z",
      );
      expect(after.events).toEqual([]);
      const next = await read(
        "2026-07-02T10:00:00.000Z",
        "2026-07-03T10:00:00.000Z",
      );
      expect(next.events.map((event) => event.startAt)).toEqual(
        recurring ? ["2026-07-02T10:00:00.000Z"] : [],
      );
    },
  );

  it("removes the occurrence of the day that a DATE EXDATE names on a timed series", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:evening-class",
          "DTSTAMP:20261101T000000Z",
          "DTSTART;TZID=America/Los_Angeles:20261201T180000",
          "DTEND;TZID=America/Los_Angeles:20261201T190000",
          "RRULE:FREQ=WEEKLY;COUNT=4",
          "EXDATE;VALUE=DATE:20261208",
          "SUMMARY:Evening class",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-12-01T00:00:00.000Z",
        timeMax: "2026-12-31T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    // 18:00 Los Angeles on Dec 8 is Dec 9 in UTC; the EXDATE day is local.
    expect(feed.events.map((event) => event.startAt)).toEqual([
      "2026-12-02T02:00:00.000Z",
      "2026-12-16T02:00:00.000Z",
      "2026-12-23T02:00:00.000Z",
    ]);
  });

  it("keeps the previous local day when a DATE EXDATE names the UTC day of a 00:00Z occurrence", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:evening-daily",
          "DTSTAMP:20261101T000000Z",
          "DTSTART;TZID=America/New_York:20261130T190000",
          "DTEND;TZID=America/New_York:20261130T200000",
          "RRULE:FREQ=DAILY;COUNT=5",
          "EXDATE;VALUE=DATE:20261202",
          "SUMMARY:Evening daily",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-11-30T00:00:00.000Z",
        timeMax: "2026-12-31T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    // 19:00 New York is 00:00Z of the next UTC day. The Dec 1 occurrence
    // starts at the UTC midnight of Dec 2 and must stay; only the Dec 2
    // occurrence (2026-12-03T00:00Z) is excluded.
    expect(feed.events.map((event) => event.startAt)).toEqual([
      "2026-12-01T00:00:00.000Z",
      "2026-12-02T00:00:00.000Z",
      "2026-12-04T00:00:00.000Z",
      "2026-12-05T00:00:00.000Z",
    ]);
  });

  it("keeps usable EXDATE values when another EXDATE is malformed", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:partial-exdate",
          "DTSTAMP:20261001T000000Z",
          "DTSTART:20261006T100000Z",
          "DTEND:20261006T110000Z",
          "RRULE:FREQ=WEEKLY;BYDAY=TU",
          "EXDATE:20261013T100000Z",
          "EXDATE;TZID=Not/AZone:20261020T100000",
          "SUMMARY:Weekly review",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-10-12T00:00:00.000Z",
        timeMax: "2026-10-28T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("partial");
    expect(feed.events.map((event) => event.startAt)).toEqual([
      "2026-10-20T10:00:00.000Z",
      "2026-10-27T10:00:00.000Z",
    ]);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "calendar:ics-expansion",
      expect.objectContaining({ code: "CALENDAR_ICS_EXDATE_INVALID" }),
      { sourceId: source.id },
    );
  });

  it("ends a series with a local-time UNTIL at that time in the event time zone", async () => {
    const source = await createSource();
    const series = (uid: string, until: string) => [
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20261101T000000Z",
      "DTSTART:20261201T180000",
      "DTEND:20261201T190000",
      `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
      `SUMMARY:${uid}`,
      "END:VEVENT",
    ];
    await syncBody(
      source.id,
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//elizaOS//ICS integration test//EN",
        "X-WR-TIMEZONE:America/Los_Angeles",
        ...series("until-at-the-start", "20261215T180000"),
        ...series("until-before-the-start", "20261215T175959"),
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-12-01T00:00:00.000Z",
        timeMax: "2026-12-31T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    const startsOf = (title: string) =>
      feed.events
        .filter((event) => event.title === title)
        .map((event) => event.startAt);
    // RFC 5545 3.3.10: a local DTSTART has a local UNTIL, and it is inclusive.
    expect(startsOf("until-at-the-start")).toEqual([
      "2026-12-02T02:00:00.000Z",
      "2026-12-09T02:00:00.000Z",
      "2026-12-16T02:00:00.000Z",
    ]);
    expect(startsOf("until-before-the-start")).toEqual([
      "2026-12-02T02:00:00.000Z",
      "2026-12-09T02:00:00.000Z",
    ]);
  });

  it("reports a partial feed for a series it cannot expand", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:hourly-check",
          "DTSTAMP:20260901T000000Z",
          "DTSTART:20260901T100000Z",
          "DTEND:20260901T101500Z",
          "RRULE:FREQ=HOURLY",
          "SUMMARY:Hourly check",
          "END:VEVENT",
          "BEGIN:VEVENT",
          "UID:extra-dates",
          "DTSTAMP:20260901T000000Z",
          "DTSTART:20260902T100000Z",
          "DTEND:20260902T110000Z",
          "RDATE:20261014T100000Z",
          "SUMMARY:Extra dates",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const read = (timeMin: string, timeMax: string) =>
      service.getCalendarFeed(
        new URL("http://internal.test/api/calendar"),
        { grantId: source.id, timeMin, timeMax },
        new Date(),
      );

    // Both series start before this window. Their later occurrences are
    // missing, so the feed must not report a complete read.
    const later = await read(
      "2026-10-12T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
    );
    expect(later.events).toEqual([]);
    expect(later.state).toBe("partial");

    const first = await read(
      "2026-09-01T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    );
    expect(first.events.map((event) => event.title)).toEqual([
      "Hourly check",
      "Extra dates",
    ]);
    expect(first.state).toBe("partial");
  });

  it("expands the RFC 5545 monthly examples that name weekdays of the month", async () => {
    const source = await createSource();
    const example = (uid: string, start: string, rrule: string) =>
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:19970801T000000Z",
        `DTSTART;TZID=America/New_York:${start}`,
        "DURATION:PT1H",
        `RRULE:${rrule}`,
        `SUMMARY:${uid}`,
        "END:VEVENT",
      ].join("\r\n");
    await syncBody(
      source.id,
      calendar(
        example(
          "first-friday",
          "19970905T090000",
          "FREQ=MONTHLY;COUNT=10;BYDAY=1FR",
        ),
        example(
          "first-and-last-sunday",
          "19970907T090000",
          "FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU",
        ),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "1997-08-01T00:00:00.000Z",
        timeMax: "1998-07-01T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    const startsOf = (title: string) =>
      feed.events
        .filter((event) => event.title === title)
        .map((event) => event.startAt.slice(0, 10));
    // RFC 5545 3.8.5.3 gives these dates for the two rules.
    expect(startsOf("first-friday")).toEqual([
      "1997-09-05",
      "1997-10-03",
      "1997-11-07",
      "1997-12-05",
      "1998-01-02",
      "1998-02-06",
      "1998-03-06",
      "1998-04-03",
      "1998-05-01",
      "1998-06-05",
    ]);
    expect(startsOf("first-and-last-sunday")).toEqual([
      "1997-09-07",
      "1997-09-28",
      "1997-11-02",
      "1997-11-30",
      "1998-01-04",
      "1998-01-25",
      "1998-03-01",
      "1998-03-29",
      "1998-05-03",
      "1998-05-31",
    ]);
  });

  it("stops a monthly rule whose candidate months never contain its day", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:empty-monthly-rule",
          "DTSTAMP:20260228T000000Z",
          "DTSTART:20260228T100000Z",
          "DTEND:20260228T110000Z",
          "RRULE:FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31",
          "SUMMARY:Impossible February date",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );

    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2027-02-01T00:00:00.000Z",
        timeMax: "2028-03-01T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    expect(feed.events).toEqual([]);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("reports an interval that exceeds supported date arithmetic without failing the feed", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:oversized-daily-interval",
          "DTSTAMP:20260101T000000Z",
          "DTSTART:20260101T100000Z",
          "DTEND:20260101T110000Z",
          "RRULE:FREQ=DAILY;INTERVAL=9007199254740991",
          "SUMMARY:Oversized interval",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );

    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "2026-10-12T00:00:00.000Z",
        timeMax: "2026-10-19T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("partial");
    expect(feed.events).toEqual([]);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "calendar:ics-expansion",
      expect.objectContaining({
        code: "CALENDAR_RECURRENCE_EXPANSION_INVALID_DATE",
      }),
      { sourceId: source.id },
    );
  });

  it("expands the RFC 5545 yearly examples that list months", async () => {
    const source = await createSource();
    const example = (uid: string, start: string, rrule: string) =>
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:19970301T000000Z",
        `DTSTART;TZID=America/New_York:${start}`,
        "DURATION:PT1H",
        `RRULE:${rrule}`,
        `SUMMARY:${uid}`,
        "END:VEVENT",
      ].join("\r\n");
    await syncBody(
      source.id,
      calendar(
        example(
          "january-february-march",
          "19970310T090000",
          "FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3",
        ),
        // The RFC example has no end. UNTIL keeps the expected list short.
        example(
          "thursdays-in-march",
          "19970313T090000",
          "FREQ=YEARLY;BYMONTH=3;BYDAY=TH;UNTIL=19981231T000000Z",
        ),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "1997-01-01T00:00:00.000Z",
        timeMax: "2004-01-01T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    const startsOf = (title: string) =>
      feed.events
        .filter((event) => event.title === title)
        .map((event) => event.startAt.slice(0, 10));
    // RFC 5545 3.8.5.3 gives these dates for the two rules.
    expect(startsOf("january-february-march")).toEqual([
      "1997-03-10",
      "1999-01-10",
      "1999-02-10",
      "1999-03-10",
      "2001-01-10",
      "2001-02-10",
      "2001-03-10",
      "2003-01-10",
      "2003-02-10",
      "2003-03-10",
    ]);
    expect(startsOf("thursdays-in-march")).toEqual([
      "1997-03-13",
      "1997-03-20",
      "1997-03-27",
      "1998-03-05",
      "1998-03-12",
      "1998-03-19",
      "1998-03-26",
    ]);
  });

  it("expands a daily series that lists weekdays", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:every-weekday",
          "DTSTAMP:19970801T000000Z",
          "DTSTART;TZID=America/New_York:19970902T090000",
          "DURATION:PT1H",
          "RRULE:FREQ=DAILY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;COUNT=8",
          "SUMMARY:Every weekday",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "1997-09-01T00:00:00.000Z",
        timeMax: "1997-10-01T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    // 1997-09-02 is a Tuesday. September 6 and 7 are a weekend.
    expect(feed.events.map((event) => event.startAt.slice(0, 10))).toEqual([
      "1997-09-02",
      "1997-09-03",
      "1997-09-04",
      "1997-09-05",
      "1997-09-08",
      "1997-09-09",
      "1997-09-10",
      "1997-09-11",
    ]);
  });

  it("expands the rules that select dates with BYSETPOS", async () => {
    const source = await createSource();
    const example = (uid: string, start: string, rrule: string) =>
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:19970301T000000Z",
        `DTSTART;TZID=America/New_York:${start}`,
        "DURATION:PT1H",
        `RRULE:${rrule}`,
        `SUMMARY:${uid}`,
        "END:VEVENT",
      ].join("\r\n");
    await syncBody(
      source.id,
      calendar(
        // RFC 5545 3.8.5.3 gives the dates for this rule.
        example(
          "third-of-tuesday-wednesday-thursday",
          "19970904T090000",
          "FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3",
        ),
        // The form that Exchange writes for "the last weekday of April".
        example(
          "last-weekday-of-april",
          "19970430T090000",
          "FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYMONTH=4;COUNT=3",
        ),
      ),
    );
    const feed = await service.getCalendarFeed(
      new URL("http://internal.test/api/calendar"),
      {
        grantId: source.id,
        timeMin: "1997-01-01T00:00:00.000Z",
        timeMax: "2000-01-01T00:00:00.000Z",
      },
      new Date(),
    );

    expect(feed.state).toBe("complete");
    const startsOf = (title: string) =>
      feed.events
        .filter((event) => event.title === title)
        .map((event) => event.startAt.slice(0, 10));
    expect(startsOf("third-of-tuesday-wednesday-thursday")).toEqual([
      "1997-09-04",
      "1997-10-07",
      "1997-11-06",
    ]);
    expect(startsOf("last-weekday-of-april")).toEqual([
      "1997-04-30",
      "1998-04-30",
      "1999-04-30",
    ]);
  });

  it("does not load unrelated historical rows for a short expansion window", async () => {
    const source = await createSource();
    await syncBody(
      source.id,
      calendar(
        [
          "BEGIN:VEVENT",
          "UID:bounded-series",
          "DTSTAMP:20260101T000000Z",
          "DTSTART:20260105T100000Z",
          "DTEND:20260105T110000Z",
          "RRULE:FREQ=WEEKLY;BYDAY=MO",
          "SUMMARY:Bounded series",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    await pg.exec(`
      INSERT INTO app_calendar.life_calendar_events (
        id, agent_id, provider, side, calendar_id, external_event_id,
        connector_account_id, grant_id, title, description, location, status,
        start_at, end_at, is_all_day, timezone, html_link, conference_link,
        organizer_json, attendees_json, metadata_json, synced_at, updated_at
      )
      SELECT
        'historical-' || n, '${AGENT_ID}', 'ics', 'owner', '${source.id}',
        'historical-external-' || n, '${source.id}', '${source.id}',
        'Historical event', '', '', 'confirmed',
        '2020-01-01T10:00:00.000Z', '2020-01-01T11:00:00.000Z',
        false, 'UTC', NULL, NULL, NULL, '[]', '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      FROM generate_series(1, 2000) AS n;
    `);

    const rows = await new CalendarRepository(
      runtime,
    ).listIcsCalendarEventsForExpansion({
      agentId: AGENT_ID,
      sourceId: source.id,
      timeMin: "2026-10-12T00:00:00.000Z",
      timeMax: "2026-10-13T00:00:00.000Z",
      allDayTimeMin: "2026-10-10T21:00:00.000Z",
      allDayTimeMax: "2026-10-14T03:00:00.000Z",
    });

    expect(rows.map((event) => event.title)).toEqual(["Bounded series"]);
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
