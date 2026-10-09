import type { GoogleCalendarEvent } from "@elizaos/plugin-google-workspace";
/**
 * Drives CALENDAR through the canonical executor over a real PGlite-backed ICS
 * snapshot, proving read receipts are grounded in persisted provider evidence.
 */

import { PGlite } from "@electric-sql/pglite";
import {
  type Content,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { SECRETS_SERVICE_TYPE } from "@elizaos/plugin-assistant";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { executeRawSqlTx, type TransactionalDb } from "../../plugin-assistant/src/services/approval/sql.ts";
import { DeviceActionService, withDeviceActionTurn } from "../../plugin-assistant/src/services/device-actions/service.ts";
import { __testing as appleTesting } from "../src/apple-calendar.ts";
import { calendarPlugin } from "../src/plugin.ts";
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
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/actions/calendar-handler.js";
import {
  type CalendarHostGate,
  CalendarService,
  ensureCalendarFeedPreferenceTable,
} from "../src/service/index.js";

const AGENT_ID = "calendar-action-receipt-pglite-agent";
const ENTITY_ID = "00000000-0000-0000-0000-000000000702";
const ROOM_ID = "00000000-0000-0000-0000-000000000703";
const MESSAGE_ID = "00000000-0000-0000-0000-000000000704";
const SOURCE_URL = "https://calendar.example.test/private/family.ics";
const WINDOW = {
  timeMin: "2026-07-28T00:00:00.000Z",
  timeMax: "2026-07-29T00:00:00.000Z",
};

it("registered CALENDAR cannot substitute backend records for an enrolled phone", async () => {
  const fixture = await createRealTestRuntime({
    characterName: "NativeCalendarSourceGate",
    plugins: [calendarPlugin],
  });
  const runtime = fixture.runtime;
  const credentials = {
    subjectUserId: runtime.agentId,
    installationId: "native-calendar-fixture",
    deviceKey: "a".repeat(64),
    capabilities: ["calendar.local-event.v1"],
  };
  try {
    await new DeviceActionService(runtime).register(
      credentials,
      "Native Calendar fixture",
    );
    const action = runtime.actions.find((action) => action.name === "CALENDAR");
    if (!action)
      throw Error("The production CALENDAR action was not registered");
    expect(action.tags).not.toContain("resource:calendar-records");
    const calendar = runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!calendar) throw Error("The production Calendar service did not start");
    const feed = vi.spyOn(calendar, "getCalendarFeed");
    const input = {
      id: MESSAGE_ID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: ROOM_ID,
      content: { text: "Read my phone Calendar", source: "client_chat" },
    } as Memory;
    const execute = (
      details: Record<string, unknown> = {},
      subaction = "feed",
    ) =>
      executePlannedToolCall(
        runtime,
        {
          message: input,
          activeContexts: ["calendar"],
          userRoles: ["OWNER"],
          callback: async () => [],
        },
        {
          name: "CALENDAR",
          params: {
            subaction,
            details: { ...WINDOW, timeZone: "UTC", ...details },
          },
        },
        { actions: [action] },
      );
    const rejected = await withDeviceActionTurn(runtime, credentials, () =>
      execute(),
    );
    expect(rejected.success).toBe(false);
    expect(feed).not.toHaveBeenCalled();
    expect(rejected.effectReceipts?.[0]).toMatchObject({ outcome: "failed" });
    expect(rejected.data).toMatchObject({
      error: "CALENDAR_NATIVE_RESOURCE_REQUIRED",
    });
    const explicitBackend = await withDeviceActionTurn(
      runtime,
      credentials,
      () => execute({ grantId: "eliza-calendar" }),
    );
    expect(explicitBackend.success).toBe(false);
    expect(feed).not.toHaveBeenCalled();
    for (const subaction of [
      "create_event",
      "next_event",
      "update_event",
      "delete_event",
    ])
      expect(
        (
          await withDeviceActionTurn(runtime, credentials, () =>
            execute({}, subaction),
          )
        ).success,
      ).toBe(false);
    expect(feed).not.toHaveBeenCalled();
    await expect(
      withDeviceActionTurn(
        runtime,
        { ...credentials, deviceKey: "b".repeat(64) },
        () => execute(),
      ),
    ).rejects.toThrow("Device unavailable");
    // Client metadata alone is not native authority; ordinary owner use stays available.
    input.content.metadata = {
      clientDevice: { context: { view: "calendar" } },
    };
    const normal = await execute();
    expect(normal.success).toBe(true);
    expect(feed).toHaveBeenCalledOnce();
    const googleGrant = {
      id: "connector-account:fixture-google",
      agentId: runtime.agentId,
      provider: "google",
      connectorAccountId: "fixture-google",
      side: "owner",
      identity: { email: "fixture@example.test" },
      identityEmail: "fixture@example.test",
      capabilities: ["google.calendar.read"],
      grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      mode: "local",
      executionTarget: "local",
      sourceOfTruth: "connector_account",
      metadata: {},
    };
    calendar.setGate({
      ...gate(),
      getGoogleConnectorAccounts: async () => [{ grant: googleGrant }] as never,
      requireGoogleCalendarGrant: async (_url, _mode, _side, grantId) => {
        if (grantId !== googleGrant.id) throw Error("Unknown fixture grant");
        return googleGrant as never;
      },
    });
    const services = runtime.getService.bind(runtime);
    const googlePages = vi.fn(async (_args?: { accountId?: string }) => ({
      events: [] as GoogleCalendarEvent[],
      nextPageToken: null,
      nextSyncToken: null,
    }));
    vi.spyOn(runtime, "getService").mockImplementation((name: string) =>
      name === "google"
        ? ({
            listCalendars: async () => [
              {
                calendarId: "primary",
                summary: "Connected Google fixture",
                primary: true,
                accessRole: "owner",
                timeZone: "UTC",
                selected: true,
              },
            ],
            listEventPage: googlePages,
          } as never)
        : services(name),
    );
    appleTesting.setNativeCalendarBridgeForTest({
      platform: "fixture",
      checkPermissions: async () => ({
        calendar: "granted",
        canRequest: false,
        fullAccessSupported: true,
      }),
      listCalendars: async () => ({
        ok: true,
        calendars: [
          {
            calendarId: "fixture-apple",
            summary: "Connected Apple fixture",
            accessRole: "owner",
            timeZone: "UTC",
          },
        ],
      }),
      listEvents: async () => ({ ok: true, events: [] }),
      createEvent: async () => {
        throw Error("No fixture write expected");
      },
      updateEvent: async () => {
        throw Error("No fixture write expected");
      },
      deleteEvent: async () => {
        throw Error("No fixture write expected");
      },
    });
    for (const [grantId, calendarId] of [
      [googleGrant.id, "primary"],
      ["apple-calendar", "fixture-apple"],
    ]) {
      const result = await withDeviceActionTurn(runtime, credentials, () =>
        execute({ grantId, calendarId, includeHiddenCalendars: true }),
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        sources?: Array<{ key: { grantId: string } }>;
      };
      expect(data.sources?.length).toBeGreaterThan(0);
      expect(
        data.sources?.every((source) => source.key.grantId === grantId),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(
        '"grantId":"eliza-calendar"',
      );
      const next = await withDeviceActionTurn(runtime, credentials, () =>
        execute({ grantId, calendarId }, "next_event"),
      );
      expect(next.success).toBe(true);
      expect(feed.mock.lastCall?.[1]).toMatchObject({ grantId });
      expect(JSON.stringify(next)).not.toContain('"grantId":"eliza-calendar"');
      const list = vi.spyOn(calendar, "listCalendars");
      const extraction = vi.spyOn(runtime, "useModel").mockResolvedValue(
        JSON.stringify({
          requiresInput: true,
          clarification: "Fixture needs an event time",
        }),
      );
      await withDeviceActionTurn(runtime, credentials, () =>
        execute({ grantId }, "create_event"),
      );
      expect(list).toHaveBeenLastCalledWith(expect.any(URL), { grantId });
      expect(feed.mock.lastCall?.[1]).toMatchObject({ grantId });
      expect(extraction).toHaveBeenCalledOnce();
      extraction.mockRestore();
      list.mockRestore();
    }
    expect(googlePages).toHaveBeenCalled();
    // A connected grant must not turn a built-in event identifier into a
    // backend lookup before the handler checks the returned source.
    const builtIn = await calendar.createCalendarEvent(
      new URL("http://127.0.0.1/"),
      {
        grantId: "eliza-calendar",
        calendarId: "primary",
        title: "UNSELECTED_BACKEND_EVENT",
        startAt: "2026-10-10T10:00:00.000Z",
        endAt: "2026-10-10T11:00:00.000Z",
        timeZone: "UTC",
        idempotencyKey: "native-source-prelookup-fixture",
      },
    );
    const backendRead = vi.spyOn(
      Reflect.get(calendar, "repo"),
      "getCalendarEventById",
    );
    const lookup = vi.spyOn(calendar, "getConditionalCalendarMutationTarget");
    const extraction = vi.spyOn(runtime, "useModel");
    const approvalsBefore = await executeRawSqlTx(
      runtime.adapter.db as TransactionalDb,
      "SELECT COUNT(*) AS count FROM approval_requests",
    );
    for (const grantId of [googleGrant.id, "apple-calendar"])
      for (const subaction of ["update_event", "delete_event"]) {
        const rejected = await withDeviceActionTurn(runtime, credentials, () =>
          execute({ grantId, eventId: builtIn.id }, subaction),
        );
        expect(rejected.success).toBe(false);
        expect(rejected.data).toMatchObject({
          error: "CALENDAR_NATIVE_RESOURCE_REQUIRED",
        });
      }
    expect(lookup).not.toHaveBeenCalled();
    expect(backendRead).not.toHaveBeenCalled();
    expect(extraction).not.toHaveBeenCalled();
    expect(
      await executeRawSqlTx(
        runtime.adapter.db as TransactionalDb,
        "SELECT COUNT(*) AS count FROM approval_requests",
      ),
    ).toEqual(approvalsBefore);
    lookup.mockRestore();
    backendRead.mockRestore();
    extraction.mockRestore();
    // Valid native writes reach availability and its alternatives reload; both
    // must retain the chosen connected source rather than reopen merged history.
    const day = new Date(Date.now() + 86400000);
    day.setUTCHours(10, 0, 0, 0);
    const startAt = day.toISOString(),
      endAt = new Date(day.getTime() + 3600000).toISOString();
    await calendar.createCalendarEvent(new URL("http://127.0.0.1/"), {
      grantId: "eliza-calendar",
      calendarId: "primary",
      title: "FORBIDDEN_ELIZA_AVAILABILITY",
      startAt,
      endAt,
      timeZone: "UTC",
      idempotencyKey: "native-availability-sentinel",
    });
    const otherGrant = {
      ...googleGrant,
      id: "connector-account:other-fixture",
      connectorAccountId: "other-fixture",
    };
    googleGrant.capabilities.push("google.calendar.write");
    const wireEvent = (
      id: string,
      title: string,
      start: string,
      end: string,
    ): GoogleCalendarEvent => ({
      id,
      title,
      status: "confirmed",
      start,
      end,
      timeZone: "UTC",
      calendarId: "primary",
      metadata: {
        etag: "fixture-version",
        updatedAt: new Date().toISOString(),
      },
    });
    const targetEvent = wireEvent(
      "target-fixture",
      "Selected target",
      new Date(day.getTime() - 7200000).toISOString(),
      new Date(day.getTime() - 3600000).toISOString(),
    );
    googlePages.mockImplementation(async (args) => ({
      events:
        args?.accountId === "other-fixture"
          ? [
              wireEvent(
                "other-busy",
                "FORBIDDEN_OTHER_AVAILABILITY",
                startAt,
                endAt,
              ),
            ]
          : [
              targetEvent,
              wireEvent("selected-busy", "Selected conflict", startAt, endAt),
            ],
      nextPageToken: null,
      nextSyncToken: null,
    }));
    const googlePort = {
      listCalendars: async () => [
        {
          calendarId: "primary",
          summary: "Fixture calendar",
          primary: true,
          accessRole: "owner",
          timeZone: "UTC",
          selected: true,
        },
      ],
      listEventPage: googlePages,
      getEvent: vi.fn(async (request: { accountId?: string }) => {
        expect(request.accountId).toBe(googleGrant.connectorAccountId);
        return targetEvent;
      }),
    };
    vi.mocked(runtime.getService).mockImplementation((name: string) =>
      name === "google" ? (googlePort as never) : services(name),
    );
    calendar.setGate({
      ...gate(),
      getGoogleConnectorAccounts: async () =>
        [{ grant: googleGrant }, { grant: otherGrant }] as never,
      requireGoogleCalendarGrant: async (_u, _m, _s, id) => {
        const grant = [googleGrant, otherGrant].find(
          (grant) => grant.id === id,
        );
        if (!grant) throw Error("Wrong read grant");
        return grant as never;
      },
      requireGoogleCalendarWriteGrant: async (_u, _m, _s, id) => {
        if (id !== googleGrant.id) throw Error("Wrong write grant");
        return googleGrant as never;
      },
    });
    for (const source of await calendar.listCalendars(
      new URL("http://127.0.0.1/"),
    )) {
      if (source.provider !== "google") continue;
      await calendar.setCalendarIncluded(new URL("http://127.0.0.1/"), {
        provider: source.provider,
        side: source.side,
        grantId: source.grantId,
        connectorAccountId: source.connectorAccountId,
        calendarId: source.calendarId,
        includeInFeed: true,
        expectedVersion: source.selectionVersion,
      });
    }
    for (const { subaction, native } of [
      { subaction: "create_event", native: true },
      { subaction: "update_event", native: true },
      { subaction: "create_event", native: false },
    ]) {
      input.content.text =
        subaction === "create_event"
          ? `Create Scoped appointment on ${startAt} until ${endAt} in UTC`
          : `Move Selected target to ${startAt} until ${endAt} in UTC`;
      const extraction = vi
        .spyOn(runtime, "useModel")
        .mockImplementation(async (_type, parameters) =>
          String(
            parameters &&
              typeof parameters === "object" &&
              "prompt" in parameters
              ? parameters.prompt
              : "",
          ).includes("Extract calendar")
            ? JSON.stringify({
                requiresInput: false,
                title:
                  subaction === "create_event" ? "Scoped appointment" : null,
                startAt,
                endAt,
                timeZone: "UTC",
                grantId: googleGrant.id,
                calendarId: "primary",
              })
            : "Only selected calendar evidence.",
        );
      feed.mockClear();
      googlePages.mockClear();
      const run = () =>
        execute(
          {
            grantId: googleGrant.id,
            calendarId: "primary",
            ...(subaction === "update_event"
              ? { eventId: "target-fixture" }
              : {}),
          },
          subaction,
        );
      const result = native
        ? await withDeviceActionTurn(runtime, credentials, run)
        : await run();
      expect(result.data).toHaveProperty("availability");
      expect(feed.mock.calls.length).toBeGreaterThanOrEqual(
        subaction === "create_event" ? 3 : 2,
      );
      expect(JSON.stringify(result)).toContain("Selected conflict");
      if (native) {
        expect(JSON.stringify(result)).not.toMatch(
          /FORBIDDEN_(ELIZA|OTHER)_AVAILABILITY/,
        );
        expect(
          feed.mock.calls.every(
            ([, request]) => request?.grantId === googleGrant.id,
          ),
        ).toBe(true);
        expect(
          googlePages.mock.calls.every(
            ([request]) =>
              request?.accountId === googleGrant.connectorAccountId,
          ),
        ).toBe(true);
        if (subaction === "update_event")
          expect(googlePort.getEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              accountId: googleGrant.connectorAccountId,
              calendarId: "primary",
              eventId: "target-fixture",
            }),
          );
        expect(JSON.stringify(extraction.mock.calls)).not.toMatch(
          /FORBIDDEN_(ELIZA|OTHER)_AVAILABILITY/,
        );
      } else {
        expect(
          feed.mock.calls.some(([, request]) => request?.grantId === undefined),
        ).toBe(true);
        expect(JSON.stringify(result)).toContain(
          "FORBIDDEN_ELIZA_AVAILABILITY",
        );
        expect(JSON.stringify(result)).toContain(
          "FORBIDDEN_OTHER_AVAILABILITY",
        );
      }
      extraction.mockRestore();
    }
    const unknown = await withDeviceActionTurn(runtime, credentials, () =>
      execute({ grantId: "connector-account:unavailable" }),
    );
    // The established feed contract records unavailable separately from empty.
    expect(unknown.data).toMatchObject({ state: "unavailable" });
    expect(JSON.stringify(unknown)).not.toContain('"grantId":"eliza-calendar"');
  } finally {
    appleTesting.setNativeCalendarBridgeForTest(null);
    await fixture.cleanup();
  }
}, 60000);

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

