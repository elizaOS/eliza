/**
 * Microsoft Graph calendar discovery, idempotent creation, delta
 * reconciliation, source health, restart recovery, and concurrent sync
 * serialization through CalendarService against real PGlite tables and a
 * real loopback HTTP wire.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import type { ConnectorAccount, IAgentRuntime } from "@elizaos/core";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
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
import {
  DefaultMicrosoftGraphCalendarPort,
  type MicrosoftCalendarAccount,
  type MicrosoftGraphCalendarPort,
} from "../src/microsoft/index.js";
import {
  type CalendarHostGate,
  CalendarService,
  ensureCalendarFeedPreferenceTable,
} from "../src/service/index.js";

const AGENT_ID = "microsoft-calendar-pglite-agent";
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const GRANT_ID = "connector-account:microsoft:microsoft-owner-account";
const TIME_MIN = "2026-08-01T00:00:00.000Z";
const TIME_MAX = "2026-08-02T00:00:00.000Z";

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

function account(): MicrosoftCalendarAccount {
  const raw: ConnectorAccount = {
    id: "microsoft-owner-account",
    provider: "microsoft",
    role: "OWNER",
    purpose: ["reading", "writing"],
    accessGate: "owner_binding",
    status: "connected",
    externalId: "microsoft-user-id",
    displayHandle: "owner@example.test",
    createdAt: Date.parse("2026-07-01T00:00:00.000Z"),
    updatedAt: Date.parse("2026-07-26T00:00:00.000Z"),
    metadata: {
      accountKind: "organization",
      grantedScopes: ["Calendars.ReadWrite"],
    },
  };
  const timestamp = "2026-07-26T00:00:00.000Z";
  const grant: LifeOpsConnectorGrant = {
    id: GRANT_ID,
    agentId: AGENT_ID,
    provider: "microsoft",
    connectorAccountId: raw.id,
    side: "owner",
    identity: { sub: "microsoft-user-id", email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: ["Calendars.ReadWrite"],
    capabilities: [
      "microsoft.calendar.read_basic",
      "microsoft.calendar.read",
      "microsoft.calendar.freebusy",
      "microsoft.calendar.write",
    ],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: { accountKind: "organization" },
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { account: raw, grant, accountKind: "organization" };
}

function graphEvent(args: {
  id: string;
  subject: string;
  revision: string;
  changeKey: string;
  start?: string;
  end?: string;
  iCalUId?: string;
}): Record<string, unknown> {
  return {
    id: args.id,
    subject: args.subject,
    bodyPreview: "Provider detail",
    location: { displayName: "School" },
    showAs: "busy",
    start: {
      dateTime: args.start ?? "2026-08-01T16:00:00.0000000",
      timeZone: "UTC",
    },
    end: {
      dateTime: args.end ?? "2026-08-01T17:00:00.0000000",
      timeZone: "UTC",
    },
    isAllDay: false,
    organizer: {
      emailAddress: { address: "owner@example.test", name: "Owner" },
    },
    attendees: [],
    type: "occurrence",
    seriesMasterId: "series-master-immutable",
    iCalUId: args.iCalUId ?? `${args.id}@example.test`,
    changeKey: args.changeKey,
    lastModifiedDateTime: args.revision,
    sensitivity: "normal",
  };
}

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

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let pg: PGlite;
let runtime: IAgentRuntime;
let service: CalendarService;
let server: Server;
let baseUrl: string;
let fullGeneration = 0;
let deltaInFlight = 0;
let maxDeltaInFlight = 0;
let deltaRequests: string[] = [];
let creationPayloads: Array<Record<string, unknown>> = [];
let token: string;

function portForRuntime(): MicrosoftGraphCalendarPort {
  const graph = new DefaultMicrosoftGraphCalendarPort(runtime, {
    baseUrl,
    allowTestBaseUrl: true,
    tokenResolver: {
      resolve: async () => ({ value: token, expiresAt: null }),
    },
    sleep: async () => {},
    maxRetries: 0,
  });
  const connected = account();
  return {
    listAccounts: async (request) =>
      (!request?.grantId || request.grantId === GRANT_ID) &&
      (!request?.side || request.side === "owner")
        ? [connected]
        : [],
    listCalendars: graph.listCalendars.bind(graph),
    syncCalendarView: graph.syncCalendarView.bind(graph),
    getSchedule: graph.getSchedule.bind(graph),
    createEvent: graph.createEvent.bind(graph),
  };
}

function installService(): CalendarService {
  const next = new CalendarService(runtime);
  next.setGate(gate());
  next.setMicrosoftCalendarPort(portForRuntime());
  service = next;
  return next;
}

async function feed(forceSync = true) {
  return service.getCalendarFeed(
    INTERNAL_URL,
    {
      grantId: GRANT_ID,
      calendarId: "primary-calendar",
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
      forceSync,
    },
    new Date("2026-07-26T12:00:00.000Z"),
  );
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_calendar"));
  await db.execute(sql.raw(CREATE_EVENTS_TABLE));
  await db.execute(sql.raw(CREATE_SYNC_TABLE));
  await ensureCalendarFeedPreferenceTable(
    async (statement) =>
      (await pg.query<Record<string, unknown>>(statement)).rows,
  );
  const cache = new Map<string, unknown>();
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    getCache: async <T>(key: string) => cache.get(key) as T | undefined,
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    reportError: vi.fn(),
    getService: (serviceType: string) =>
      serviceType === "calendar" ? service : null,
  } as unknown as IAgentRuntime;

  server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "InvalidToken" } }));
      return;
    }
    if (path.startsWith("/v1.0/me/calendars?")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          value: [
            {
              id: "primary-calendar",
              name: "Family logistics",
              owner: {
                emailAddress: { address: "owner@example.test" },
              },
              isDefaultCalendar: true,
              canEdit: true,
            },
          ],
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      path === "/v1.0/me/calendars/primary-calendar/events"
    ) {
      const payload = JSON.parse(await requestBody(request)) as Record<
        string,
        unknown
      >;
      creationPayloads.push(payload);
      const start = payload.start as { dateTime: string };
      const end = payload.end as { dateTime: string };
      const created = graphEvent({
        id: "created-event-immutable",
        subject: String(payload.subject),
        revision: "2026-07-26T16:00:00Z",
        changeKey: "created-change-1",
        start: start.dateTime,
        end: end.dateTime,
      });
      created.bodyPreview = (payload.body as { content: string }).content;
      created.location = payload.location;
      created.attendees = payload.attendees;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(created));
      return;
    }
    if (path === "/v1.0/me/calendar/getSchedule") {
      const payload = JSON.parse(await requestBody(request)) as {
        schedules: string[];
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          value: payload.schedules.map((scheduleId) =>
            scheduleId === "unknown@example.test"
              ? {
                  scheduleId,
                  error: { responseCode: "ErrorMailRecipientNotFound" },
                }
              : {
                  scheduleId,
                  scheduleItems: [
                    {
                      status: "busy",
                      subject: "Never disclose this title",
                      location: "Never disclose this location",
                      start: {
                        dateTime: "2026-08-01T18:00:00.0000000",
                        timeZone: "UTC",
                      },
                      end: {
                        dateTime: "2026-08-01T18:30:00.0000000",
                        timeZone: "UTC",
                      },
                    },
                  ],
                },
          ),
        }),
      );
      return;
    }
    if (path.includes("/calendarView/delta")) {
      deltaInFlight += 1;
      maxDeltaInFlight = Math.max(maxDeltaInFlight, deltaInFlight);
      deltaRequests.push(path);
      await new Promise((resolve) => setTimeout(resolve, 15));
      try {
        const parsed = new URL(path, baseUrl);
        const cursor = parsed.searchParams.get("$deltatoken");
        if (cursor === "expired") {
          response.writeHead(410, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { code: "syncStateNotFound" } }),
          );
          return;
        }
        if (cursor) {
          const nextCursor =
            cursor === "one"
              ? "two"
              : cursor === "two"
                ? "three"
                : cursor === "three"
                  ? "four"
                  : "five";
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              value:
                cursor === "one"
                  ? [
                      graphEvent({
                        id: "pickup-occurrence",
                        subject: "Updated school pickup",
                        revision: "2026-07-26T12:00:00Z",
                        changeKey: "pickup-2",
                      }),
                      {
                        id: "obsolete-event",
                        "@removed": { reason: "deleted" },
                      },
                    ]
                  : [
                      graphEvent({
                        id: "pickup-occurrence",
                        subject: `Concurrent revision ${nextCursor}`,
                        revision: `2026-07-26T1${nextCursor === "three" ? "3" : "4"}:00:00Z`,
                        changeKey: `pickup-${nextCursor}`,
                      }),
                    ],
              "@odata.deltaLink": `${baseUrl}me/calendars/primary-calendar/calendarView/delta?$deltatoken=${nextCursor}`,
            }),
          );
          return;
        }
        fullGeneration += 1;
        const recovered = fullGeneration > 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            value: [
              graphEvent({
                id: "pickup-occurrence",
                subject: recovered
                  ? "Recovered full snapshot"
                  : "School pickup",
                revision: recovered
                  ? "2026-07-26T15:00:00Z"
                  : "2026-07-26T10:00:00Z",
                changeKey: recovered ? "pickup-recovered" : "pickup-1",
              }),
              ...(recovered
                ? []
                : [
                    graphEvent({
                      id: "obsolete-event",
                      subject: "Old event",
                      revision: "2026-07-26T10:00:00Z",
                      changeKey: "obsolete-1",
                    }),
                  ]),
            ],
            "@odata.deltaLink": `${baseUrl}me/calendars/primary-calendar/calendarView/delta?$deltatoken=${recovered ? "recovered" : "one"}`,
          }),
        );
      } finally {
        deltaInFlight -= 1;
      }
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NotFound" } }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1.0/`;
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  fullGeneration = 0;
  deltaInFlight = 0;
  maxDeltaInFlight = 0;
  deltaRequests = [];
  creationPayloads = [];
  token = "pglite-wire-token";
  vi.clearAllMocks();
  installService();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pg.close();
});

describe("Microsoft Calendar service (Graph HTTP + real PGlite)", {
  timeout: 30_000,
}, () => {
  it("persists stable source identities and reconciles update/tombstone after restart", async () => {
    const initial = await feed();
    expect(initial.state).toBe("complete");
    expect(initial.events.map((event) => event.title).sort()).toEqual([
      "Old event",
      "School pickup",
    ]);
    const pickupId = initial.events.find(
      (event) => event.externalId === "pickup-occurrence",
    )?.id;
    expect(pickupId).toBe(
      `${AGENT_ID}:microsoft:owner:grant:${GRANT_ID}:calendar:primary-calendar:pickup-occurrence`,
    );
    expect(
      initial.events.find((event) => event.externalId === "pickup-occurrence")
        ?.recurringEventId,
    ).toBe("series-master-immutable");

    installService();
    const restarted = await feed();
    expect(restarted.events).toHaveLength(1);
    expect(restarted.events[0]).toMatchObject({
      id: pickupId,
      title: "Updated school pickup",
      provider: "microsoft",
      connectorAccountId: "microsoft-owner-account",
      grantId: GRANT_ID,
      recurringEventId: "series-master-immutable",
    });
    const syncState = await pg.query<{ next_sync_token: string }>(
      "SELECT next_sync_token FROM app_calendar.life_calendar_sync_states",
    );
    expect(syncState.rows[0]?.next_sync_token).toContain("$deltatoken=two");
    const serialized = JSON.stringify(
      await pg.query("SELECT * FROM app_calendar.life_calendar_events"),
    );
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("obsolete-event");
  });

  it("serializes concurrent delta consumers so each advances the durable cursor", async () => {
    await feed();
    await Promise.all([feed(), feed()]);

    expect(maxDeltaInFlight).toBe(1);
    expect(deltaRequests.some((path) => path.includes("$deltatoken=one"))).toBe(
      true,
    );
    expect(deltaRequests.some((path) => path.includes("$deltatoken=two"))).toBe(
      true,
    );
    const syncState = await pg.query<{ next_sync_token: string }>(
      "SELECT next_sync_token FROM app_calendar.life_calendar_sync_states",
    );
    expect(syncState.rows[0]?.next_sync_token).toContain("$deltatoken=three");
  });

  it("performs one controlled full resync when Graph expires the delta cursor", async () => {
    await feed();
    await pg.query(
      `UPDATE app_calendar.life_calendar_sync_states
       SET next_sync_token = '${baseUrl}me/calendars/primary-calendar/calendarView/delta?$deltatoken=expired'`,
    );

    const recovered = await feed();
    expect(recovered.events.map((event) => event.title)).toEqual([
      "Recovered full snapshot",
    ]);
    expect(
      deltaRequests.filter((path) => path.includes("$deltatoken=expired")),
    ).toHaveLength(1);
    expect(fullGeneration).toBe(2);
    const syncState = await pg.query<{ next_sync_token: string }>(
      "SELECT next_sync_token FROM app_calendar.life_calendar_sync_states",
    );
    expect(syncState.rows[0]?.next_sync_token).toContain(
      "$deltatoken=recovered",
    );
  });

  it("keeps guest details private and marks provider errors as unknown", async () => {
    const result = await service.getCalendarFreeBusy(INTERNAL_URL, {
      calendarIds: ["busy@example.test", "unknown@example.test"],
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
    });
    expect(result.sources).toEqual([
      {
        id: "guest-freebusy-1",
        status: "fresh",
        visibility: "busy_only",
        events: [
          {
            id: "guest-freebusy-1-interval-1",
            startISO: "2026-08-01T18:00:00.000Z",
            endISO: "2026-08-01T18:30:00.000Z",
            status: "busy",
            kind: "guest_busy",
          },
        ],
      },
      {
        id: "guest-freebusy-2",
        status: "error",
        visibility: "busy_only",
        events: [],
        error: "Guest availability source is unavailable.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("busy@example.test");
    expect(JSON.stringify(result)).not.toContain("Never disclose");
    expect(JSON.stringify(result)).not.toContain("ErrorMailRecipientNotFound");
  });

  it("creates exactly once through Graph and persists the provider receipt", async () => {
    const event = await service.createCalendarEvent(INTERNAL_URL, {
      grantId: GRANT_ID,
      calendarId: "primary",
      title: "School conference",
      description: "Bring the progress report",
      location: "Room 12",
      startAt: "2026-08-01T19:00:00.000Z",
      endAt: "2026-08-01T20:00:00.000Z",
      attendees: [
        {
          email: "coparent@example.test",
          displayName: "Co-parent",
        },
      ],
      notifyAttendees: true,
      idempotencyKey: "approval:school-conference:create",
    });

    expect(event).toMatchObject({
      provider: "microsoft",
      grantId: GRANT_ID,
      calendarId: "primary-calendar",
      externalId: "created-event-immutable",
      title: "School conference",
      description: "Bring the progress report",
      location: "Room 12",
      metadata: {
        changeKey: "created-change-1",
      },
    });
    expect(creationPayloads).toHaveLength(1);
    expect(creationPayloads[0]).toMatchObject({
      subject: "School conference",
      transactionId: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/u,
      ),
    });
    const rows = await pg.query<{
      external_event_id: string;
      connector_account_id: string;
      grant_id: string;
    }>(
      `SELECT external_event_id, connector_account_id, grant_id
       FROM app_calendar.life_calendar_events
       WHERE external_event_id = 'created-event-immutable'`,
    );
    expect(rows.rows).toEqual([
      {
        external_event_id: "created-event-immutable",
        connector_account_id: "microsoft-owner-account",
        grant_id: GRANT_ID,
      },
    ]);
  });

  it("keeps Microsoft update and delete fail-closed without an atomic provider precondition", async () => {
    const eventId = `${AGENT_ID}:microsoft:owner:grant:${GRANT_ID}:calendar:primary-calendar:event-1`;
    await expect(
      service.updateCalendarEvent(INTERNAL_URL, {
        grantId: GRANT_ID,
        calendarId: "primary-calendar",
        eventId,
        title: "Changed title",
        expectedProviderVersion: "change-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "MICROSOFT_CALENDAR_CONDITIONAL_WRITE_UNSUPPORTED",
    });
    await expect(
      service.deleteCalendarEvent(INTERNAL_URL, {
        grantId: GRANT_ID,
        calendarId: "primary-calendar",
        eventId,
        expectedProviderVersion: "change-1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "MICROSOFT_CALENDAR_CONDITIONAL_WRITE_UNSUPPORTED",
    });
    expect(creationPayloads).toEqual([]);
  });
});
