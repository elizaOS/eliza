/** Exercises built-in gate decisions and first-wins registration through the real registry. */

import { describe, expect, it } from "vitest";

import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import type { GateEvaluationContext, ScheduledTask } from "./types.js";

function makeContext(
  task: ScheduledTask,
  sampleCount?: number,
): GateEvaluationContext {
  return {
    task,
    nowIso: "2026-05-09T12:00:00.000Z",
    ownerFacts: {
      timezone: "UTC",
      ...(sampleCount === undefined
        ? {}
        : { personalBaseline: { sampleCount, windowDays: 28 } }),
    },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
  };
}

/** Minimal sleep-recap-shaped task carrying the two gate kinds the pack uses. */
function sleepRecapTask(): ScheduledTask {
  return {
    taskId: "t-sleep-recap",
    kind: "recap",
    promptInstructions: "recap",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 240,
    },
    priority: "low",
    shouldFire: {
      compose: "all",
      gates: [
        { kind: "personal_baseline_sufficient", params: { minSamples: 5 } },
        { kind: "circadian_state_in", params: { states: ["awake"] } },
      ],
    },
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "plugin-health",
    ownerVisible: true,
  };
}

describe("registerBuiltInGates: personal_baseline_sufficient (#8795)", () => {
  it("allows personal_baseline_sufficient when sample count meets minSamples", async () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const gate = reg.get("personal_baseline_sufficient");
    expect(gate).not.toBeNull();
    const decision = await gate?.evaluate(
      sleepRecapTask(),
      makeContext(sleepRecapTask(), 5),
    );
    expect(decision).toEqual({ kind: "allow" });
  });

  it("denies personal_baseline_sufficient when sample count is too low", async () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const task = sleepRecapTask();
    const decision = await reg
      .get("personal_baseline_sufficient")
      ?.evaluate(task, makeContext(task, 4));
    expect(decision).toEqual({
      kind: "deny",
      reason: "personal_baseline_sufficient: sample count 4 < 5",
    });
  });

  it("denies personal_baseline_sufficient when no sample count is available", async () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const task = sleepRecapTask();
    const decision = await reg
      .get("personal_baseline_sufficient")
      ?.evaluate(task, makeContext(task));
    expect(decision).toEqual({
      kind: "deny",
      reason: "personal_baseline_sufficient: sample count unavailable",
    });
  });
});

/**
 * Built-in (PA-absent) `no_recent_user_message_in` fallback (#12186). When the
 * activity bus reports a recent `message_activity_event`, the poke must be
 * DEFERRED (delayed), never DENIED — denying silently drops the proactive poke.
 */
describe("registerBuiltInGates: no_recent_user_message_in fallback defers", () => {
  function pokeTask(minutes: number): ScheduledTask {
    return {
      ...sleepRecapTask(),
      taskId: "t-poke",
      kind: "checkin",
      promptInstructions: "poke",
      trigger: { kind: "interval", everyMinutes: 60 },
      shouldFire: {
        compose: "all",
        gates: [{ kind: "no_recent_user_message_in", params: { minutes } }],
      },
      createdBy: "test",
    };
  }

  function contextWithActivity(
    task: ScheduledTask,
    recentlyActive: boolean,
  ): GateEvaluationContext {
    return {
      ...makeContext(task),
      nowIso: "2026-05-10T12:00:00.000Z",
      activity: { hasSignalSince: () => recentlyActive },
    };
  }

  it("defers (does not deny) when the user was recently active", async () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const task = pokeTask(30);
    const decision = await reg
      .get("no_recent_user_message_in")
      ?.evaluate(task, contextWithActivity(task, true));
    expect(decision).toMatchObject({
      kind: "defer",
      until: { offsetMinutes: 30 },
    });
  });

  it("allows when the user has been quiet", async () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const task = pokeTask(30);
    const decision = await reg
      .get("no_recent_user_message_in")
      ?.evaluate(task, contextWithActivity(task, false));
    expect(decision).toEqual({ kind: "allow" });
  });
});

/**
 * First-wins semantics (#12186): a caller may register a richer production
 * reader for a kind BEFORE registerBuiltInGates; the built-in must then be
 * skipped so the caller's reader stays authoritative.
 */
