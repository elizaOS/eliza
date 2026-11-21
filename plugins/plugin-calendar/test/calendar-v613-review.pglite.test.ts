/**
 * v613 calendar review repros, replayed through the real Calendar action and
 * CalendarService/PGlite writes on the built-in calendar.
 *
 * 1. "reschedule v613 check for tomorrow at 10am", "push … until tomorrow at
 *    10am" and "move v613 check tomorrow at 10am" read the destination day as
 *    the event's current day and answered "No matching event".
 * 2. A built-in delete question the owner declined ("no, keep it") was still
 *    answered by a planner `confirmed=true` on that turn, or on any turn in the
 *    next 30 minutes.
 */
import { PGlite } from "@electric-sql/pglite";
import {
  bindIncomingMessagePersistence,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { RuntimeMigrator } from "@elizaos/plugin-sql";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createCalendarActionRunner,
  resolveCalendarMutationCandidates,
} from "../src/actions/calendar-handler.ts";
import { __testing } from "../src/apple-calendar.ts";
import {
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "../src/internal/eliza-calendar.ts";
import { CalendarService, calendarSchema } from "../src/service/index.ts";

const INTERNAL_URL = new URL("http://internal.local/api/calendar");
const ZONE = "America/Los_Angeles";
// Fri Nov 20 2026, 2pm in Los Angeles.
const NOW = "2026-11-20T22:00:00.000Z";
const OWNER = "00000000-0000-4000-8000-000000000102";
const ROOM = "00000000-0000-4000-8000-000000000103";
let pg: PGlite;
let service: CalendarService;
let runtime: IAgentRuntime;
const cache = new Map<string, unknown>();
/** Messages in the room, as the host's message store holds them. */
let roomMessages: Memory[] = [];

const gate = () =>
  ({
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("no guest grants");
    },
    requireGoogleCalendarGrant: async () => {
      throw new Error("no Google grant");
    },
    requireGoogleCalendarWriteGrant: async () => {
      throw new Error("no Google grant");
    },
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  }) as never;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await new RuntimeMigrator(db).migrate(
    "@elizaos/plugin-calendar",
    calendarSchema,
  );
  runtime = {
    agentId: "00000000-0000-4000-8000-000000000101",
    adapter: { db },
    db,
    initPromise: Promise.resolve(),
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    getMemories: async (params: {
      roomId?: string;
      tableName: string;
      start?: number;
    }) =>
      params.tableName === "messages"
        ? roomMessages.filter(
            (memory) =>
              memory.roomId === params.roomId &&
              (params.start === undefined ||
                (memory.createdAt ?? 0) >= params.start),
          )
        : [],
    getSetting: () => undefined,
    getService: (type: string) =>
      type === CalendarService.serviceType ? service : null,
    reportError: async () => {},
  } as unknown as IAgentRuntime;
  service = new CalendarService(runtime);
  service.setGate(gate());
  __testing.setNativeCalendarBridgeForTest(null);
}, 60_000);

beforeEach(async () => {
  await pg.query("DELETE FROM app_calendar.life_calendar_events");
  await pg.query("DELETE FROM app_calendar.life_calendar_sync_states");
  cache.clear();
  roomMessages = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  __testing.setNativeCalendarBridgeForTest(undefined as never);
  await pg.close();
});

