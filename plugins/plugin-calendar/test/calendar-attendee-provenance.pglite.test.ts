/** Exercises original-dialogue admission through the real planned-tool executor,
 * Calendar action and CalendarService/PGlite writes. Runtime host services and
 * model extraction are deterministic; no model or external calendar is called. */
import { PGlite } from "@electric-sql/pglite";
import {
  actionToTool,
  type ContextObject,
  completionContextSources,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
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
import {
  type PlannerLoopParams,
  type PlannerRuntime,
  type PlannerToolCall,
  runPlannerLoop,
} from "../../plugin-assistant/src/runtime/planner-loop.ts";
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

const URL_ = new URL("http://internal.local/api/calendar");
const WINDOW = {
  timeMin: "2050-08-04T00:00:00Z",
  timeMax: "2050-08-05T00:00:00Z",
};
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
const action = createCalendarActionRunner({
  runTextModel: async () => null,
  runJsonModel: async () => ({
    rawResponse: "{}",
    parsed: {
      startAt: "2050-08-04T15:00:00Z",
      endAt: "2050-08-04T16:00:00Z",
      timeZone: "UTC",
    },
  }),
  recentConversationTexts: async () => [],
});
beforeAll(async () => {
  pg = new PGlite();
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
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  await pg.query("DELETE FROM app_calendar.life_calendar_feed_preferences");
});
afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

function context(mode: string): ContextObject {
  const ctx: ContextObject = {
    id: message.id,
    metadata: { roomId: message.roomId, messageId: message.id },
    events: [
      "Invite sam.taylor@acme.com to lunch.",
      "A different unrelated discussion.",
    ].map((content, i) => ({
      id: `history:${i}`,
      type: "segment",
      source: "prior-dialogue",
      segment: {
        id: `history:${i}`,
        label: "prior_message:user",
        content,
        stable: false,
        metadata: { roomId: message.roomId, entityId: message.entityId },
      },
    })),
  };
  if (["selected", "all", "empty", "stale"].includes(mode))
    ctx.metadata = {
      ...ctx.metadata,
      completionContext: {
        mode: "selected",
        complete: true,
        sourceSetId:
          mode === "stale"
            ? "stale"
            : completionContextSources(ctx).sourceSetId,
        relevantSourceIds:
          mode === "empty" ? [] : mode === "all" ? ["h1", "h2"] : ["h1"],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    };
  if (mode === "restored")
    ctx.metadata = {
      ...ctx.metadata,
      completionContext: undefined,
      plannerQueryTokensRestored: true,
    };
  const event = ctx.events[0];
  if (event.type === "segment") {
    if (mode === "other-user")
      event.segment.metadata = { ...event.segment.metadata, entityId: "other" };
    if (mode === "other-room")
      event.segment.metadata = { ...event.segment.metadata, roomId: "other" };
    if (mode === "assistant") event.segment.label = "prior_message:agent";
  }
  if (mode === "missing-binding") ctx.metadata = {};
  if (mode === "wrong-turn")
    ctx.metadata = { ...ctx.metadata, messageId: "old-message" };
  return ctx;
}
async function execute(
  mode: string,
  attendee: unknown = {
    email: "sam.taylor@acme.com",
    displayName: "Sam Taylor",
  },
  text = message.content.text,
  originalContext?: ContextObject,
  originalCall?: PlannerToolCall,
) {
  const plannerContext = originalContext ?? context(mode);
  const state: State = {
    values: {
      recentMessages: "Invite sam.taylor@acme.com",
      selectedActionConversation: "stale prior-turn value",
    },
    data: {},
    text: "Full provider context",
  };
  const before = structuredClone({ state, plannerContext });
  const result = await executeV5PlannedToolCall({
    runtime,
    plannerRuntime: runtime as unknown as PlannerRuntime,
    plannerContext,
    executorCtx: buildV5ExecutorContext({
      message: { ...message, content: { text } },
      state,
      selectedContexts: [],
      senderRole: "OWNER",
      previousResults: [],
    }),
    toolCall: originalCall ?? {
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
          attendees: [attendee],
        },
      },
    },
    executorOptions: { actions: [action] },
  });
  expect({ state, plannerContext }).toEqual(before);
  return result;
}

