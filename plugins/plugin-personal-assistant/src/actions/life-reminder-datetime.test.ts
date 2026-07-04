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
  resolveOnceDueAt,
  runLifeOperationHandler,
} from "./life.js";

const serviceState = vi.hoisted(() => ({
  snoozeCalls: [] as Array<{
    id: string;
    request: { preset?: string; minutes?: number };
  }>,
  createCalls: [] as Array<Record<string, unknown>>,
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

describe("runLifeOperationHandler snooze durations", () => {
  beforeEach(() => {
    serviceState.snoozeCalls.length = 0;
    serviceState.createCalls.length = 0;
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
});

describe("runLifeOperationHandler one-off reminder scheduling", () => {
  beforeEach(() => {
    serviceState.snoozeCalls.length = 0;
    serviceState.createCalls.length = 0;
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
