/**
 * Unit tests for the escalation-ladder registry: default ladders by priority,
 * next-step advancement across channels, snooze resetting the ladder to step 0,
 * and effective-ladder resolution. Pure functions, no runtime.
 */

import { describe, expect, it } from "vitest";
import {
  createEscalationLadderRegistry,
  DEFAULT_ESCALATION_LADDERS,
  nextEscalationStep,
  registerDefaultEscalationLadders,
  resetLadderForSnooze,
  resolveEffectiveLadder,
} from "./escalation.js";
import type { ScheduledTask } from "./types.js";

/**
 * The escalation evaluator decides how a reminder/task nags: which ladder
 * applies (inline > named > priority default), when the next step fires
 * (delay anchored to the last dispatch), and that a snooze resets the ladder.
 */

const task = (overrides: Partial<ScheduledTask>): ScheduledTask =>
  ({ priority: "medium", ...overrides }) as ScheduledTask;

describe("createEscalationLadderRegistry", () => {
  it("registers, gets, lists, and guards duplicates / empty keys", () => {
    const reg = createEscalationLadderRegistry();
    reg.register({ ladderKey: "a", steps: [] });
    expect(reg.get("a")?.ladderKey).toBe("a");
    expect(reg.get("missing")).toBeNull();
    expect(reg.list()).toHaveLength(1);
    expect(() => reg.register({ ladderKey: "a", steps: [] })).toThrow(
      /duplicate/,
    );
    // override allowed when asked.
    reg.register(
      {
        ladderKey: "a",
        steps: [{ delayMinutes: 5, channelKey: "push", intensity: "normal" }],
      },
      { override: true },
    );
    expect(reg.get("a")?.steps).toHaveLength(1);
    expect(() => reg.register({ ladderKey: "", steps: [] })).toThrow(
      /ladderKey required/,
    );
  });
});

describe("registerDefaultEscalationLadders", () => {
  it("seeds the three priority defaults and is idempotent", () => {
    const reg = createEscalationLadderRegistry();
    registerDefaultEscalationLadders(reg);
    expect(reg.get("priority_low_default")?.steps).toEqual([]);
    expect(reg.get("priority_medium_default")?.steps).toHaveLength(1);
    expect(reg.get("priority_high_default")?.steps).toHaveLength(3);
    // second call must not throw on already-present keys.
    expect(() => registerDefaultEscalationLadders(reg)).not.toThrow();
  });
});

describe("resolveEffectiveLadder", () => {
  const reg = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(reg);
  reg.register({
    ladderKey: "custom",
    steps: [{ delayMinutes: 10, channelKey: "push", intensity: "normal" }],
  });

  it("prefers inline steps over everything", () => {
    const inline = [
      { delayMinutes: 1, channelKey: "in_app", intensity: "soft" as const },
    ];
    const out = resolveEffectiveLadder(
      task({ priority: "high", escalation: { steps: inline } }),
      reg,
    );
    expect(out.ladderKey).toBe("inline");
    expect(out.steps).toBe(inline);
  });

  it("resolves a named ladderKey when no inline steps", () => {
    const out = resolveEffectiveLadder(
      task({ priority: "low", escalation: { ladderKey: "custom" } }),
      reg,
    );
    expect(out.ladderKey).toBe("custom");
  });

  it("falls back to the priority default ladder", () => {
    expect(
      resolveEffectiveLadder(task({ priority: "low" }), reg).steps,
    ).toEqual([]);
    expect(
      resolveEffectiveLadder(task({ priority: "high" }), reg).steps,
    ).toHaveLength(3);
  });

  it("falls back to the priority default when a named ladder is unknown", () => {
    const out = resolveEffectiveLadder(
      task({ priority: "medium", escalation: { ladderKey: "nope" } }),
      reg,
    );
    expect(out.ladderKey).toBe("priority_medium_default");
  });
});

describe("nextEscalationStep", () => {
  const ladder = DEFAULT_ESCALATION_LADDERS.priority_high_default;

  it("anchors the next fire time to lastDispatchedAt + delayMinutes", () => {
    const start = "2026-06-23T10:00:00.000Z";
    const first = nextEscalationStep(ladder, {
      stepIndex: -1,
      lastDispatchedAt: start,
    });
    expect(first?.nextStepIndex).toBe(0);
    expect(first?.fireAtIso).toBe(start); // step 0 delay = 0 min
    const second = nextEscalationStep(ladder, {
      stepIndex: 0,
      lastDispatchedAt: start,
    });
    expect(second?.fireAtIso).toBe("2026-06-23T10:15:00.000Z"); // +15 min
  });

  it("returns null once the ladder is exhausted", () => {
    expect(
      nextEscalationStep(ladder, {
        stepIndex: 2,
        lastDispatchedAt: "2026-06-23T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      nextEscalationStep(
        { ladderKey: "empty", steps: [] },
        { stepIndex: -1, lastDispatchedAt: "2026-06-23T10:00:00.000Z" },
      ),
    ).toBeNull();
  });
});

describe("resetLadderForSnooze", () => {
  it("resets to step -1 anchored at the new fire time", () => {
    expect(resetLadderForSnooze("2026-06-24T09:00:00.000Z")).toEqual({
      stepIndex: -1,
      lastDispatchedAt: "2026-06-24T09:00:00.000Z",
    });
  });
});
