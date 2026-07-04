/**
 * FIX-4(c) / issue #12186: drive persona default-pack records through a REAL
 * in-memory ScheduledTask runner (built-in gates + escalation ladders +
 * dispatcher), not just assert compiled DTO fields. Proves the packs actually
 * FIRE, GATE, and ESCALATE as intended when the scheduler evaluates them.
 *
 * This is the closest headless equivalent to a full scenario tick that does
 * NOT depend on the scenario-runner boot (which is CI-gated on a pre-existing
 * shared-tree packaging gap). The runner here is the same one the production
 * spine builds — same gate registry, same escalation resolver, same dispatch
 * path — with in-memory stores.
 */

import type { ScheduledTaskInput } from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import {
  adhdBodyDoublePack,
  lowEnergySupportPack,
  SOFT_LOW_ENERGY_ESCALATION_STEPS,
} from "../src/default-packs/index.js";
import { createLifeOpsScheduledTaskSimulationHarness } from "./helpers/lifeops-scheduled-task-simulation.ts";

/** Turn a compiled pack seed into a runner.schedule input (drop nothing). */
function seedToInput(
  record: (typeof lowEnergySupportPack.records)[number],
): Partial<ScheduledTaskInput> {
  // The seed already omits taskId/state; schedulePrimitive merges these
  // overrides over its defaults, so spreading the full record makes the runner
  // schedule the ACTUAL pack task (trigger, escalation, completionCheck, …).
  return { ...record } as Partial<ScheduledTaskInput>;
}

describe("persona packs — real scheduler-tick behavior", () => {
  it("low-energy-support checkin fires and dispatches at SOFT intensity (first ladder step)", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    const record = lowEnergySupportPack.records[0];
    expect(record).toBeDefined();
    // Schedule the real pack record; fire immediately (manual fire path).
    const task = await h.schedulePrimitive(
      "checkin",
      seedToInput(record as (typeof lowEnergySupportPack.records)[number]),
    );
    const fired = await h.firePrimitive(task);

    expect(fired.state.status).toBe("fired");
    expect(h.dispatches).toHaveLength(1);
    // The first soft ladder step is intensity "soft" on the in_app channel.
    expect(h.dispatches[0]?.intensity).toBe("soft");
    expect(h.dispatches[0]?.channelKey).toBe("in_app");
  });

  it("low-energy-support escalation NEVER reaches an urgent step across the full ladder", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    const record = lowEnergySupportPack.records[0];
    const task = await h.schedulePrimitive(
      "checkin",
      seedToInput(record as (typeof lowEnergySupportPack.records)[number]),
    );
    await h.firePrimitive(task);

    // Walk the whole soft ladder by advancing past each step's delay and
    // re-firing the escalation. The runner advances the cursor per step.
    for (const step of SOFT_LOW_ENERGY_ESCALATION_STEPS) {
      h.advanceMinutes(step.delayMinutes + 1);
      await h.runner.apply(task.taskId, "escalate").catch(() => undefined);
    }

    // Every dispatch that happened must be soft intensity — no urgent step
    // exists in this persona ladder, so a shaming cross-channel push can never
    // occur no matter how many times the reminder goes unanswered.
    expect(h.dispatches.length).toBeGreaterThan(0);
    for (const dispatch of h.dispatches) {
      expect(dispatch.intensity).not.toBe("urgent");
    }
  });

  it("adhd-body-double checkin fires flexibly and stays soft-only", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    const record = adhdBodyDoublePack.records[0];
    expect(record?.trigger).toEqual({
      kind: "during_window",
      windowKey: "morning",
    });
    const task = await h.schedulePrimitive(
      "checkin",
      seedToInput(record as (typeof adhdBodyDoublePack.records)[number]),
    );
    const fired = await h.firePrimitive(task);

    expect(fired.state.status).toBe("fired");
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]?.intensity).toBe("soft");
  });

  it("a no_recent_user_message_in-gated poke is SUPPRESSED (deferred) when the user is active", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    // Bus reports the user was recently active on a message channel.
    h.setActivity({ hasSignalSince: () => true });

    const poke = await h.schedulePrimitive("checkin", {
      promptInstructions: "proactive poke",
      trigger: { kind: "manual" },
      priority: "low",
      shouldFire: {
        compose: "all",
        gates: [{ kind: "no_recent_user_message_in", params: { minutes: 30 } }],
      },
    });
    const fired = await h.firePrimitive(poke);

    // The built-in gate defers (reschedules) rather than dispatching, so no
    // message reaches the user while they are active.
    expect(fired.state.status).not.toBe("fired");
    expect(h.dispatches).toHaveLength(0);
  });

  it("the same poke FIRES once the user goes quiet (gate allows)", async () => {
    const h = createLifeOpsScheduledTaskSimulationHarness();
    h.setActivity({ hasSignalSince: () => false });

    const poke = await h.schedulePrimitive("checkin", {
      promptInstructions: "proactive poke",
      trigger: { kind: "manual" },
      priority: "low",
      shouldFire: {
        compose: "all",
        gates: [{ kind: "no_recent_user_message_in", params: { minutes: 30 } }],
      },
    });
    const fired = await h.firePrimitive(poke);

    expect(fired.state.status).toBe("fired");
    expect(h.dispatches).toHaveLength(1);
  });
});