describe("Calendar attendee original-source contract", {
  timeout: 30_000,
}, () => {
  it("restores original guest evidence before executing the one subsequent Calendar call", async () => {
    const full = context("empty");
    const before = structuredClone(full);
    const calls: string[] = [];
    const commit = vi.spyOn(service, "createCalendarEvent");
    const executeCall = vi.fn<PlannerLoopParams["executeToolCall"]>(
      async (call, ctx) =>
        execute(
          "empty",
          undefined,
          undefined,
          ctx.trajectory.modelBaseContext ?? full,
          call,
        ),
    );
    try {
      const result = await runPlannerLoop({
        context: full,
        tools: [actionToTool(action)],
        runtime: {
          useModel: async (_type, params) => {
            calls.push(JSON.stringify(params));
            return calls.length === 1
              ? {
                  text: "",
                  toolCalls: [
                    {
                      id: "restore",
                      name: "RESTORE_CONTEXT",
                      arguments: {
                        scope: "history",
                        reason: "Recover the requested guest",
                      },
                    },
                    {
                      id: "must-not-run",
                      name: "CALENDAR",
                      arguments: { subaction: "create_event" },
                    },
                  ],
                }
              : {
                  text: "",
                  toolCalls: [
                    {
                      id: "create-after-restoration",
                      name: "CALENDAR",
                      arguments: {
                        subaction: "create_event",
                        title: "Lunch",
                        details: {
                          grantId: ELIZA_CALENDAR_GRANT_ID,
                          calendarId: ELIZA_CALENDAR_ID,
                          timeZone: "UTC",
                          start: "2050-08-04T15:00:00Z",
                          end: "2050-08-04T16:00:00Z",
                          attendees: [
                            {
                              email: "sam.taylor@acme.com",
                              displayName: "Sam Taylor",
                            },
                          ],
                        },
                      },
                    },
                  ],
                };
          },
        },
        executeToolCall: executeCall,
        evaluate: async () => ({
          success: true,
          decision: "FINISH",
          thought: "Checked saved event",
          messageToUser: "Created the event.",
        }),
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain("Invite sam.taylor@acme.com to lunch.");
      expect(calls[1]).toContain("Invite sam.taylor@acme.com to lunch.");
      expect(executeCall).toHaveBeenCalledOnce();
      expect(executeCall.mock.calls[0][0].id).toBe("create-after-restoration");
      expect(commit).toHaveBeenCalledOnce();
      expect(
        result.trajectory.modelBaseContext?.metadata?.completionContext,
      ).toBeUndefined();
      expect(full).toEqual(before);
      const feed = await service.getCalendarFeed(URL_, WINDOW);
      expect(feed.events).toHaveLength(1);
      expect(feed.events[0].attendees).toEqual([
        expect.objectContaining({ email: "sam.taylor@acme.com" }),
      ]);
    } finally {
      commit.mockRestore();
    }
  });
  it.each(["selected", "all", "missing", "stale", "restored"])(
    "retains explicit prior guest address with %s context",
    async (mode) => {
      const result = await execute(mode);
      expect(result.success, JSON.stringify(result)).toBe(true);
      const feed = await service.getCalendarFeed(URL_, WINDOW);
      expect(feed.events).toHaveLength(1);
      expect(feed.events[0].attendees).toEqual([
        expect.objectContaining({
          email: "sam.taylor@acme.com",
          displayName: "Sam Taylor",
        }),
      ]);
    },
  );
  it.each([
    "empty",
    "other-user",
    "other-room",
    "assistant",
    "wrong-turn",
    "missing-binding",
  ])("clarifies without a write for %s evidence", async (mode) => {
    const prepare = vi.spyOn(service, "prepareCalendarEventCreate");
    const commit = vi.spyOn(service, "createCalendarEvent");
    try {
      const result = await execute(mode);
      expect(result.success, JSON.stringify(result)).toBe(false);
      expect(JSON.stringify(result)).toContain(
        "CALENDAR_ATTENDEE_IDENTITY_REQUIRED",
      );
      expect(JSON.stringify(result)).toContain('"awaitingUserInput":true');
      expect(prepare).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect((await service.getCalendarFeed(URL_, WINDOW)).events).toEqual([]);
    } finally {
      prepare.mockRestore();
      commit.mockRestore();
    }
  });
  it("retains the current explicit request despite a reviewed empty history", async () => {
    expect(
      (
        await execute(
          "empty",
          undefined,
          "Invite sam.taylor@acme.com on 2050-08-04 at 3 PM UTC for an hour.",
        )
      ).success,
    ).toBe(true);
    expect(
      (await service.getCalendarFeed(URL_, WINDOW)).events[0].attendees,
    ).toEqual([expect.objectContaining({ email: "sam.taylor@acme.com" })]);
  });
  it.each([
    [
      "partial name",
      { email: "sam.taylor@acme.com", displayName: "Sam Taylor" },
      "Invite Sam",
    ],
    [
      "full name",
      { email: "sam.taylor@acme.com", displayName: "Sam Taylor" },
      "Invite Sam Taylor",
    ],
    ["missing display name", { email: "sam.taylor@acme.com" }, "Invite Sam"],
    ["missing mailbox", { displayName: "Sam Taylor" }, "Invite Sam"],
    [
      "reserved explicit",
      { email: "sam@example.com" },
      "Invite sam@example.com",
    ],
    [
      "invented attendee",
      { email: "sam.taylor@acme.com" },
      "Add a barber appointment",
    ],
  ])(
    "does not omit %s before the actual Calendar write",
    async (_label, attendee, request) => {
      const prepare = vi.spyOn(service, "prepareCalendarEventCreate");
      const commit = vi.spyOn(service, "createCalendarEvent");
      try {
        const result = await execute(
          "empty",
          attendee,
          `${request} on 2050-08-04 at 3 PM UTC for an hour.`,
        );
        expect(result.success, JSON.stringify(result)).toBe(false);
        if (_label === "missing mailbox")
          expect(result.data).toMatchObject({
            invalidParameterNames: ["details"],
          });
        else
          expect(JSON.stringify(result)).toContain(
            "CALENDAR_ATTENDEE_IDENTITY_REQUIRED",
          );
        expect(prepare).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect((await service.getCalendarFeed(URL_, WINDOW)).events).toEqual(
          [],
        );
      } finally {
        prepare.mockRestore();
        commit.mockRestore();
      }
    },
  );
});