let sequence = 0;
/** One owner turn: the message is stored in the room, then the action runs. */
async function send(
  text: string,
  parameters: Record<string, unknown>,
  extracted: Record<string, unknown> = {},
  delivery?: { renderedText: string; id?: string },
) {
  sequence += 1;
  const id =
    delivery?.id ??
    `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  const message = {
    id,
    agentId: runtime.agentId,
    entityId: OWNER,
    roomId: ROOM,
    createdAt: Date.now(),
    content: {
      text,
      source: "client_chat",
      metadata: {
        uiView: "contacts",
        uiViewPath: "/contacts",
        uiTimeZone: ZONE,
      },
    },
  } as Memory;
  roomMessages.push(message);
  const routed =
    delivery === undefined
      ? message
      : {
          ...message,
          content: { ...message.content, text: delivery.renderedText },
        };
  if (routed !== message) bindIncomingMessagePersistence(routed, message);
  const result = await createCalendarActionRunner({
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async ({ actionType }: { actionType: string }) =>
      actionType === "lifeops.calendar.extract_update_event"
        ? { rawResponse: JSON.stringify(extracted), parsed: extracted }
        : null,
    ),
    recentConversationTexts: vi.fn(async () => []),
  } as never).handler(runtime, routed, undefined, { parameters });
  vi.setSystemTime(new Date(Date.now() + 60_000));
  return result;
}

/** An agent reply stored in the room between owner turns. */
function agentReply(text: string) {
  sequence += 1;
  roomMessages.push({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    entityId: runtime.agentId,
    roomId: ROOM,
    createdAt: Date.now(),
    content: { text },
  } as Memory);
}

const seed = (
  title = "v613 check",
  // Today at 3pm in Los Angeles.
  startAt = "2026-11-20T23:00:00.000Z",
  endAt = "2026-11-21T00:00:00.000Z",
) =>
  service.createCalendarEvent(INTERNAL_URL, {
    grantId: ELIZA_CALENDAR_GRANT_ID,
    calendarId: ELIZA_CALENDAR_ID,
    title,
    startAt,
    endAt,
    timeZone: ZONE,
    idempotencyKey: `seed-${title}-${startAt}`,
  } as never);
const events = async () =>
  (
    await service.getCalendarFeed(INTERNAL_URL, {
      timeMin: "2026-11-01T00:00:00.000Z",
      timeMax: "2026-12-30T00:00:00.000Z",
    })
  ).events;
const UPDATE = {
  requiresInput: false,
  title: null,
  description: null,
  location: null,
  clearFields: [],
  endAt: null,
  allDayStartDate: null,
  allDayEndDate: null,
  addGuests: [],
  removeGuests: [],
  timeZone: null,
  recurrence: null,
  recurrenceScope: null,
};

describe("an update's destination day is not its target day", {
  timeout: 60_000,
}, () => {
  it.each([
    "move v613 check to tomorrow at 10am",
    "reschedule v613 check for tomorrow at 10am",
    "push v613 check until tomorrow at 10am",
    "push v613 check till tomorrow at 10am",
    "move v613 check tomorrow at 10am",
    "reschedule v613 check tomorrow at 10am",
  ])("%s moves today's event to tomorrow at 10am", async (text) => {
    await seed();
    const result = await send(
      text,
      {
        subaction: "update_event",
        query: "v613 check",
        details: { timeZone: ZONE },
      },
      { ...UPDATE, startAt: "2026-11-21T10:00:00" },
    );
    expect(result?.success, JSON.stringify(result?.text)).toBe(true);
    const [event] = await events();
    // 10am PST.
    expect(event?.startAt).toBe("2026-11-21T18:00:00.000Z");
  });

  const today = {
    id: "e1",
    externalId: "x1",
    title: "v613 check",
    startAt: "2026-11-20T23:00:00.000Z",
    endAt: "2026-11-21T00:00:00.000Z",
    isAllDay: false,
    metadata: {},
    attendees: [],
  } as never;
  const tomorrow = {
    ...(today as object),
    id: "e2",
    externalId: "x2",
    startAt: "2026-11-21T23:00:00.000Z",
    endAt: "2026-11-22T00:00:00.000Z",
  } as never;
  const candidates = (text: string, list = [today]) =>
    resolveCalendarMutationCandidates({
      action: "update",
      events: list,
      titleHint: "v613 check",
      texts: [text],
      timeZone: ZONE,
    }).map((event) => event.externalId);

  it("still lets a stated source day pick the event", () => {
    // Source markers keep their meaning.
    expect(
      candidates("move v613 check on tomorrow to 5pm", [today, tomorrow]),
    ).toEqual(["x2"]);
    expect(
      candidates("move tomorrow's v613 check to 5pm", [today, tomorrow]),
    ).toEqual(["x2"]);
    expect(
      candidates("move v613 check from tomorrow to monday", [today, tomorrow]),
    ).toEqual(["x2"]);
    // A source day the only event does not fall on is still not found.
    expect(candidates("move v613 check on tomorrow to 5pm")).toEqual([]);
    expect(candidates("move tomorrow's v613 check to 5pm")).toEqual([]);
  });

  it("never moves a different day's event by a destination day", () => {
    // Several matches: a bare day names the event on it, as before.
    expect(
      candidates("move v613 check tomorrow at 10am", [today, tomorrow]),
    ).toEqual(["x2"]);
    // A destination day never chooses, so the handler asks which one.
    expect(
      candidates("reschedule v613 check for tomorrow at 10am", [
        today,
        tomorrow,
      ]).sort(),
    ).toEqual(["x1", "x2"].sort());
  });

  it("keeps a delete's stated day strict", () => {
    expect(
      resolveCalendarMutationCandidates({
        action: "delete",
        events: [today],
        titleHint: "v613 check",
        texts: ["cancel v613 check tomorrow"],
        timeZone: ZONE,
      }),
    ).toEqual([]);
  });
});

describe("a declined delete question stays declined", {
  timeout: 60_000,
}, () => {
  const confirm = (eventId: string) => ({
    subaction: "delete_event",
    targetKind: "eventId",
    target: eventId,
    details: { timeZone: ZONE, confirmed: true },
  });
  const ask = async () => {
    const event = await seed("v613 check review");
    const asked = await send("delete the calendar event v613 check", {
      subaction: "delete_event",
      query: "v613 check",
      details: { timeZone: ZONE },
    });
    expect(asked?.data).toMatchObject({ missing: ["delete confirmation"] });
    agentReply("Delete “v613 check review” today at 3pm?");
    return event;
  };

  it("a planner yes on the owner's no deletes nothing", async () => {
    const event = await ask();
    const declined = await send(
      "no, keep it. what is the weather tomorrow?",
      confirm(event.externalId),
    );
    expect(declined?.success).toBe(false);
    expect(await events()).toHaveLength(1);
    // The question is spent: a later yes needs a new question.
    const later = await send("yes, delete it", confirm(event.externalId));
    expect(later?.success).toBe(false);
    expect(await events()).toHaveLength(1);
  });

  it("a yes after another owner turn is not the answer to the question", async () => {
    const event = await ask();
    await send("what's on tomorrow?", { subaction: "list_events" });
    agentReply("Nothing tomorrow.");
    const later = await send("yes", confirm(event.externalId));
    expect(later?.success).toBe(false);
    expect(await events()).toHaveLength(1);
  });

  it("uses the bound owner answer when a delete is planned again by title", async () => {
    await ask();
    const delivery = {
      renderedText: "The current view is Calendar.",
      id: crypto.randomUUID(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const declined = await send(
        "No, keep v613 check review.",
        {
          subaction: "delete_event",
          query: "v613 check review",
          details: { timeZone: ZONE },
        },
        {},
        delivery,
      );
      expect(declined?.data).toMatchObject({ declined: true });
      expect(await events()).toHaveLength(1);
    }
  });

  it("a yes that is not about the question deletes nothing", async () => {
    const event = await ask();
    const unrelated = await send(
      "what is the weather tomorrow?",
      confirm(event.externalId),
    );
    expect(unrelated?.success).toBe(false);
    expect(await events()).toHaveLength(1);
  });

  it.each([
    "yes",
    "Yes, delete it.",
    "yep go ahead",
    "delete v613 check review",
  ])("the owner's next answer %s deletes the event", async (answer) => {
    const event = await ask();
    const confirmed = await send(answer, confirm(event.externalId));
    expect(confirmed?.success, JSON.stringify(confirmed?.text)).toBe(true);
    expect(await events()).toHaveLength(0);
  });

  it("uses the bound affirmative answer when Calendar renders context around the turn", async () => {
    const event = await ask();
    const confirmed = await send(
      "Yes.",
      confirm(event.externalId),
      {},
      { renderedText: "The current view is Calendar." },
    );
    expect(confirmed?.success).toBe(true);
    expect(await events()).toHaveLength(0);
  });
});

describe("adversarial review: a bare day only moves the event when the owner said it after the title", {
  timeout: 60_000,
}, () => {
  it("a promoted source-scoped target's day still names the event", async () => {
    await seed();
    const result = await send(
      "move it to 10am",
      {
        subaction: "update_event",
        targetKind: "query",
        target: "v613 check tomorrow",
        details: { timeZone: ZONE },
      },
      { ...UPDATE, startAt: "2026-11-21T10:00:00" },
    );
    expect(result?.success, JSON.stringify(result?.text)).not.toBe(true);
    const [event] = await events();
    expect(event?.startAt).toBe("2026-11-20T23:00:00.000Z");
  });

  it("a day said before the title describes the event, not its destination", async () => {
    await seed("standup");
    const result = await send(
      "push the monday standup back an hour",
      {
        subaction: "update_event",
        query: "standup",
        details: { timeZone: ZONE },
      },
      { ...UPDATE, startAt: "2026-11-20T16:00:00" },
    );
    expect(result?.success, JSON.stringify(result?.text)).not.toBe(true);
    const [event] = await events();
    expect(event?.startAt).toBe("2026-11-20T23:00:00.000Z");
  });

  const sync = (id: string, startAt: string) =>
    ({
      id,
      externalId: id,
      title: "sync",
      startAt,
      endAt: startAt,
      isAllDay: false,
      metadata: {},
      attendees: [],
    }) as never;
  it("'for' before a word that only starts like a weekday or month keeps the source day", () => {
    const list = [
      sync("today", "2026-11-20T23:00:00.000Z"),
      sync("tomorrow", "2026-11-21T23:00:00.000Z"),
    ];
    for (const text of [
      "reschedule the sync for marketing tomorrow at 10am",
      "move the sync for monica tomorrow at 10am",
      "move the sync for sunita tomorrow at 10am",
      "move the sync for this project tomorrow at 10am",
    ])
      expect(
        resolveCalendarMutationCandidates({
          action: "update",
          events: list,
          titleHint: "sync",
          texts: [text],
          timeZone: ZONE,
        }).map((event) => event.externalId),
        text,
      ).toEqual(["tomorrow"]);
  });
});

describe("adversarial review: only an answer to the question confirms a delete", {
  timeout: 60_000,
}, () => {
  const confirm = (eventId: string) => ({
    subaction: "delete_event",
    targetKind: "eventId",
    target: eventId,
    details: { timeZone: ZONE, confirmed: true },
  });
  it.each(["ok, what's on tomorrow?", "sure, but what time is it now?"])(
    "%s deletes nothing",
    async (answer) => {
      const event = await seed("v613 check review");
      await send("delete the calendar event v613 check", {
        subaction: "delete_event",
        query: "v613 check",
        details: { timeZone: ZONE },
      });
      agentReply("Delete “v613 check review” today at 3pm?");
      const result = await send(answer, confirm(event.externalId));
      expect(result?.success).toBe(false);
      expect(await events()).toHaveLength(1);
    },
  );
});
