/**
 * Unit tests for the built-in TaskGateRegistry.
 *
 * Regression coverage for the `personal_baseline_sufficient` gate (#8795):
 * plugin-health's `sleep-recap` default pack references this gate kind, but it
 * was never registered in `registerBuiltInGates`. The runner treats an
 * unregistered gate kind as a hard `deny` ("unknown gate kind: <kind>"), so the
 * pack could NEVER fire — every attempt skipped. These tests assert the gate
 * resolves and that driving the sleep-recap gate kinds through the registry
 * (the same lookup the runner performs) yields no "unknown gate kind" decision,
 * while still honoring the pack's min-sample contract.
 */

import { describe, expect, it } from "vitest";

import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import type {
  GateDecision,
  GateEvaluationContext,
  ScheduledTask,
} from "./types.js";

/**
 * The exact lookup the runner performs in `evaluateGates` — an unregistered
 * kind resolves to a hard `deny`. Mirroring it here lets us prove the
 * permanent-skip path is closed without standing up the full runner.
 */
function lookupGateDecision(
  reg: ReturnType<typeof createTaskGateRegistry>,
  kind: string,
): GateDecision {
  const contrib = reg.get(kind);
  if (!contrib) {
    return { kind: "deny", reason: `unknown gate kind: ${kind}` };
  }
  return { kind: "allow" };
}

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
  it("registers a resolvable personal_baseline_sufficient gate", () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    expect(reg.get("personal_baseline_sufficient")).not.toBeNull();
  });

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

  it("does not yield an 'unknown gate kind' decision for any sleep-recap gate", () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const task = sleepRecapTask();
    for (const gateRef of task.shouldFire?.gates ?? []) {
      const decision = lookupGateDecision(reg, gateRef.kind);
      expect(decision.kind).toBe("allow");
      if (decision.kind === "deny") {
        expect(decision.reason).not.toMatch(/unknown gate kind/);
      }
    }
  });

  it("still denies a genuinely unknown gate kind", () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const decision = lookupGateDecision(reg, "does_not_exist");
    expect(decision).toEqual({
      kind: "deny",
      reason: "unknown gate kind: does_not_exist",
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
      taskId: "t-poke",
      kind: "checkin",
      promptInstructions: "poke",
      trigger: { kind: "interval", everyMinutes: 60 },
      priority: "low",
      shouldFire: {
        compose: "all",
        gates: [{ kind: "no_recent_user_message_in", params: { minutes } }],
      },
      respectsGlobalPause: true,
      state: { status: "scheduled", followupCount: 0 },
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
    } as ScheduledTask;
  }

  function contextWithActivity(
    task: ScheduledTask,
    recentlyActive: boolean,
  ): GateEvaluationContext {
    return {
      task,
      nowIso: "2026-05-10T12:00:00.000Z",
      ownerFacts: { timezone: "UTC" },
      activity: { hasSignalSince: () => recentlyActive },
      subjectStore: { wasUpdatedSince: () => false },
    };
  }

  it("defers (does not deny) when the user was recently active", async () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    const task = pokeTask(30);
    const decision = await reg
      .get("no_recent_user_message_in")
      ?.evaluate(task, contextWithActivity(task, true));
    expect(decision?.kind).toBe("defer");
    if (decision?.kind === "defer" && "offsetMinutes" in decision.until) {
      expect(decision.until.offsetMinutes).toBe(30);
    }
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
      taskId: "t-weekday",
      kind: "reminder",
      promptInstructions: "stretch",
      trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      priority: "low",
      shouldFire: {
        compose: "all",
        gates: [
          weekdays === undefined
            ? { kind: "weekday_only" }
            : { kind: "weekday_only", params: { weekdays } },
        ],
      },
      respectsGlobalPause: true,
      state: { status: "scheduled", followupCount: 0 },
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
    } as ScheduledTask;
  }

  function contextAt(
    task: ScheduledTask,
    nowIso: string,
  ): GateEvaluationContext {
    return {
      task,
      nowIso,
      ownerFacts: { timezone: "UTC" },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
    };
  }

  const MONDAY = "2026-05-11T12:00:00.000Z";
  const TUESDAY = "2026-05-12T12:00:00.000Z";
  const SATURDAY = "2026-05-09T12:00:00.000Z";

  async function decide(task: ScheduledTask, nowIso: string) {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    return reg.get("weekday_only")?.evaluate(task, contextAt(task, nowIso));
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
  it("registers a resolvable model_moment_check gate", () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    expect(reg.get("model_moment_check")).not.toBeNull();
    expect(lookupGateDecision(reg, "model_moment_check")).toEqual({
      kind: "allow",
    });
  });

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
