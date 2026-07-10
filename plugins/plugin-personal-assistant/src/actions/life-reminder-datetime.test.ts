/**
 * Reminder datetime + snooze-duration pipeline tests (#10721 #10723).
 *
 * Guards the four P0 fixes:
 *  1. one-off reminders resolve their extracted date/weekday/offset against
 *     the owner timezone instead of fabricating dueAt=now;
 *  2. an unresolvable (or absent) time expression yields NO cadence so the
 *     handler asks "when?" instead of scheduling an immediate fire;
 *  3. rescheduling a one-off actually moves the stored dueAt (and reports
 *     honestly when nothing changed);
 *  4. LLM-extracted snooze minutes/presets and top-level `minutes` params
 *     reach the snooze handler instead of being discarded.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "../lifeops/owner/fact-store.js";
import { getZonedDateParts } from "../lifeops/time.js";
import type { ExtractedTaskParams } from "./lib/extract-task-plan.js";
import {
  buildCadenceFromLlmParams,
  buildCadenceFromUpdateFields,
  resolveDefinitionFromIntent,
  resolveOnceDueAt,
  runLifeConnectedQuery,
  runLifeOperationHandler,
} from "./life.js";

const serviceState = vi.hoisted(() => ({
  snoozeCalls: [] as Array<{
    id: string;
    request: { preset?: string; minutes?: number };
  }>,
  createCalls: [] as Array<Record<string, unknown>>,
  goalCreateCalls: [] as Array<Record<string, unknown>>,
  deleteDefinitionCalls: [] as string[],
  deleteGoalCalls: [] as string[],
}));

vi.mock("../lifeops/service.js", () => {
  class LifeOpsServiceError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  class LifeOpsService {
    async getOverview() {
      return {
        owner: {
          summary: "1 item",
          occurrences: [
            {
              id: "occ-1",
              title: "workout",
              state: "visible",
              domain: "user_lifeops",
              dueAt: null,
              windowName: null,
            },
          ],
          goals: [],
        },
        agentOps: { occurrences: [], goals: [] },
      };
    }
    async snoozeOccurrence(
      id: string,
      request: { preset?: string; minutes?: number },
    ) {
      serviceState.snoozeCalls.push({ id, request });
      return { id, title: "workout" };
    }
    async createDefinition(request: Record<string, unknown>) {
      serviceState.createCalls.push(request);
      return {
        definition: { title: request.title, cadence: request.cadence },
      };
    }
    async createGoal(request: Record<string, unknown>) {
      serviceState.goalCreateCalls.push(request);
      return {
        goal: {
          id: "goal-created",
          title: request.title,
          description: request.description,
          cadence: request.cadence ?? null,
          supportStrategy: request.supportStrategy ?? {},
          successCriteria: request.successCriteria ?? {},
          status: "active",
          reviewState: "idle",
          metadata: request.metadata ?? {},
        },
        links: [],
      };
    }
    async buildGoalExperienceLoop() {
      return {
        cadence: null,
        matches: [],
        summary: null,
      };
    }
    async listDefinitions() {
      return [
        {
          definition: {
            id: "def-1",
            title: "workout",
            domain: "user_lifeops",
          },
        },
      ];
    }
    async listGoals() {
      return [
        {
          goal: {
            id: "goal-1",
            title: "marathon",
            domain: "user_lifeops",
          },
        },
      ];
    }
    async deleteDefinition(id: string) {
      serviceState.deleteDefinitionCalls.push(id);
    }
    async deleteGoal(id: string) {
      serviceState.deleteGoalCalls.push(id);
    }
  }
  return { LifeOpsService, LifeOpsServiceError };
});

// Wednesday 2026-07-01 12:00 in America/Denver (MDT, UTC-6).
const NOW = new Date("2026-07-01T18:00:00Z");
const DENVER = "America/Denver";

function makeParams(
  overrides: Partial<ExtractedTaskParams>,
): ExtractedTaskParams {
  return {
    requestKind: null,
    title: null,
    description: null,
    cadenceKind: null,
    windows: null,
    weekdays: null,
    timeOfDay: null,
    timeZone: null,
    everyMinutes: null,
    timesPerDay: null,
    priority: null,
    durationMinutes: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
    ...overrides,
  };
}

describe("resolveOnceDueAt", () => {
  const base = {
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
    timeOfDayMinute: null,
    now: NOW,
    timeZone: DENVER,
  };

  it('resolves "friday at 5pm" to the upcoming Friday 17:00 owner-tz', () => {
    const dueAt = resolveOnceDueAt({
      ...base,
      dueWeekday: 5,
      timeOfDayMinute: 17 * 60,
    });
    expect(dueAt).toBe("2026-07-03T23:00:00.000Z");
  });

  it('resolves "in 2 hours" to now + 120 minutes', () => {
    const dueAt = resolveOnceDueAt({ ...base, dueInMinutes: 120 });
    expect(dueAt).toBe("2026-07-01T20:00:00.000Z");
  });

  it('resolves "tomorrow" without a clock time to 9:00 AM owner-tz', () => {
    const dueAt = resolveOnceDueAt({ ...base, dueInDays: 1 });
    expect(dueAt).toBe("2026-07-02T15:00:00.000Z");
  });

  it("resolves an absolute date across a DST boundary", () => {
    // Dec 24 in Denver is MST (UTC-7).
    const dueAt = resolveOnceDueAt({
      ...base,
      dueDate: "2026-12-24",
      timeOfDayMinute: 8 * 60,
    });
    expect(dueAt).toBe("2026-12-24T15:00:00.000Z");
  });

  it("uses today when the named weekday is today and the time is still ahead", () => {
    const dueAt = resolveOnceDueAt({
      ...base,
      dueWeekday: 3,
      timeOfDayMinute: 17 * 60,
    });
    expect(dueAt).toBe("2026-07-01T23:00:00.000Z");
  });

  it("rolls to next week when the named weekday's time already passed", () => {
    const dueAt = resolveOnceDueAt({
      ...base,
      dueWeekday: 3,
      timeOfDayMinute: 8 * 60,
    });
    expect(dueAt).toBe("2026-07-08T14:00:00.000Z");
  });

  it("keeps the today-or-tomorrow behavior for a bare clock time", () => {
    const dueAt = resolveOnceDueAt({ ...base, timeOfDayMinute: 20 * 60 });
    expect(dueAt).toBe("2026-07-02T02:00:00.000Z");
  });

  it("returns null when there is no time expression at all", () => {
    expect(resolveOnceDueAt(base)).toBeNull();
  });

  it("returns null for a named date already in the past", () => {
    expect(resolveOnceDueAt({ ...base, dueDate: "2026-04-17" })).toBeNull();
  });

  it('returns null for "today" at a time that already passed', () => {
    expect(
      resolveOnceDueAt({ ...base, dueInDays: 0, timeOfDayMinute: 8 * 60 }),
    ).toBeNull();
  });
});

describe("buildCadenceFromLlmParams (once)", () => {
  it("builds a dated once cadence from dueWeekday + timeOfDay", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({
        cadenceKind: "once",
        dueWeekday: 5,
        timeOfDay: "17:00",
      }),
      { now: NOW, timeZone: DENVER },
    );
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-03T23:00:00.000Z",
    });
  });

  it("never fabricates an immediate dueAt for a time-less once request", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "once" }),
      { now: NOW, timeZone: DENVER },
    );
    expect(built).toBeNull();
  });

  it("leaves recurring cadences untouched", () => {
    const built = buildCadenceFromLlmParams(
      makeParams({ cadenceKind: "daily", windows: ["morning"] }),
      { now: NOW, timeZone: DENVER },
    );
    expect(built?.cadence.kind).toBe("daily");
  });
});

describe("buildCadenceFromUpdateFields (once reschedule)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const currentWindowPolicy = { timezone: DENVER, windows: [] };
  const currentCadence = {
    kind: "once" as const,
    dueAt: "2026-07-01T19:00:00.000Z",
  };
  const emptyUpdate = {
    title: null,
    cadenceKind: null,
    windows: null,
    weekdays: null,
    timeOfDay: null,
    everyMinutes: null,
    priority: null,
    description: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
  };

  it("moves the dueAt when a new time is extracted", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, timeOfDay: "18:00" },
    });
    // 18:00 MDT on the (fake) current day = 2026-07-02T00:00:00Z.
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-02T00:00:00.000Z",
    });
    expect(
      built && built.cadence.kind === "once" ? built.cadence.dueAt : null,
    ).not.toBe(currentCadence.dueAt);
  });

  it("returns null (no silent no-op) when nothing reschedulable was extracted", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: emptyUpdate,
    });
    expect(built).toBeNull();
  });

  // Date-level moves ("push it to Friday / tomorrow / april 17") must resolve
  // the DATE, not just the time: the update extractor carries due* fields so
  // the date advances instead of silently staying put.
  it("moves the dueAt to a named weekday + time", () => {
    // NOW is Wed 2026-07-01 (Denver). "Friday at 3pm" => Fri 2026-07-03 15:00 MDT.
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueWeekday: 5, timeOfDay: "15:00" },
    });
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-03T21:00:00.000Z",
    });
  });

  it("moves the dueAt by relative days (tomorrow), keeping the extracted time", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueInDays: 1, timeOfDay: "09:30" },
    });
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-02T15:30:00.000Z",
    });
  });

  it("moves the dueAt to an explicit calendar date", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueDate: "2026-07-10", timeOfDay: "12:00" },
    });
    expect(built?.cadence).toEqual({
      kind: "once",
      dueAt: "2026-07-10T18:00:00.000Z",
    });
  });

  it("an offset move (in 2 hours) resolves from now", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueInMinutes: 120 },
    });
    expect(built?.cadence.kind).toBe("once");
    const dueAt =
      built && built.cadence.kind === "once" ? built.cadence.dueAt : "";
    expect(new Date(dueAt).getTime() - NOW.getTime()).toBe(120 * 60_000);
  });

  it("a past calendar date is rejected (null), never a bogus dueAt", () => {
    const built = buildCadenceFromUpdateFields({
      currentCadence,
      currentWindowPolicy,
      timeZone: DENVER,
      update: { ...emptyUpdate, dueDate: "2026-06-01", timeOfDay: "12:00" },
    });
    expect(built).toBeNull();
  });
});

// ── Handler-level flows ───────────────────────────────

function makeRuntime(respond: (prompt: string) => string): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    getRoom: vi.fn(async () => null),
    useModel: vi.fn(async (_modelType: unknown, args: { prompt: string }) =>
      respond(args.prompt),
    ),
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
  } as unknown as Memory;
}

function externalSourceMessageText(text: string): string {
  return [
    "SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source.",
    "",
    "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
    "Source: API",
    "---",
    text,
    "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
  ].join("\n");
}

function taskPlanJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    mode: "create",
    response: null,
    requestKind: null,
    title: null,
    description: null,
    cadenceKind: null,
    windows: null,
    weekdays: null,
    timeOfDay: null,
    timeZone: null,
    everyMinutes: null,
    timesPerDay: null,
    priority: null,
    durationMinutes: null,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
    dueInMinutes: null,
    ...overrides,
  });
}

describe("runLifeOperationHandler clarification contract", () => {
  it("marks a reminder-plan response as user-facing and awaiting owner input", async () => {
    const clarification =
      "Please tell me the report name, date, and time before I create the reminder.";
    const runtime = makeRuntime((prompt) => {
      if (
        prompt.includes(
          "Plan the next step for a LifeOps create_definition request.",
        )
      ) {
        return taskPlanJson({
          mode: "respond",
          response: clarification,
        });
      }
      return clarification;
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "I need a reminder for an upcoming report deadline, but I still need to provide its name, date, and time.",
      ),
      undefined,
      {
        parameters: {
          action: "create",
          intent:
            "Create a reminder after asking me for its report name, date, and time.",
          ownerSurface: "OWNER_REMINDERS",
        },
      } as HandlerOptions,
    );

    expect(result).toMatchObject({
      success: true,
      text: clarification,
      userFacingText: clarification,
      values: {
        success: true,
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: "create",
      },
      data: {
        actionName: "OWNER_REMINDERS",
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: "create",
      },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });

  it("marks a missing reminder schedule as user-facing and awaiting owner input", async () => {
    const clarification = "What day and time should I use?";
    const runtime = makeRuntime((prompt) => {
      if (
        prompt.includes(
          "Plan the next step for a LifeOps create_definition request.",
        )
      ) {
        return taskPlanJson({
          mode: "respond",
          response: clarification,
          title: "Report deadline",
        });
      }
      return clarification;
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("Remind me about my report deadline."),
      undefined,
      {
        parameters: {
          action: "create",
          intent: "Create a report deadline reminder.",
          title: "Report deadline",
          ownerSurface: "OWNER_REMINDERS",
        },
      } as HandlerOptions,
    );

    expect(result).toMatchObject({
      success: false,
      text: "When should it happen?",
      userFacingText: "When should it happen?",
      values: {
        success: false,
        error: "MISSING_DEFINITION_FIELD",
        missingField: "schedule",
        requiresConfirmation: true,
        awaitingUserInput: true,
      },
      data: {
        actionName: "OWNER_REMINDERS",
        missingField: "schedule",
        requiresConfirmation: true,
        awaitingUserInput: true,
      },
    });
    expect(serviceState.createCalls).toHaveLength(0);
  });
});

describe("runLifeConnectedQuery capability boundaries", () => {
  const service = (
    overrides: Record<string, unknown>,
  ): Parameters<typeof runLifeConnectedQuery>[0]["service"] =>
    ({
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: false,
        grantedCapabilities: [],
      })),
      listCalendars: vi.fn(async () => []),
      ...overrides,
    }) as unknown as Parameters<typeof runLifeConnectedQuery>[0]["service"];

  const query = async (
    queryOperation: Parameters<
      typeof runLifeConnectedQuery
    >[0]["queryOperation"],
    serviceOverrides: Record<string, unknown>,
  ) =>
    runLifeConnectedQuery({
      runtime: makeRuntime(() => ""),
      message: makeMessage("show me the connected data"),
      state: undefined,
      intent: "show me the connected data",
      service: service(serviceOverrides),
      queryOperation,
      actionName: "OWNER_LIFE",
    });

  it("reports Gmail unavailable without calling the triage endpoint", async () => {
    const getGmailTriage = vi.fn();
    const result = await query("query_email", { getGmailTriage });

    expect(result.success).toBe(false);
    expect(result.text).toContain("Gmail is not connected");
    expect(getGmailTriage).not.toHaveBeenCalled();
  });

  it("returns the designed empty Gmail state when triage access is granted", async () => {
    const result = await query("query_email", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.gmail.triage"],
      })),
      getGmailTriage: vi.fn(async () => ({
        messages: [],
        source: "synced",
        syncedAt: "2026-07-10T00:00:00.000Z",
        summary: {
          unreadCount: 0,
          importantNewCount: 0,
          likelyReplyNeededCount: 0,
        },
      })),
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("No important emails right now.");
  });

  it("uses an Apple calendar grant when Google calendar access is absent", async () => {
    const result = await query("query_calendar_next", {
      listCalendars: vi.fn(async () => [{ id: "apple-calendar" }]),
      getNextCalendarEventContext: vi.fn(async () => ({
        event: null,
        startsAt: null,
        startsInMinutes: null,
        location: null,
        attendeeNames: [],
      })),
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("No upcoming events on your calendar.");
  });

  it("reports calendar unavailable when neither connector grants read access", async () => {
    const result = await query("query_calendar_today", {});

    expect(result.success).toBe(false);
    expect(result.text).toContain("Google Calendar is not connected");
    expect(result.data).toEqual({
      actionName: "OWNER_LIFE",
      operation: "query_calendar_today",
    });
  });

  it("returns the designed empty state for an accessible clear calendar", async () => {
    const getCalendarFeed = vi.fn(async () => ({ events: [] }));
    const result = await query("query_calendar_today", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      })),
      getCalendarFeed,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("Your calendar is clear today.");
    expect(getCalendarFeed).toHaveBeenCalledOnce();
  });

  it("summarizes populated accessible calendar feeds", async () => {
    const result = await query("query_calendar_today", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      })),
      getCalendarFeed: vi.fn(async () => ({
        events: [
          {
            title: "Report review",
            startAt: "2026-07-10T15:00:00.000Z",
            timezone: "UTC",
          },
        ],
      })),
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("You have 1 event today:");
    expect(result.text).toContain("Report review");
  });

  it("translates a connected-service rate limit at the action boundary", async () => {
    const { LifeOpsServiceError } = await import("../lifeops/service.js");
    const result = await query("query_calendar_today", {
      getGoogleConnectorStatus: vi.fn(async () => ({
        connected: true,
        grantedCapabilities: ["google.calendar.read"],
      })),
      getCalendarFeed: vi.fn(async () => {
        throw new LifeOpsServiceError("rate limit", 429);
      }),
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe(
      "LifeOps is rate-limited right now. Try again in a bit.",
    );
    expect(result.data).toEqual({
      actionName: "OWNER_LIFE",
      operation: "query_calendar_today",
    });
  });
});

describe("resolveDefinitionFromIntent", () => {
  it("resolves a uniquely named definition from natural-language intent", async () => {
    const service = {
      listDefinitions: vi.fn(async () => [
        {
          definition: {
            id: "def-1",
            title: "workout",
            domain: "user_lifeops",
          },
        },
      ]),
    } as unknown as Parameters<typeof resolveDefinitionFromIntent>[0];
    const result = await resolveDefinitionFromIntent(
      service,
      undefined,
      "Please update my workout routine",
      "user_lifeops",
    );

    expect(result?.definition.id).toBe("def-1");
  });
});

describe("runLifeOperationHandler snooze durations", () => {
  beforeEach(() => {
    serviceState.snoozeCalls.length = 0;
    serviceState.createCalls.length = 0;
    serviceState.goalCreateCalls.length = 0;
    serviceState.deleteDefinitionCalls.length = 0;
    serviceState.deleteGoalCalls.length = 0;
  });

  it("threads LLM-extracted snooze minutes through to the service", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Pick the correct action value")) {
        return JSON.stringify({
          action: "snooze",
          params: { target: "workout", minutes: 45 },
          missing: [],
          confidence: 0.9,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("snooze workout for 45 minutes"),
      undefined,
      { parameters: {} } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.snoozeCalls).toHaveLength(1);
    expect(serviceState.snoozeCalls[0]?.id).toBe("occ-1");
    expect(serviceState.snoozeCalls[0]?.request.minutes).toBe(45);
  });

  it('threads a "tomorrow morning" preset through to the service', async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Pick the correct action value")) {
        return JSON.stringify({
          action: "snooze",
          params: { target: "workout", preset: "tomorrow_morning" },
          missing: [],
          confidence: 0.9,
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("snooze workout until tomorrow morning"),
      undefined,
      { parameters: {} } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.snoozeCalls).toHaveLength(1);
    expect(serviceState.snoozeCalls[0]?.request.preset).toBe(
      "tomorrow_morning",
    );
    expect(serviceState.snoozeCalls[0]?.request.minutes).toBeUndefined();
  });

  it("honors a planner-supplied top-level minutes param", async () => {
    const runtime = makeRuntime(() => "");
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("snooze workout for 45 minutes"),
      undefined,
      {
        parameters: { subaction: "snooze", target: "workout", minutes: 45 },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.snoozeCalls).toHaveLength(1);
    expect(serviceState.snoozeCalls[0]?.request.minutes).toBe(45);
  });

  it("blocks broad emotional delete-everything requests before any destructive call", async () => {
    const runtime = makeRuntime(() => "");
    const intent =
      "you know what? just delete everything. all my reminders, all my tasks, all of it. i give up.";
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "delete",
          intent,
          target: "everything",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      noop: true,
      blockedReason: "broad_destructive_delete",
    });
    expect(serviceState.deleteDefinitionCalls).toHaveLength(0);
    expect(serviceState.deleteGoalCalls).toHaveLength(0);
    expect(result.text).toContain("won't delete everything");
  });

  it("preserves concrete goal deadline details in the confirmation preview", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Conversational Spanish",
          description:
            "Practice conversational Spanish until a cafe-style conversation is possible.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Hold a 10-minute cafe-style conversation without switching to English by the deadline.",
            metric: "Spanish-only conversation duration",
            evidenceSignals: ["manual_checkin"],
          },
          supportStrategy: {
            summary: "Use four weekly practice blocks.",
            firstStep: "Schedule the first 20-minute practice block.",
            suggestedSupport: ["weekly check-in"],
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.9,
          evaluationSummary:
            "Progress is measured by four weekly practice sessions and a 10-minute Spanish-only conversation by the deadline.",
          targetDomain: "learning",
        });
      }
      return "";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        externalSourceMessageText(
          "Let's define success as holding a 10-minute cafe-style conversation without switching to English by December 1, with four 20-minute practice blocks each week.",
        ),
      ),
      undefined,
      {
        parameters: {
          subaction: "create",
          kind: "goal",
          confirmed: false,
          title: "Conversational Spanish",
          intent: "Learn conversational Spanish",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("December 1");
    expect(result.text).toContain("four 20-minute practice blocks");
    expect(result.values).toMatchObject({
      saved: false,
      requiresConfirmation: true,
    });
    expect(serviceState.goalCreateCalls).toHaveLength(0);
  });

  it("reuses a cached goal draft when confirm state has no action results", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Stabilize sleep schedule",
          description:
            "Maintain a consistent weekday sleep window for the next month.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Be asleep by 11:30 PM and awake by 7:30 AM on weekdays, within a 45-minute margin.",
            metric: "weekday schedule adherence",
            evidenceSignals: ["health.sleep", "manual_checkin"],
          },
          supportStrategy: {
            summary: "Use a consistent wind-down and wake routine.",
            firstStep: "Start wind-down at 10:30 PM on weekdays.",
            suggestedSupport: ["weekly sleep check-in"],
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.95,
          evaluationSummary:
            "Progress is measured by weekday sleep and wake adherence.",
          targetDomain: "sleep",
        });
      }
      return "";
    });

    const preview = await runLifeOperationHandler(
      runtime,
      makeMessage(
        externalSourceMessageText(
          "I want that to mean being asleep by 11:30 pm and awake around 7:30 am on weekdays, within 45 minutes, for the next month.",
        ),
      ),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "goal",
          confirmed: false,
          title: "Stabilize sleep schedule",
          intent:
            "Stabilize sleep schedule with target bedtime 11:30pm and wake time 7:30am on weekdays, within 45 minutes, for the next month",
        },
      } as HandlerOptions,
    );
    expect(preview.success).toBe(false);
    expect(preview.values).toMatchObject({
      saved: false,
      requiresConfirmation: true,
    });

    const confirm = await runLifeOperationHandler(
      runtime,
      makeMessage(externalSourceMessageText("Yes, save that goal.")),
      undefined,
      {
        parameters: {
          action: "create",
          kind: "goal",
          title: "Stabilize sleep schedule",
          intent: "Stabilize sleep schedule",
        },
      } as HandlerOptions,
    );

    expect(confirm.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      title: "Stabilize sleep schedule",
      successCriteria: {
        metric: "weekday schedule adherence",
      },
      supportStrategy: {
        firstStep: "Start wind-down at 10:30 PM on weekdays.",
      },
    });
  });

  it("reuses a previewed goal draft when the confirmation turn is misrouted to routines", async () => {
    const runtime = makeRuntime(() => {
      throw new Error(
        "explicit draft confirmations should not need LLM reuse classification",
      );
    });
    const deferredGoalDraft = {
      intent:
        "Count it if I walk around the block after lunch three times a week for the next six weeks.",
      operation: "create_goal",
      createdAt: Date.now(),
      request: {
        title: "Walk around the block",
        description:
          "Walk around the block after lunch three times a week for six weeks.",
        successCriteria: {
          metric: "weekly post-lunch walks",
          summary: "Complete three post-lunch walks around the block per week.",
        },
        supportStrategy: {
          firstStep: "Pick the next lunch where a short walk is possible.",
          summary: "Keep the walk small and low-pressure.",
        },
        metadata: {
          goalGrounding: { groundingState: "grounded" },
          source: "chat",
        },
      },
    };
    const state = {
      data: {
        actionResults: [
          {
            success: false,
            data: { lifeDraft: deferredGoalDraft },
          },
        ],
      },
    } as unknown as State;

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(externalSourceMessageText("ok save that one")),
      state,
      {
        parameters: {
          action: "create",
          kind: "definition",
          intent:
            "Walk around the block after lunch three times a week for the next six weeks",
          title: "Walk around the block after lunch",
          confirmed: false,
          details: {
            frequency: "3 times per week",
            durationWeeks: 6,
            timeOfDay: "after lunch",
          },
          ownerSurface: "OWNER_ROUTINES",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      title: "Walk around the block",
      description:
        "Walk around the block after lunch three times a week for six weeks.",
      successCriteria: {
        metric: "weekly post-lunch walks",
      },
      supportStrategy: {
        firstStep: "Pick the next lunch where a short walk is possible.",
      },
    });
  });

  it("keeps goal-tracking follow-up details on the goal path even when planner selects routines", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Walk around the block after lunch",
          description:
            "Leave the apartment by walking around the block after lunch three times a week.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Walk around the block after lunch at least 3 times per week for 6 weeks.",
            metric: "weekly post-lunch walks",
            evidenceSignals: ["manual_checkin"],
          },
          supportStrategy: {
            summary: "Use a low-pressure after-lunch walking routine.",
            firstStep: "Pick the next lunch where a short walk is possible.",
            suggestedSupport: ["weekly check-in"],
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.9,
          evaluationSummary:
            "Progress is three post-lunch block walks per week for six weeks.",
          targetDomain: "health",
        });
      }
      return "";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "Count it if I walk around the block after lunch three times a week for the next six weeks. Even if it is slow.",
      ),
      undefined,
      {
        parameters: {
          ownerSurface: "OWNER_ROUTINES",
          action: "create",
          kind: "definition",
          confirmed: true,
          title: "Block Walks",
          intent:
            "walk around the block after lunch three times a week for the next six weeks, counting each walk even if slow",
          details: {
            frequency: "3/week",
            durationWeeks: 6,
            timeOfDay: "after lunch",
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.createCalls).toHaveLength(0);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
      lifeDraft: {
        operation: "create_goal",
        request: {
          title: "Block Walks",
          successCriteria: {
            metric: "weekly post-lunch walks",
          },
          supportStrategy: {
            firstStep: "Pick the next lunch where a short walk is possible.",
          },
        },
      },
    });
  });

  it("grounds a confirmed titled goal before saving", async () => {
    const intent =
      "ok save this goal: leave the apartment more; count it if I walk around the block after lunch three times a week for the next six weeks, and slow counts.";
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("Ground the user's goal")) {
        return JSON.stringify({
          mode: "create",
          response: null,
          title: "Leave the apartment more",
          description:
            "Build a low-pressure habit of leaving the apartment for a short walk after lunch.",
          cadence: { kind: "weekly", reviewWindowDays: 7 },
          successCriteria: {
            summary:
              "Walk around the block after lunch three times per week for six weeks.",
            metric: "post_lunch_block_walks",
            target: { walksPerWeek: 3, weeks: 6 },
            evidenceSignals: ["manual_checkin"],
          },
          supportStrategy: {
            summary: "Keep the goal small and count slow walks.",
            firstStep: "Take one slow walk around the block after lunch.",
          },
          groundingState: "grounded",
          missingCriticalFields: [],
          confidence: 0.88,
          evaluationSummary:
            "Progress means three after-lunch walks around the block each week for six weeks.",
          targetDomain: "movement",
        });
      }
      return "";
    });

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Leave the apartment more",
          confirmed: true,
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      title: "Leave the apartment more",
      description:
        "Build a low-pressure habit of leaving the apartment for a short walk after lunch.",
      successCriteria: {
        metric: "post_lunch_block_walks",
      },
      supportStrategy: {
        summary: "Keep the goal small and count slow walks.",
      },
      metadata: {
        source: "chat",
        originalIntent: intent,
        goalGrounding: {
          groundingState: "grounded",
          missingCriticalFields: [],
        },
      },
    });
  });

  it("marks planner-supplied grounded goal details as grounded metadata", async () => {
    const intent = "ok save that one";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Leave the apartment more",
          confirmed: true,
          details: {
            description:
              "Feel less stuck at home by getting outside more often.",
            successCriteria: {
              summary:
                "Walk around the block after lunch at least 3 times per week for 6 weeks.",
            },
            supportStrategy: {
              summary: "Anchor the walk to lunch and count slow walks.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      metadata: {
        source: "chat",
        originalIntent: intent,
        goalGrounding: {
          groundingState: "grounded",
          missingCriticalFields: [],
          summary:
            "Walk around the block after lunch at least 3 times per week for 6 weeks.",
        },
      },
    });
  });

  it("asks for concrete success criteria before previewing a vague goal save", async () => {
    const intent = "I want to leave the apartment more";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Leave the apartment more",
          confirmed: false,
          details: {
            description: "Feel less stuck by getting outside more often.",
            successCriteria: {
              summary:
                "A meaningful increase in days per week leaving the apartment for any reason, measured by feeling less stuck instead of step counts.",
            },
            supportStrategy: {
              summary: "Keep it low-pressure and non-fitness.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.userFacingText ?? result.text).toContain(
      "What would count as success",
    );
    expect(result.userFacingText ?? result.text).toContain("how often");
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it("asks instead of previewing planner-invented first-turn goal criteria", async () => {
    const intent = "I want a goal called Run a 5K by fall.";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Run a 5K by fall",
          confirmed: false,
          details: {
            description: "Train and complete a 5K run by fall 2026.",
            successCriteria: {
              summary: "Complete a 5K run before the end of fall 2026.",
            },
            supportStrategy: {
              summary:
                "Build up running distance gradually with a progressive training plan.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.userFacingText ?? result.text).toContain(
      "What would count as success",
    );
  });

  it("previews grounded goal criteria when planner confirmation is premature", async () => {
    const intent =
      "Count it if I walk around the block after lunch three times a week for the next six weeks. Even if it is slow.";
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(intent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent,
          title: "Walk around the block after lunch 3x/week",
          confirmed: true,
          details: {
            description:
              "Leave the apartment more by walking around the block after lunch.",
            successCriteria: {
              summary:
                "Walk around the block after lunch 3 times per week for 6 weeks. Slow counts.",
            },
            supportStrategy: {
              summary: "Keep it low-pressure and count any pace after lunch.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(false);
    expect(serviceState.goalCreateCalls).toHaveLength(0);
    expect(result.userFacingText ?? result.text).toContain("Confirm");
    expect(result.data).toMatchObject({
      deferred: true,
      saved: false,
      requiresConfirmation: true,
    });
  });

  it("saves when explicit confirmation text is wrapped by an external-source notice", async () => {
    const wrappedIntent = `SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source.
<<<EXTERNAL_UNTRUSTED_CONTENT>>>
Source: API
---
Yes, save it.
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`;
    const runtime = makeRuntime(() => "");

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(wrappedIntent),
      undefined,
      {
        parameters: {
          action: "create_goal",
          intent: "save goal",
          title: "Save $2,000 for Lisbon trip by March 31",
          confirmed: true,
          details: {
            description: "Save $2,000 by March 31 for a Lisbon trip.",
            successCriteria: {
              summary: "$2,000 saved by March 31 for the Lisbon trip.",
            },
            supportStrategy: {
              summary: "Transfer $175 after each paycheck.",
            },
          },
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.goalCreateCalls).toHaveLength(1);
    expect(serviceState.goalCreateCalls[0]).toMatchObject({
      title: "Save $2,000 for Lisbon trip by March 31",
    });
    expect(result.userFacingText ?? result.text).toContain(
      "$2,000 saved by March 31",
    );
    expect(result.userFacingText ?? result.text).not.toContain(
      "What would count as success",
    );
  });
});

describe("runLifeOperationHandler one-off reminder scheduling", () => {
  beforeEach(() => {
    serviceState.snoozeCalls.length = 0;
    serviceState.createCalls.length = 0;
    serviceState.goalCreateCalls.length = 0;
  });

  it('schedules "remind me friday at 5pm" on Friday 17:00, not now', async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Call mom",
          cadenceKind: "once",
          dueWeekday: 5,
          timeOfDay: "17:00",
        });
      }
      return "";
    });
    const before = Date.now();
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("remind me friday at 5pm to call mom"),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "remind me friday at 5pm to call mom",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    const cadence = serviceState.createCalls[0]?.cadence as {
      kind: string;
      dueAt: string;
    };
    expect(cadence.kind).toBe("once");
    const dueAtMs = Date.parse(cadence.dueAt);
    expect(dueAtMs).toBeGreaterThan(before);
    const timeZone = resolveDefaultTimeZone();
    const parts = getZonedDateParts(new Date(cadence.dueAt), timeZone);
    const weekday = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day, 12),
    ).getUTCDay();
    expect(weekday).toBe(5);
    expect(parts.hour).toBe(17);
    expect(parts.minute).toBe(0);
  });

  it('anchors "remind me tomorrow at 9am" to the owner timezone fact, not the host clock (#13509)', async () => {
    // Regression for #13509: a conversational one-off create with no zone
    // stated out loud (planner returns timeZone:null) must resolve "9am"
    // against the owner's STORED timezone fact, not the host clock. Before the
    // fix, this stored 09:00 in the host zone (UTC on TZ=UTC / server
    // topologies) = 04:00 America/Chicago — "confidently wrong by five hours".
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        return taskPlanJson({
          requestKind: "reminder",
          title: "Call pharmacy about refill",
          cadenceKind: "once",
          dueInDays: 1,
          timeOfDay: "09:00",
          // No zone stated out loud: the planner leaves timeZone null. The
          // owner-fact fallback (#13509) must supply the zone.
          timeZone: null,
        });
      }
      return "";
    });
    // Seed the owner's stored timezone fact.
    registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
    await resolveOwnerFactStore(runtime).update(
      { timezone: "America/Chicago" },
      { source: "profile_save", recordedAt: "2026-07-04T00:00:00.000Z" },
    );

    const result = await runLifeOperationHandler(
      runtime,
      makeMessage(
        "remind me tomorrow at 9am to call the pharmacy about my refill",
      ),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent:
            "remind me tomorrow at 9am to call the pharmacy about my refill",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    const created = serviceState.createCalls[0] as {
      cadence: { kind: string; dueAt: string };
      timezone?: string;
    };
    expect(created.cadence.kind).toBe("once");
    // dueAt wall-clock is 09:00 in America/Chicago, NOT 09:00 host/UTC.
    const parts = getZonedDateParts(
      new Date(created.cadence.dueAt),
      "America/Chicago",
    );
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    // The persisted definition also carries the owner zone, not the host zone.
    expect(created.timezone).toBe("America/Chicago");
  });

  it("asks for clarification instead of scheduling when the time is unresolvable", async () => {
    const runtime = makeRuntime((prompt) => {
      if (prompt.includes("create_definition request")) {
        // Time expression present ("when the game starts") but unresolvable —
        // the extractor leaves every datetime field null.
        return taskPlanJson({
          requestKind: "reminder",
          title: "Call mom",
          cadenceKind: "once",
        });
      }
      return "";
    });
    const result = await runLifeOperationHandler(
      runtime,
      makeMessage("remind me to call mom when the game starts"),
      undefined,
      {
        parameters: {
          action: "create_reminder",
          intent: "remind me to call mom when the game starts",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(false);
    expect(
      (result.data as Record<string, unknown> | undefined)?.missingField,
    ).toBe("schedule");
    expect(serviceState.createCalls).toHaveLength(0);
  });
});