describe("registerBuiltInGates first-wins", () => {
  it("keeps a pre-registered contribution for a built-in kind", () => {
    const reg = createTaskGateRegistry();
    const sentinel: import("./types.js").TaskGateContribution = {
      kind: "circadian_state_in",
      evaluate: () => ({ kind: "deny", reason: "sentinel-reader" }),
    };
    // Register the custom reader FIRST, then the built-ins.
    reg.register(sentinel);
    registerBuiltInGates(reg);
    // The custom reader wins; the built-in fallback did not overwrite it.
    expect(reg.get("circadian_state_in")).toBe(sentinel);
    // Other built-ins are still registered.
    expect(reg.get("quiet_hours")).not.toBeNull();
    expect(reg.get("no_recent_user_message_in")).not.toBeNull();
  });
});

/**
 * Regression: `weekday_only` must honor `params.weekdays` (#10721 audit).
 * habit-starters passes `{ weekdays: [1, 3, 5] }` (Mon/Wed/Fri) — before the
 * fix the gate ignored the list and allowed every non-weekend day, so a
 * Mon/Wed/Fri habit fired five days a week.
 */
describe("weekday_only honors params.weekdays", () => {
  function weekdayTask(weekdays?: unknown): ScheduledTask {
    return {
      ...sleepRecapTask(),
      taskId: "t-weekday",
      kind: "reminder",
      promptInstructions: "stretch",
      trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      shouldFire: {
        compose: "all",
        gates: [
          weekdays === undefined
            ? { kind: "weekday_only" }
            : { kind: "weekday_only", params: { weekdays } },
        ],
      },
      createdBy: "test",
    };
  }

  const MONDAY = "2026-05-11T12:00:00.000Z";
  const TUESDAY = "2026-05-12T12:00:00.000Z";
  const SATURDAY = "2026-05-09T12:00:00.000Z";

  async function decide(task: ScheduledTask, nowIso: string) {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    return reg
      .get("weekday_only")
      ?.evaluate(task, { ...makeContext(task), nowIso });
  }

  it("allows a listed day (Mon in [1,3,5])", async () => {
    expect(await decide(weekdayTask([1, 3, 5]), MONDAY)).toEqual({
      kind: "allow",
    });
  });

  it("denies an unlisted weekday (Tue not in [1,3,5]) — the pre-fix bug", async () => {
    const decision = await decide(weekdayTask([1, 3, 5]), TUESDAY);
    expect(decision?.kind).toBe("deny");
    expect(decision && "reason" in decision ? decision.reason : "").toContain(
      "day 2 not in [1,3,5]",
    );
  });

  it("denies a weekend day not in the list", async () => {
    expect((await decide(weekdayTask([1, 3, 5]), SATURDAY))?.kind).toBe("deny");
  });

  it("an explicit list including a weekend day allows that day", async () => {
    expect(await decide(weekdayTask([0, 6]), SATURDAY)).toEqual({
      kind: "allow",
    });
  });

  it("without params keeps the any-non-weekend default", async () => {
    expect(await decide(weekdayTask(), MONDAY)).toEqual({ kind: "allow" });
    expect((await decide(weekdayTask(), SATURDAY))?.kind).toBe("deny");
  });

  it("invalid entries are filtered; an all-invalid list falls back to the default", async () => {
    expect(await decide(weekdayTask([9, -1, 2.5]), TUESDAY)).toEqual({
      kind: "allow",
    });
  });
});

describe("registerBuiltInGates: model_moment_check fallback (#14677)", () => {
  it("allows by default — no judge available means no judgment, never a starved task", async () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const gate = reg.get("model_moment_check");
    const task = sleepRecapTask();
    const decision = await gate?.evaluate(task, makeContext(task));
    expect(decision).toEqual({ kind: "allow" });
  });

  it("a pre-registered production judge wins over the fallback (first-wins)", async () => {
    const reg = createTaskGateRegistry();
    reg.register({
      kind: "model_moment_check",
      evaluate: () => ({ kind: "deny", reason: "judge says drop" }),
    });
    registerBuiltInGates(reg);
    const task = sleepRecapTask();
    const decision = await reg
      .get("model_moment_check")
      ?.evaluate(task, makeContext(task));
    expect(decision).toEqual({ kind: "deny", reason: "judge says drop" });
  });
});
