/** Real Core validation + registered Calendar handler + CalendarService/PGlite.
 * Fixed model extraction proves authority paths, not live model classification. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeMigrator } from "../../plugin-sql/src/runtime-migrator/runtime-migrator.ts";
import { createCalendarActionRunner } from "../src/actions/calendar-handler.ts";
import { __testing } from "../src/apple-calendar.ts";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.ts";
import { CalendarService } from "../src/service/CalendarService.ts";
import { calendarSchema } from "../src/service/schema.ts";

let seedVerified = false;
let engineVerified = false;
let sqlDuringAction: string[] = [];
function emptySeed(): Blob | undefined {
  const fixtureRoot = process.env.CALENDAR_PRIVATE_EMPTY_FIXTURE;
  seedVerified = false;
  engineVerified = false;
  if (!fixtureRoot) return undefined;
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixtureRoot, "EMPTY-PGLITE-SEED-MANIFEST.json"),
      "utf8",
    ),
  );
  expect(manifest.businessRowsPreseeded).toBe(false);
  const bytes = fs.readFileSync(path.join(fixtureRoot, manifest.seedFile));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    manifest.seedSHA256,
  );
  seedVerified = true;
  const pkgRoot = fs.realpathSync(
    fileURLToPath(
      new URL("../../../node_modules/@electric-sql/pglite", import.meta.url),
    ),
  );
  expect(pkgRoot).toBe(manifest.engine.packageRoot);
  expect(
    JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"))
      .version,
  ).toBe(manifest.engine.version);
  for (const [relative, digest] of Object.entries(manifest.engine.files)) {
    const file = path.resolve(pkgRoot, relative);
    if (!file.startsWith(pkgRoot + path.sep))
      throw new Error("Foreign engine fixture path");
    expect(
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    ).toBe(digest);
  }
  engineVerified = true;
  return new Blob([new Uint8Array(bytes)]);
}

const URL_ = new URL("http://internal.local/api/calendar");
const message: Memory = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  entityId: "00000000-0000-4000-8000-000000000003",
  createdAt: Date.parse("2050-08-01T12:00:00Z"),
  content: { text: "At 3 PM UTC on 2050-08-04 for one hour." },
};
let pg: PGlite;
let runtime: IAgentRuntime;
let service: CalendarService;
const priorGuestIntent = {
  state: "requested",
  evidence: [
    { sourceId: "history:0", quote: "Invite sam.taylor@acme.com to lunch." },
  ],
  guests: [
    {
      name: "Sam Taylor",
      email: "sam.taylor@acme.com" as string | null,
      optional: false,
    },
  ],
};
let guestIntent = structuredClone(priorGuestIntent);
let currentText = message.content.text ?? "";
let creationOverrides: Record<string, unknown> | undefined;
let extractionCount = 0;
const action = createCalendarActionRunner({
  runTextModel: async () => null,
  runJsonModel: async () => {
    extractionCount += 1;
    return {
      rawResponse: "{}",
      parsed: {
        title: "Lunch",
        requiresInput: false,
        clarification: null,
        description: null,
        location: null,
        guestIntent,
        noteIntent: {
          state: "none",
          sourceNote: null,
          evidence: [{ sourceId: `current:${message.id}`, quote: currentText }],
        },
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: "primary",
        startAt: "2050-08-04T15:00:00Z",
        endAt: "2050-08-04T16:00:00Z",
        timeZone: "UTC",
        ...creationOverrides,
      },
    };
  },
  recentConversationTexts: async () => [],
});
beforeEach(async () => {
  creationOverrides = undefined;
  extractionCount = 0;
  guestIntent = structuredClone(priorGuestIntent);
  sqlDuringAction = [];
  const seed = emptySeed();
  pg = new PGlite(seed ? { loadDataDir: seed } : {});
  const initial = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM information_schema.schemata WHERE schema_name='app_calendar'",
  );
  expect(initial.rows[0].count).toBe(0);
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  runtime = {
    agentId: "00000000-0000-4000-8000-000000000004",
    actions: [action],
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async () => undefined,
    setCache: async () => undefined,
    getRoom: async () => ({
      id: message.roomId,
      worldId: "00000000-0000-4000-8000-000000000005",
    }),
    getWorld: async () => ({
      id: "00000000-0000-4000-8000-000000000005",
      metadata: { ownership: { ownerId: message.entityId } },
    }),
    getEntityById: async (id: string) => ({ id, metadata: {} }),
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? message.entityId : undefined,
    getService: (name: string) =>
      name === CalendarService.serviceType ? service : null,
    reportError: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    useModel: () => {
      throw new Error("Unexpected model invocation");
    },
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate({
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("No external guest lookup");
    },
    requireGoogleCalendarGrant: async () => {
      throw new Error("No external Google read");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("No external Google write");
    },
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  });
  __testing.setNativeCalendarBridgeForTest(null);
}, 30_000);
afterEach(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  try {
    const rows = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app_calendar.life_calendar_events",
    );
    const output = process.env.CALENDAR_PRIVATE_CASE_RECEIPTS;
    if (output)
      fs.appendFileSync(
        output,
        `${JSON.stringify({
          case: expect.getState().currentTestName,
          eventRows: rows.rows[0].count,
          sqlDuringAction,
          extractionCount,
          seedVerified,
          engineVerified,
          timebase: "2050-08-01T12:00:00Z",
        })}\n`,
      );
  } finally {
    await pg.close();
  }
});

async function executeDirect(text: string) {
  currentText = text;
  const currentMessage: Memory = {
    ...message,
    content: { text, source: "test" },
  };
  const params = {
    subaction: "create_event",
    title: "Meet with Shaw",
    details: {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      timeZone: "UTC",
      start: "2050-08-01T12:20:00Z",
      end: "2050-08-01T13:20:00Z",
      attendees: [{ email: "sam.taylor@acme.com", displayName: "Shaw" }],
    },
  };
  const before = structuredClone({ currentMessage, params });
  const queries = vi.spyOn(pg, "query");
  const result = await executePlannedToolCall(
    runtime,
    {
      message: currentMessage,
      state: { values: {}, data: {}, text: "" },
      replyOwner: "planner",
      userRoles: ["OWNER"],
      activeContexts: ["calendar"],
    },
    { name: "CALENDAR", params },
    { actions: runtime.actions },
  );
  sqlDuringAction = queries.mock.calls.map(([sql]) =>
    typeof sql === "string"
      ? sql.trimStart().split(/\s+/, 1)[0].toUpperCase()
      : "structured",
  );
  queries.mockRestore();
  expect({ currentMessage, params }).toEqual(before);
  return result;
}
// These fixed extractor answers prove original-source authority and write ordering,
// not how a live model classifies a private meeting versus an invitation.
describe("private person-named meeting versus explicit invitation", () => {
  const requestStart = "2050-08-01T12:20:00.000Z";
  const requestEnd = "2050-08-01T13:20:00.000Z";
  const readWindow = {
    timeMin: "2050-08-01T00:00:00Z",
    timeMax: "2050-08-02T00:00:00Z",
  };
  async function createAtSyntheticRequestTime(
    text: string,
    guests: typeof priorGuestIntent.guests,
    intent: "none" | "requested",
  ) {
    creationOverrides = {
      title: "Meet with Shaw",
      startAt: requestStart,
      endAt: requestEnd,
      durationMinutes: 60,
      timeZone: "UTC",
    };
    guestIntent = {
      state: intent,
      evidence: [{ sourceId: `current:${message.id}`, quote: text }],
      guests,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(message.createdAt as number);
    try {
      return await executeDirect(text);
    } finally {
      vi.useRealTimers();
    }
  }
  it("stores an owner-private meeting with no attendees when original extraction says NONE despite an invented planner attendee", async () => {
    const commit = vi.spyOn(service, "createCalendarEvent");
    try {
      const result = await createAtSyntheticRequestTime(
        "create an event to meet with shaw in20mins for1hr",
        [],
        "none",
      );
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(extractionCount).toBe(1);
      expect(commit).toHaveBeenCalledOnce();
      const feed = await service.getCalendarFeed(URL_, readWindow);
      expect(feed.events).toEqual([
        expect.objectContaining({
          agentId: runtime.agentId,
          title: "Meet with Shaw",
          startAt: requestStart,
          endAt: requestEnd,
          timezone: "UTC",
          attendees: [],
        }),
      ]);
      expect(
        Date.parse(feed.events[0].endAt) - Date.parse(feed.events[0].startAt),
      ).toBe(60 * 60_000);
    } finally {
      commit.mockRestore();
    }
  });
  it("clarifies an explicit invitation with no verified email and performs zero prepare or create writes", async () => {
    const prepare = vi.spyOn(service, "prepareCalendarEventCreate"),
      commit = vi.spyOn(service, "createCalendarEvent");
    try {
      const result = await createAtSyntheticRequestTime(
        "Invite Shaw to an event in 20 minutes for 1 hour.",
        [{ name: "Shaw", email: null, optional: false }],
        "requested",
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain(
        "CALENDAR_ATTENDEE_IDENTITY_REQUIRED",
      );
      expect(extractionCount).toBe(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect((await service.getCalendarFeed(URL_, readWindow)).events).toEqual(
        [],
      );
    } finally {
      prepare.mockRestore();
      commit.mockRestore();
    }
  });
  it("keeps an explicit literal email from the current user evidence in the saved invitation", async () => {
    const commit = vi.spyOn(service, "createCalendarEvent");
    try {
      const result = await createAtSyntheticRequestTime(
        "Invite Shaw at sam.taylor@acme.com to an event in 20 minutes for 1 hour.",
        [{ name: "Shaw", email: "sam.taylor@acme.com", optional: false }],
        "requested",
      );
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(extractionCount).toBe(1);
      expect(commit).toHaveBeenCalledOnce();
      expect((await service.getCalendarFeed(URL_, readWindow)).events).toEqual([
        expect.objectContaining({
          startAt: requestStart,
          endAt: requestEnd,
          attendees: [
            expect.objectContaining({
              email: "sam.taylor@acme.com",
              displayName: "Shaw",
            }),
          ],
        }),
      ]);
    } finally {
      commit.mockRestore();
    }
  });
});
