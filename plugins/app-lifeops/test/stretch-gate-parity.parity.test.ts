/**
 * Wave-2 W2-A — parity replay test for the deleted `stretch-decider`
 * legacy carve-out.
 *
 * IMPL §5.1 verification requires: "30 days of synthetic stretch
 * occurrences against the registered gates produce identical decisions
 * to the legacy `stretch-decider`."
 *
 * The legacy decider's rules (from
 * `src/lifeops/stretch-decider.ts`, deleted in W2-A):
 *
 *   - weekend (Sat/Sun) → skip
 *   - busy day → skip                       — busy_day_skip gate
 *   - hour >= 21 (late evening) → skip
 *   - cadence (>= 6h since last fire) OR
 *     walk-out reset (more recent walk than last fire) → fire
 *
 * After W2-A those rules live as a multi-gate `first_deny` composition
 * on the stretch starter task in `default-packs/habit-starters.ts`:
 *
 *   shouldFire: { compose: "first_deny",
 *                 gates: [ { kind: "weekend_skip" },
 *                          { kind: "late_evening_skip" },
 *                          { kind: "stretch.walk_out_reset" } ] }
 *
 * This test pins the parity for the two gates that already ship as
 * built-ins (`weekend_skip`, `late_evening_skip`). The
 * `stretch.walk_out_reset` and `busy_day_skip` rules are explicitly
 * deferred to Wave-3 W3-C verification once those gates are registered
 * (the pack already references the gate kinds, so parity will close
 * naturally when W2-D / W2-F register the missing gates).
 */

import { describe, expect, it } from "vitest";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../src/lifeops/scheduled-task/gate-registry.js";
import type {
  ScheduledTask,
  GateEvaluationContext,
} from "../src/lifeops/scheduled-task/types.js";

/** Reproduces the legacy stretch-decider's weekend + late-evening rules. */
function legacyStretchDecision(args: {
  dayOfWeek: number;
  hourOfDay: number;
}): "fire" | "skip" {
  if (args.dayOfWeek === 0 || args.dayOfWeek === 6) return "skip";
  if (args.hourOfDay >= 21) return "skip";
  return "fire";
}

function buildStretchTask(): ScheduledTask {
  return {
    taskId: "test-stretch",
    kind: "reminder",
    promptInstructions: "stretch",
    trigger: { kind: "interval", everyMinutes: 360 },
    priority: "low",
    shouldFire: {
      compose: "first_deny",
      gates: [{ kind: "weekend_skip" }, { kind: "late_evening_skip" }],
    },
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "habit-starters",
    ownerVisible: true,
  };
}

/** Build a synthetic context for a given UTC day/hour, anchored to UTC tz. */
function buildContext(args: {
  dayOfMonthOffset: number;
  hourOfDay: number;
}): GateEvaluationContext {
  // Anchor to a known Monday: 2026-05-04 is a Monday.
  const baseUtc = Date.UTC(2026, 4, 4, args.hourOfDay, 0, 0);
  const ms = baseUtc + args.dayOfMonthOffset * 24 * 60 * 60 * 1000;
  return {
    task: buildStretchTask(),
    nowIso: new Date(ms).toISOString(),
    ownerFacts: { timezone: "UTC" },
  };
}

describe("stretch gate parity replay (W2-A §5.1)", () => {
  it("matches legacy weekend_skip + late_evening_skip across 30 days x 24 hours", () => {
    const registry = createTaskGateRegistry();
    registerBuiltInGates(registry);
    const weekendSkip = registry.get("weekend_skip");
    const lateEveningSkip = registry.get("late_evening_skip");
    expect(weekendSkip).not.toBeNull();
    expect(lateEveningSkip).not.toBeNull();

    const mismatches: Array<{
      day: number;
      hour: number;
      gateDecision: "fire" | "skip";
      legacyDecision: "fire" | "skip";
    }> = [];

    for (let day = 0; day < 30; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const ctx = buildContext({ dayOfMonthOffset: day, hourOfDay: hour });
        const dayOfWeek = new Date(ctx.nowIso).getUTCDay();

        // Compose `first_deny`: deny on first denying gate.
        let gateDecision: "fire" | "skip" = "fire";
        for (const gate of [weekendSkip, lateEveningSkip] as const) {
          if (!gate) continue;
          const decision = gate.evaluate(ctx.task, ctx);
          // Promises wouldn't fit our deterministic loop; the built-in
          // gates are synchronous.
          if (decision instanceof Promise) {
            throw new Error("built-in gates must be synchronous");
          }
          if (decision.kind === "deny") {
            gateDecision = "skip";
            break;
          }
        }

        const legacyDecision = legacyStretchDecision({
          dayOfWeek,
          hourOfDay: hour,
        });
        if (gateDecision !== legacyDecision) {
          mismatches.push({
            day,
            hour,
            gateDecision,
            legacyDecision,
          });
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("documents Wave-3 W3-C verification deferral for busy_day_skip + stretch.walk_out_reset", () => {
    // The pack at `default-packs/habit-starters.ts` already names
    // `stretch.walk_out_reset` as a gate, but the registry registers
    // only the two built-in gates above. `busy_day_skip` is absent.
    // Both gates land via Wave-2 W2-D (signal-bus + activity gates) and
    // Wave-2 W2-F (BlockerRegistry); full 30-day parity replay
    // including those signals is part of the Wave-3 W3-C journey
    // replay suite.
    const registry = createTaskGateRegistry();
    registerBuiltInGates(registry);
    expect(registry.get("stretch.walk_out_reset")).toBeNull();
    expect(registry.get("busy_day_skip")).toBeNull();
  });
});
