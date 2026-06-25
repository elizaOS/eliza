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
