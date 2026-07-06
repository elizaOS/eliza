/**
 * Moment-judge gate (#14677) — deterministic unit coverage with the model
 * stubbed at the runtime boundary (`useModel`): verdict parsing/clamping,
 * prompt composition from owner context, gate mapping (send/defer/drop), the
 * high-priority safety rail, and the judge-unavailable degrade.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  GateEvaluationContext,
  ScheduledTask,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import {
  buildMomentJudgePrompt,
  composeMomentJudgeContext,
  MAX_DEFER_MINUTES,
  MIN_DEFER_MINUTES,
  type MomentJudgeContext,
  makeModelMomentCheckGate,
  parseMomentJudgeVerdict,
} from "./moment-judge.js";

interface FakeRuntimeOptions {
  modelOutput?: unknown;
  modelError?: Error;
  tasks?: unknown[];
}

interface FakeRuntime {
  runtime: IAgentRuntime;
  prompts: string[];
  reportedErrors: Array<{ scope: string; error: unknown }>;
}

function makeFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const prompts: string[] = [];
  const reportedErrors: Array<{ scope: string; error: unknown }> = [];
  const cache = new Map<string, unknown>();
  const runtime = {
    agentId: "agent-1",
    async getTasks() {
      return options.tasks ?? [];
    },
    async getCache(key: string) {
      return cache.get(key);
    },
    async setCache(key: string, value: unknown) {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string) {
      cache.delete(key);
      return true;
    },
    async useModel(_type: string, params: { prompt: string }) {
      prompts.push(params.prompt);
      if (options.modelError) throw options.modelError;
      return options.modelOutput ?? null;
    },
    reportError(scope: string, error: unknown) {
      reportedErrors.push({ scope, error });
    },
  } as unknown as IAgentRuntime;
  return { runtime, prompts, reportedErrors };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: "t-moment-1",
    kind: "reminder",
    promptInstructions: "Send a soft stretch nudge.",
    trigger: { kind: "interval", everyMinutes: 360 },
    priority: "low",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "habit-starters",
    ownerVisible: true,
    ...overrides,
  };
}

function makeGateContext(
  task: ScheduledTask,
  overrides: Partial<GateEvaluationContext> = {},
): GateEvaluationContext {
  return {
    task,
    nowIso: "2026-07-05T15:00:00.000Z",
    ownerFacts: { timezone: "America/New_York" },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    ...overrides,
  };
}

function makeJudgeContext(
  overrides: Partial<MomentJudgeContext> = {},
): MomentJudgeContext {
  return {
    task: {
      kind: "reminder",
      priority: "low",
      source: "default_pack",
      promptInstructions: "Send a soft stretch nudge.",
    },
    nowIso: "2026-07-05T15:00:00.000Z",
    timezone: "America/New_York",
    minutesSinceOwnerSeen: 12,
    ownerObservedAsleep: false,
    quietStreakDays: undefined,
    quietHours: null,
    morningWindow: null,
    eveningWindow: null,
    chronotype: null,
    scheduleStyle: null,
    ...overrides,
  };
}

describe("parseMomentJudgeVerdict", () => {
  it("parses a send verdict", () => {
    expect(
      parseMomentJudgeVerdict('{"decision":"send","reason":"owner active"}'),
    ).toMatchObject({ decision: "send", reason: "owner active" });
  });

  it("parses a defer verdict and keeps in-range minutes", () => {
    const verdict = parseMomentJudgeVerdict(
      '{"decision":"defer","deferMinutes":25,"reason":"mid-meeting"}',
    );
    expect(verdict).toMatchObject({ decision: "defer", deferMinutes: 25 });
  });

  it("clamps defer minutes to the [min, max] window", () => {
    expect(
      parseMomentJudgeVerdict('{"decision":"defer","deferMinutes":1}')
        ?.deferMinutes,
    ).toBe(MIN_DEFER_MINUTES);
    expect(
      parseMomentJudgeVerdict('{"decision":"defer","deferMinutes":100000}')
        ?.deferMinutes,
    ).toBe(MAX_DEFER_MINUTES);
  });

  it("defaults defer minutes when the model omits them", () => {
    const verdict = parseMomentJudgeVerdict('{"decision":"defer"}');
    expect(verdict?.deferMinutes).toBeGreaterThanOrEqual(MIN_DEFER_MINUTES);
    expect(verdict?.deferMinutes).toBeLessThanOrEqual(MAX_DEFER_MINUTES);
  });

  it("parses a drop verdict from a fenced JSON block", () => {
    expect(
      parseMomentJudgeVerdict(
        '```json\n{"decision":"drop","reason":"stale"}\n```',
      ),
    ).toMatchObject({ decision: "drop", reason: "stale" });
  });

  it("accepts a pre-parsed object", () => {
    expect(
      parseMomentJudgeVerdict({ decision: "SEND", reason: "fine" }),
    ).toMatchObject({ decision: "send" });
  });

  it("returns null for garbage, unknown decisions, and non-objects", () => {
    expect(parseMomentJudgeVerdict("not json at all")).toBeNull();
    expect(parseMomentJudgeVerdict('{"decision":"maybe"}')).toBeNull();
    expect(parseMomentJudgeVerdict('"send"')).toBeNull();
    expect(parseMomentJudgeVerdict(null)).toBeNull();
    expect(parseMomentJudgeVerdict(42)).toBeNull();
  });
});

describe("buildMomentJudgePrompt", () => {
  it("grounds the prompt in the task and the owner context", () => {
    const prompt = buildMomentJudgePrompt(
      makeJudgeContext({
        quietStreakDays: 4,
        quietHours: { start: "22:00", end: "07:00" },
        morningWindow: { start: "07:00", end: "12:00" },
        chronotype: "late",
        scheduleStyle: "regular",
      }),
    );
    expect(prompt).toContain("task kind: reminder; priority: low");
    expect(prompt).toContain("Send a soft stretch nudge.");
    expect(prompt).toContain("12 minute(s) ago");
    expect(prompt).toContain("observed circadian state: awake");
    expect(prompt).toContain("4 consecutive ignored check-ins/follow-ups");
    expect(prompt).toContain("22:00-07:00");
    expect(prompt).toContain("07:00-12:00");
    expect(prompt).toContain("chronotype: late; schedule style: regular");
    expect(prompt).toContain('"send" | "defer" | "drop"');
  });

  it("labels unknown context honestly instead of fabricating values", () => {
    const prompt = buildMomentJudgePrompt(
      makeJudgeContext({
        minutesSinceOwnerSeen: null,
        ownerObservedAsleep: null,
        quietStreakDays: undefined,
      }),
    );
    expect(prompt).toContain("last seen active: unknown");
    expect(prompt).toContain("observed circadian state: unknown");
    expect(prompt).toContain("none (owner has been responsive)");
  });
});

describe("composeMomentJudgeContext", () => {
  it("reads presence and circadian state from the persisted activity profile", async () => {
    const nowIso = "2026-07-05T15:00:00.000Z";
    const lastSeenAt = Date.parse(nowIso) - 30 * 60_000;
    const { runtime } = makeFakeRuntime({
      tasks: [
        {
          name: "PROACTIVE_AGENT",
          metadata: {
            activityProfile: {
              ownerEntityId: "owner-1",
              analyzedAt: Date.parse(nowIso),
              totalMessages: 12,
              isCurrentlySleeping: true,
              lastSeenAt,
              platforms: [],
              analysisWindowDays: 14,
            },
          },
        },
      ],
    });
    const task = makeTask();
    const context = await composeMomentJudgeContext(
      runtime,
      task,
      makeGateContext(task, {
        nowIso,
        ownerFacts: { timezone: "UTC" },
        activity: { hasSignalSince: () => false },
        subjectStore: { wasUpdatedSince: () => false },
        task,
      }),
    );
    expect(context.minutesSinceOwnerSeen).toBe(30);
    expect(context.ownerObservedAsleep).toBe(true);
    expect(context.timezone).toBe("UTC");
  });

  it("reports unknown presence when no profile exists yet", async () => {
    const { runtime } = makeFakeRuntime();
    const task = makeTask();
    const context = await composeMomentJudgeContext(
      runtime,
      task,
      makeGateContext(task),
    );
    expect(context.minutesSinceOwnerSeen).toBeNull();
    expect(context.ownerObservedAsleep).toBeNull();
    expect(context.quietStreakDays).toBeUndefined();
  });
});

describe("makeModelMomentCheckGate", () => {
  it("honors a send verdict with allow", async () => {
    const fake = makeFakeRuntime({
      modelOutput: '{"decision":"send","reason":"owner just active"}',
    });
    const gate = makeModelMomentCheckGate(fake.runtime);
    const task = makeTask();
    const decision = await gate.evaluate(task, makeGateContext(task));
    expect(decision).toEqual({ kind: "allow" });
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain("Send a soft stretch nudge.");
    expect(fake.prompts[0]).toContain("last seen active");
  });

  it("honors a defer verdict with a gate defer", async () => {
    const fake = makeFakeRuntime({
      modelOutput:
        '{"decision":"defer","deferMinutes":30,"reason":"likely asleep"}',
    });
    const gate = makeModelMomentCheckGate(fake.runtime);
    const task = makeTask();
    const decision = await gate.evaluate(task, makeGateContext(task));
    expect(decision).toEqual({
      kind: "defer",
      until: { offsetMinutes: 30 },
      reason: "model_moment_check: likely asleep",
    });
  });

  it("honors a drop verdict with a deny", async () => {
    const fake = makeFakeRuntime({
      modelOutput: '{"decision":"drop","reason":"redundant poke"}',
    });
    const gate = makeModelMomentCheckGate(fake.runtime);
    const task = makeTask();
    const decision = await gate.evaluate(task, makeGateContext(task));
    expect(decision).toEqual({
      kind: "deny",
      reason: "model_moment_check: redundant poke",
    });
  });

  it("never model-vetoes a high-priority task (safety rail, no model call)", async () => {
    const fake = makeFakeRuntime({
      modelOutput: '{"decision":"drop","reason":"should never be consulted"}',
    });
    const gate = makeModelMomentCheckGate(fake.runtime);
    const task = makeTask({ priority: "high" });
    const decision = await gate.evaluate(task, makeGateContext(task));
    expect(decision).toEqual({ kind: "allow" });
    expect(fake.prompts).toHaveLength(0);
  });

  it("degrades to allow and reports the error when the judge call fails", async () => {
    const fake = makeFakeRuntime({ modelError: new Error("model down") });
    const gate = makeModelMomentCheckGate(fake.runtime);
    const task = makeTask();
    const decision = await gate.evaluate(task, makeGateContext(task));
    expect(decision).toEqual({ kind: "allow" });
    expect(fake.reportedErrors).toHaveLength(1);
    expect(fake.reportedErrors[0]?.scope).toBe(
      "lifeops:scheduled-task:moment-judge",
    );
  });

  it("degrades to allow on unparseable judge output", async () => {
    const fake = makeFakeRuntime({ modelOutput: "shrug, hard to say" });
    const gate = makeModelMomentCheckGate(fake.runtime);
    const task = makeTask();
    const decision = await gate.evaluate(task, makeGateContext(task));
    expect(decision).toEqual({ kind: "allow" });
  });
});
