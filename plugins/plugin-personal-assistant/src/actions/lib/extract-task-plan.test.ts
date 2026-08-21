/**
 * Unit tests for the LifeOps task-create extraction schema.
 *
 * Covers the reminder-datetime pipeline fixes (#10721 #10723):
 *  - the schema carries structured datetime fields (dueDate/dueInDays/
 *    dueWeekday/dueInMinutes) so "remind me friday at 5pm" keeps its date;
 *  - the LLM requestKind classification is trusted as-is — no English-only
 *    keyword veto that broke multilingual requests;
 *  - the prompt grounds absolute dates against the current owner-tz datetime.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  extractTaskCreatePlanWithLlm,
  textExplicitlyLeavesScheduleUnspecified,
  textStatesExplicitSchedule,
} from "./extract-task-plan.js";

function makeRuntime(respond: (prompt: string) => string): IAgentRuntime {
  return {
    useModel: vi.fn(async (_modelType: unknown, args: { prompt: string }) =>
      respond(args.prompt),
    ),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

const BASE_PLAN_JSON = {
  mode: "create",
  response: null,
  requestKind: null,
  title: "Call mom",
  description: null,
  cadenceKind: "once",
  windows: null,
  weekdays: null,
  timeOfDay: null,
  timeZone: null,
  everyMinutes: null,
  timesPerDay: null,
  quotaTargetCount: null,
  quotaUnit: null,
  perOccurrenceWork: null,
  checkInRequested: null,
  checkInWindows: null,
  priority: null,
  durationMinutes: null,
  dueDate: null,
  dueInDays: null,
  dueWeekday: null,
  dueInMinutes: null,
};

describe("textExplicitlyLeavesScheduleUnspecified", () => {
  it.each([
    "Remind me to call Mom, but I have not said when.",
    "Remind me to call Mom. I haven't specified the time yet.",
    "Create the reminder without saying when.",
    "No date or time specified yet for this reminder.",
    "Don't guess a schedule. Ask me when.",
  ])("keeps an explicitly withheld schedule unresolved: %s", (text) => {
    expect(textExplicitlyLeavesScheduleUnspecified(text)).toBe(true);
  });

  it.each([
    "Remind me to call Mom tomorrow at 9.",
    "I hadn't said when before, but use Friday at noon.",
    "Don't guess a time; use next Monday.",
    "No time was specified in the draft. Make it every morning instead.",
    "Remind me to renew the registration by the 20th.",
  ])(
    "lets a later concrete schedule override earlier uncertainty: %s",
    (text) => {
      expect(textExplicitlyLeavesScheduleUnspecified(text)).toBe(false);
    },
  );
});

describe("textStatesExplicitSchedule", () => {
  it.each([
    "Use Friday.",
    "Make it tomorrow at 9.",
    "Use the 20th.",
    "Set it every morning.",
  ])("recognizes current-turn schedule authority: %s", (text) => {
    expect(textStatesExplicitSchedule(text)).toBe(true);
  });

  it.each(["Yes, save it now.", "Confirm that draft.", "Looks good."])(
    "does not treat save timing as the item's schedule: %s",
    (text) => {
      expect(textStatesExplicitSchedule(text)).toBe(false);
    },
  );
});

describe("extractTaskCreatePlanWithLlm datetime fields", () => {
  it("extracts the exact flexible-quota target, work unit, and check-in policy intent", async () => {
    const runtime = makeRuntime(() =>
      JSON.stringify({
        ...BASE_PLAN_JSON,
        title: "Pushups",
        cadenceKind: "count_per_day",
        timesPerDay: 3,
        quotaTargetCount: 3,
        quotaUnit: "set",
        perOccurrenceWork: "25 pushups",
        checkInRequested: true,
        checkInWindows: ["afternoon", "evening"],
      }),
    );
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent:
        "Track 25 pushups, three sets a day, whenever, and check in with me later.",
      state: undefined,
    });
    expect(plan).toMatchObject({
      cadenceKind: "count_per_day",
      quotaTargetCount: 3,
      quotaUnit: "set",
      perOccurrenceWork: "25 pushups",
      checkInRequested: true,
      checkInWindows: ["afternoon", "evening"],
    });
  });

  it("keeps dueWeekday and timeOfDay for a weekday reminder", async () => {
    const runtime = makeRuntime(() =>
      JSON.stringify({
        ...BASE_PLAN_JSON,
        requestKind: "reminder",
        dueWeekday: 5,
        timeOfDay: "17:00",
      }),
    );
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me friday at 5pm to call mom",
      state: undefined,
    });
    expect(plan.mode).toBe("create");
    expect(plan.cadenceKind).toBe("once");
    expect(plan.dueWeekday).toBe(5);
    expect(plan.timeOfDay).toBe("17:00");
    expect(plan.dueDate).toBeNull();
    expect(plan.dueInDays).toBeNull();
    expect(plan.dueInMinutes).toBeNull();
  });

  it("honors multiStep=true and treats anything else as a single-task ask", async () => {
    const multi = await extractTaskCreatePlanWithLlm({
      runtime: makeRuntime(() =>
        JSON.stringify({ ...BASE_PLAN_JSON, multiStep: true }),
      ),
      intent: "set reminders for outline, rough draft, and final proofread",
      state: undefined,
    });
    expect(multi.multiStep).toBe(true);

    const malformed = await extractTaskCreatePlanWithLlm({
      runtime: makeRuntime(() =>
        JSON.stringify({ ...BASE_PLAN_JSON, multiStep: "yes" }),
      ),
      intent: "remind me friday at 5pm to call mom",
      state: undefined,
    });
    // Strict true-only: a malformed flag degrades to the crisp single-ask
    // path, never to an extra confirmation round.
    expect(malformed.multiStep).toBe(false);
  });

  it("keeps dueDate, dueInDays and dueInMinutes when valid", async () => {
    const runtime = makeRuntime(() =>
      JSON.stringify({
        ...BASE_PLAN_JSON,
        dueDate: "2027-04-17",
        dueInDays: 0,
        dueInMinutes: 120,
      }),
    );
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me april 17 to hug my wife",
      state: undefined,
    });
    expect(plan.dueDate).toBe("2027-04-17");
    expect(plan.dueInDays).toBe(0);
    expect(plan.dueInMinutes).toBe(120);
  });

  it("nulls malformed datetime fields instead of passing them through", async () => {
    const runtime = makeRuntime(() =>
      JSON.stringify({
        ...BASE_PLAN_JSON,
        dueDate: "april 17",
        dueInDays: -1,
        dueWeekday: 9,
        dueInMinutes: -30,
      }),
    );
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me april 17 to hug my wife",
      state: undefined,
    });
    expect(plan.dueDate).toBeNull();
    expect(plan.dueInDays).toBeNull();
    expect(plan.dueWeekday).toBeNull();
    expect(plan.dueInMinutes).toBeNull();
  });

  it("grounds the prompt with the current date in the owner timezone", async () => {
    const prompts: string[] = [];
    const runtime = makeRuntime((prompt) => {
      prompts.push(prompt);
      return JSON.stringify(BASE_PLAN_JSON);
    });
    await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me april 17 at 8pm to hug my wife",
      state: undefined,
      now: new Date("2026-07-01T18:00:00Z"),
      timeZone: "America/Denver",
    });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain(
      "Current date and time: Wednesday 2026-07-01 12:00 (America/Denver)",
    );
    expect(prompt).toContain("- dueDate:");
    expect(prompt).toContain("- dueWeekday:");
    expect(prompt).toContain("- dueInMinutes:");
  });
});

describe("extractTaskCreatePlanWithLlm requestKind trust", () => {
  it("trusts the LLM reminder classification for non-English requests", async () => {
    const runtime = makeRuntime(() =>
      JSON.stringify({
        ...BASE_PLAN_JSON,
        requestKind: "reminder",
        title: "Llamar a mamá",
        dueInDays: 1,
      }),
    );
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "recuérdame mañana llamar a mamá",
      state: undefined,
    });
    // No English keyword ("remind me", "reminder", …) appears in the intent;
    // the LLM classification must win anyway.
    expect(plan.requestKind).toBe("reminder");
    expect(plan.dueInDays).toBe(1);
  });

  it("trusts the LLM alarm classification without English alarm keywords", async () => {
    const runtime = makeRuntime(() =>
      JSON.stringify({
        ...BASE_PLAN_JSON,
        requestKind: "alarm",
        title: "Despertar",
        timeOfDay: "07:00",
      }),
    );
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "despiértame a las 7 de la mañana",
      state: undefined,
    });
    expect(plan.requestKind).toBe("alarm");
  });

  it("still nulls requestKind values outside the schema", async () => {
    const runtime = makeRuntime(() =>
      JSON.stringify({
        ...BASE_PLAN_JSON,
        requestKind: "todo",
      }),
    );
    const plan = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me friday to call mom",
      state: undefined,
    });
    expect(plan.requestKind).toBeNull();
  });

  it("reports and propagates model failures instead of fabricating a response plan", async () => {
    const runtime = {
      useModel: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    await expect(
      extractTaskCreatePlanWithLlm({
        runtime,
        intent: "remind me friday at 5pm to call mom",
        state: undefined,
      }),
    ).rejects.toThrow("model unavailable");
    expect(runtime.reportError).toHaveBeenCalledWith(
      "ExtractorPipeline.model",
      expect.objectContaining({ message: "model unavailable" }),
      expect.any(Object),
    );
  });
});