function calendarBody(): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//elizaOS//calendar action receipt test//EN",
    "BEGIN:VEVENT",
    "UID:school-pickup-1",
    "SEQUENCE:1",
    "LAST-MODIFIED:20260727T180000Z",
    "DTSTAMP:20260727T180000Z",
    "DTSTART:20260728T220000Z",
    "DTEND:20260728T223000Z",
    "SUMMARY:School pickup",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
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
  await ensureCalendarFeedPreferenceTable(
    async (statement) =>
      (await pg.query<Record<string, unknown>>(statement)).rows,
  );
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
    getRoom: vi.fn(async () => ({ worldId: "world-id" })),
    getWorld: vi.fn(async () => ({
      metadata: {
        roles: { [ENTITY_ID]: "OWNER" },
        roleSources: { [ENTITY_ID]: "manual" },
      },
    })),
    adapter: { db },
    getSetting: () => undefined,
    getService: (serviceType: string) =>
      serviceType === SECRETS_SERVICE_TYPE
        ? secretsService
        : serviceType === CalendarService.serviceType
          ? service
          : null,
    getCache: async () => undefined,
    setCache: async () => undefined,
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate(gate());
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_sources");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
  secrets.clear();
  vi.clearAllMocks();
});

afterAll(async () => {
  await pg.close();
});

