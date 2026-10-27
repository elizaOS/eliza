/** Review repros for 28a249541cd: Calendar create through the real Calendar
 * action and CalendarService/PGlite writes. The create extractor is a fixed
 * double; each case states the user message, the planner CALENDAR arguments
 * and the extractor result. Guest cases run through the planned-tool executor
 * with an empty selected history, as calendar-attendee-provenance does. */
import { PGlite } from "@electric-sql/pglite";
import {
  type ContextObject,
  completionContextSources,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
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
import type { PlannerRuntime } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import {
  buildV5ExecutorContext,
  executeV5PlannedToolCall,
} from "../../plugin-assistant/src/services/message/planned-tool.ts";
import { createCalendarActionRunner } from "../src/actions/calendar-handler.ts";
import { __testing } from "../src/apple-calendar.ts";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.ts";
import { CalendarService, calendarSchema } from "../src/service/index.ts";

const OWNER = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  entityId: "00000000-0000-4000-8000-000000000003",
};
const AGENT_ID = "00000000-0000-4000-8000-000000000004";
const WORLD_ID = "00000000-0000-4000-8000-000000000005";
let pg: PGlite;
let runtime: IAgentRuntime;
let service: CalendarService;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async () => undefined,
    setCache: async () => undefined,
    getRoom: async () => ({ id: OWNER.roomId, worldId: WORLD_ID }),
    getWorld: async () => ({
      id: WORLD_ID,
      metadata: { ownership: { ownerId: OWNER.entityId } },
    }),
    getEntityById: async (id: string) => ({ id, metadata: {} }),
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER.entityId : undefined,
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
beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
});
afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

/** The Calendar action with a fixed create extraction. The evidence quotes the
 * current request, the only original source in these cases. */
function calendarAction(text: string, extracted: Record<string, unknown>) {
  const evidence = [{ sourceId: `current:${OWNER.id}`, quote: text.trim() }];
  return createCalendarActionRunner({
    runTextModel: async () => null,
    runJsonModel: async ({ actionType }: { actionType: string }) =>
      actionType === "lifeops.calendar.extract_create_event"
        ? {
            rawResponse: "{}",
            parsed: {
              requiresInput: false,
              clarification: null,
              grantId: ELIZA_CALENDAR_GRANT_ID,
              calendarId: ELIZA_CALENDAR_ID,
              description: null,
              location: null,
              timeZone: null,
              recurrence: null,
              travelOriginAddress: null,
              isShortPreparation: false,
              guestIntent: { state: "none", evidence, guests: [] },
              noteIntent: { state: "none", evidence, sourceNote: null },
              ...extracted,
            },
          }
        : null,
    recentConversationTexts: async () => [],
  });
}

async function savedEvents() {
  return (
    await pg.query<{
      start_at: string;
      timezone: string;
      location: string;
      description: string;
      attendees_json: unknown;
    }>(
      "SELECT start_at, timezone, location, description, attendees_json FROM app_calendar.life_calendar_events",
    )
  ).rows;
}

