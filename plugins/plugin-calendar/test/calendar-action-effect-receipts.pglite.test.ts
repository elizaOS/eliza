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
  SECRETS_SERVICE_TYPE,
} from "@elizaos/core";
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
    adapter: { db },
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
  it("binds callback text to the persisted ICS snapshot timestamp", async () => {
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
      verifiedUserFacing: true,
      effectReceipts: [
        {
          operation: "calendar.feed.read",
          outcome: "noop",
          observedAt: persistedObservedAt,
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
    expect(result.effectReceipts?.[0]?.observedAt).toBe(
      synced.source.updatedAt,
    );
    expect(delivered).toEqual([
      expect.objectContaining({
        text: result.userFacingText,
        effectReceiptIds: [result.effectReceipts?.[0]?.receiptId],
      }),
    ]);
  }, 30_000);
});