describe("CALENDAR receipt grounding over real PGlite", () => {
  it("reads the requested civil day without shifting boundary events or changing storage", async () => {
    const source = await service.createIcsCalendarSource({
      name: "Boundary calendar",
      url: SOURCE_URL,
    });
    const events = [
      ["previous", "20260727T233000Z", "20260728T000000Z"],
      ["early", "20260728T003000Z", "20260728T010000Z"],
      ["late", "20260728T233000Z", "20260729T000000Z"],
      ["next", "20260729T003000Z", "20260729T010000Z"],
    ];
    const body = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//elizaOS//window test//EN",
      ...events.flatMap(([name, start, end]) => [
        "BEGIN:VEVENT",
        `UID:${name}`,
        "DTSTAMP:20260727T180000Z",
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${name}`,
        "END:VEVENT",
      ]),
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    await service.syncIcsCalendarSource(source.id, {
      now: new Date(),
      transport: {
        fetchImpl: async () =>
          new Response(body, { headers: { "content-type": "text/calendar" } }),
      },
    });
    const before = await pg.query(
      "SELECT * FROM app_calendar.life_calendar_events ORDER BY id",
    );
    expect(before.rows).toHaveLength(4);
    const action = createCalendarActionRunner({
      runTextModel: async () => {
        throw new Error("Typed reads must not invoke a model");
      },
      runJsonModel: async () => {
        throw new Error("Typed reads must not invoke a model");
      },
      recentConversationTexts: async () => [],
    });
    for (const [timeZone, titles] of [
      ["UTC", ["early", "late"]],
      ["Asia/Tokyo", ["previous", "early"]],
    ] as const) {
      const details = {
        timeMin: "2026-07-28T00:00:00",
        timeMax: "2026-07-29T00:00:00",
        timeZone,
      };
      const feed = await service.getCalendarFeed(
        new URL("http://127.0.0.1/"),
        details,
      );
      expect(feed.events.map((event) => event.title).sort()).toEqual(
        [...titles].sort(),
      );
      const result = await executePlannedToolCall(
        runtime,
        {
          message: {
            id: MESSAGE_ID,
            agentId: AGENT_ID,
            entityId: ENTITY_ID,
            roomId: ROOM_ID,
            content: {
              text: "Read this calendar day. Do not change any records.",
            },
          } as Memory,
          userRoles: ["OWNER"],
          activeContexts: ["calendar"],
          callback: async () => [],
        },
        { name: action.name, params: { subaction: "feed", details } },
        { actions: [action] },
      );
      expect(result.success).toBe(true);
      expect(result.data?.events).toEqual(feed.events);
      expect(result.effectReceipts?.[0]).toMatchObject({
        operation: "calendar.feed.read",
        outcome: "noop",
      });
    }
    expect(
      (
        await pg.query(
          "SELECT * FROM app_calendar.life_calendar_events ORDER BY id",
        )
      ).rows,
    ).toEqual(before.rows);
  }, 30_000);

  it("hands off the persisted ICS snapshot with its authoritative timestamp", async () => {
    const source = await service.createIcsCalendarSource({
      name: "Family calendar",
      url: SOURCE_URL,
    });
    const synced = await service.syncIcsCalendarSource(source.id, {
      now: new Date(),
      transport: {
        fetchImpl: async () =>
          new Response(calendarBody(), {
            status: 200,
            headers: {
              "content-type": "text/calendar",
              etag: '"calendar-revision-1"',
            },
          }),
      },
    });
    const persisted = await pg.query<{
      id: string;
      external_event_id: string;
      title: string;
      synced_at: string;
      updated_at: string;
    }>(
      `SELECT id, external_event_id, title, synced_at, updated_at
         FROM app_calendar.life_calendar_events`,
    );
    expect(persisted.rows, JSON.stringify(synced)).toEqual([
      expect.objectContaining({
        external_event_id: expect.stringMatching(/^ics:[a-f0-9]{64}$/),
        title: "School pickup",
      }),
    ]);

    const actionDeps: CalendarActionDeps = {
      runTextModel: vi.fn(async () => null),
      runJsonModel: vi.fn(async () => null),
      recentConversationTexts: vi.fn(async () => []),
    };
    const action = createCalendarActionRunner(actionDeps);
    const delivered: Content[] = [];
    const actor = {
      id: MESSAGE_ID,
      agentId: AGENT_ID,
      entityId: ENTITY_ID,
      roomId: ROOM_ID,
      createdAt: Date.now(),
      content: { text: "What is on the family calendar tomorrow?" },
    } as Memory;

    const result = await executePlannedToolCall(
      runtime,
      {
        message: actor,
        userRoles: ["OWNER"],
        activeContexts: ["calendar"],
        callback: async (content) => {
          delivered.push(content);
          return [];
        },
      },
      {
        name: action.name,
        params: {
          subaction: "feed",
          details: WINDOW,
        },
      },
      {
        actions: [action],
      },
    );

    const persistedObservedAt = persisted.rows[0]?.synced_at;
    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      transcriptVisibility: "internal",
      effectReceipts: [
        {
          operation: "calendar.feed.read",
          outcome: "noop",
          observedAt: result.data?.syncedAt,
          resource: {
            kind: "calendar.feed",
          },
        },
      ],
      data: {
        events: [
          expect.objectContaining({
            externalId: persisted.rows[0]?.external_event_id,
            title: "School pickup",
          }),
        ],
      },
    });
    expect(result.data?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.objectContaining({ provider: "ics" }),
          syncedAt: persistedObservedAt,
        }),
      ]),
    );
    expect(persistedObservedAt).toBe(synced.source.updatedAt);
    expect(result.data?.replyContext).toMatchObject({
      domain: "calendar",
      intent: actor.content.text,
      scenario: "feed_results",
      facts: expect.stringContaining("School pickup"),
      context: { label: expect.any(String) },
    });
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("userFacingText");
    expect(result).not.toHaveProperty("verifiedUserFacing");
    expect(delivered).toEqual([]);
  }, 30_000);
});