describe("Calendar create review repros at 28a249541cd", {
  timeout: 30_000,
}, () => {
  /** Planner tool CALENDAR {subaction:"create_event", title:"Lunch",
   * details:{grantId, calendarId, timeZone:"UTC", start, end,
   * attendees:[<planner attendee>]}} through executeV5PlannedToolCall, with a
   * selected history that admits no prior message. */
  async function executeGuestCase(
    request: string,
    guestIntent: Record<string, unknown>,
  ) {
    const text = `${request} on 2050-08-04 at 3 PM UTC for an hour.`;
    const action = calendarAction(text, {
      title: "Lunch",
      startAt: "2050-08-04T15:00:00Z",
      endAt: "2050-08-04T16:00:00Z",
      timeZone: "UTC",
      guestIntent: {
        evidence: [{ sourceId: `current:${OWNER.id}`, quote: text }],
        ...guestIntent,
      },
    });
    const plannerContext: ContextObject = {
      id: OWNER.id,
      metadata: { roomId: OWNER.roomId, messageId: OWNER.id },
      events: [],
    };
    plannerContext.metadata = {
      ...plannerContext.metadata,
      completionContext: {
        mode: "selected",
        complete: true,
        sourceSetId: completionContextSources(plannerContext).sourceSetId,
        relevantSourceIds: [],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    };
    return executeV5PlannedToolCall({
      runtime,
      plannerRuntime: runtime as unknown as PlannerRuntime,
      plannerContext,
      executorCtx: buildV5ExecutorContext({
        message: {
          ...OWNER,
          createdAt: Date.parse("2050-08-01T12:00:00Z"),
          content: { text },
        } as Memory,
        state: { values: {}, data: {}, text: "" },
        selectedContexts: [],
        senderRole: "OWNER",
        previousResults: [],
      }),
      toolCall: {
        id: "calendar-create",
        name: "CALENDAR",
        params: {
          subaction: "create_event",
          title: "Lunch",
          details: {
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            timeZone: "UTC",
            start: "2050-08-04T15:00:00Z",
            end: "2050-08-04T16:00:00Z",
            attendees: [
              { email: "sam.taylor@acme.com", displayName: "Sam Taylor" },
            ],
          },
        },
      },
      executorOptions: { actions: [action] },
    });
  }

  // a) Corrected repro. User: "Invite Sam on 2050-08-04 at 3 PM UTC for an
  // hour." Extractor: guestIntent requested [{name:"Sam", email:null}].
  // Expected: no write, and the turn asks for Sam's address.
  it("asks for the address of a named guest without one", async () => {
    const result = await executeGuestCase("Invite Sam", {
      state: "requested",
      guests: [{ name: "Sam", email: null, optional: false }],
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "CALENDAR_CREATE_AUTHORITY_UNRESOLVED",
      requiresInput: true,
    });
    expect(await savedEvents()).toEqual([]);
  });

  // b) The earlier VPS double. Same request; extractor: guestIntent none,
  // guests []. The planner guest has no original evidence, so the event saves
  // without it. This is correct behavior; the earlier "guest silently dropped"
  // report came from this double, not from the code.
  it("drops the planner guest when the extractor finds no requested guest", async () => {
    const result = await executeGuestCase("Invite Sam", {
      state: "none",
      guests: [],
    });
    expect(result.success).toBe(true);
    expect(await savedEvents()).toMatchObject([{ attendees_json: "[]" }]);
  });

  // c) User: "Add a barber appointment on 2050-08-04 at 3 PM UTC for an hour."
  // Planner invents sam.taylor@acme.com; extractor: guestIntent none.
  // Expected: the event saves without the invented guest.
  it("drops an invented planner guest", async () => {
    const result = await executeGuestCase("Add a barber appointment", {
      state: "none",
      guests: [],
    });
    expect(result.success).toBe(true);
    expect(await savedEvents()).toMatchObject([{ attendees_json: "[]" }]);
  });

  /** Direct CALENDAR create for "Add a 15-minute launch review tomorrow at 4
   * pm" on 2050-09-15. Extractor: startAt 2050-09-16T16:00:00 local,
   * timeZone null, guestIntent and noteIntent none. No owner zone is set, so
   * the default zone is UTC. */
  async function createLaunchReview(
    text: string,
    details: Record<string, unknown>,
  ) {
    const action = calendarAction(text, {
      title: "Launch review",
      startAt: "2050-09-16T16:00:00",
      endAt: "2050-09-16T16:15:00",
      durationMinutes: 15,
    });
    return action.handler(
      runtime,
      {
        ...OWNER,
        createdAt: Date.parse("2050-09-15T16:00:00.000Z"),
        content: { text },
      } as Memory,
      undefined,
      {
        parameters: {
          subaction: "create_event",
          title: "Launch review",
          details,
        },
      },
    );
  }
  const LAUNCH_REVIEW = "Add a 15-minute launch review tomorrow at 4 pm";

  // d) Planner details {timeZone:"Asia/Tokyo"}. The user named no zone.
  // Expected: 16:00 in the default zone. At 28a249541cd the planner zone wins
  // and the event saves at 2050-09-17T07:00Z, Asia/Tokyo.
  it("ignores a planner time zone the user did not give", async () => {
    const result = await createLaunchReview(LAUNCH_REVIEW, {
      timeZone: "Asia/Tokyo",
    });
    expect(result?.success).toBe(true);
    expect(await savedEvents()).toMatchObject([
      { start_at: "2050-09-16T16:00:00.000Z", timezone: "UTC" },
    ]);
  });

  // e) User message with a trailing newline; planner details {}. Expected: the
  // event saves. At 28a249541cd the trimmed prompt quote does not match the
  // untrimmed source, and the create fails with CALENDAR_ATTENDEE_ARGUMENT_INVALID.
  it("accepts a request that ends with a newline", async () => {
    const result = await createLaunchReview(`${LAUNCH_REVIEW}\n`, {});
    expect(result?.data).not.toMatchObject({
      error: "CALENDAR_ATTENDEE_ARGUMENT_INVALID",
    });
    expect(await savedEvents()).toHaveLength(1);
  });

  // f) Planner details {location:"Conference Room Z", description:"Invented
  // agenda"}. The user gave neither. Expected: both stay empty. At
  // 28a249541cd both are saved.
  it("does not save a planner location or description the user did not give", async () => {
    await createLaunchReview(LAUNCH_REVIEW, {
      location: "Conference Room Z",
      description: "Invented agenda",
    });
    expect(await savedEvents()).toMatchObject([
      { location: "", description: "" },
    ]);
  });

  // f') Planner details {sourceNote:"launch brief"} and a foreign-agent
  // sourceNote object. Extractor: noteIntent none. The event saves without a
  // note reference; this already holds at 28a249541cd.
  it.each([
    "launch brief",
    { agentId: "other", noteId: "x", contentHash: "0".repeat(64) },
  ])("saves without an invented sourceNote %j", async (sourceNote) => {
    const result = await createLaunchReview(LAUNCH_REVIEW, { sourceNote });
    expect(result?.success).toBe(true);
    expect(await savedEvents()).toHaveLength(1);
  });
});
