// @journey-16
/**
 * Real-runner integration for plugin-health default packs (#8795).
 *
 * Before this test the default packs were only exercised by SHAPE asserts
 * (`plugins/plugin-health/src/__tests__/smoke.test.ts`) and a hand-written
 * SIMULATION that fabricated a phantom sleep-recap record
 * (`plugins/plugin-personal-assistant/test/default-packs.smoke.test.ts`).
 * Neither ever drove a real pack record through the actual scheduled-task
 * spine, so the gates each pack references were never evaluated by the
 * runner. That is exactly how the `sleep-recap` pack shipped referencing an
 * UNREGISTERED `personal_baseline_sufficient` gate kind: a runner-less test
 * cannot catch an unknown-gate skip.
 *
 * This file constructs the production `createScheduledTaskRunner` with the
 * real `registerBuiltInGates`, schedules the ACTUAL imported pack records
 * (`bedtimeDefaultPack` / `wakeUpDefaultPack` / `sleepRecapDefaultPack`),
 * and drives each one through `fireWithResult` so the runner's real
 * `evaluateGates` runs. The assertion is the fire outcome:
 *   - `kind: "fired"`  → every gate the pack references resolved to allow.
 *   - `kind: "skipped"` with reason `"<gate>: unknown gate kind: <gate>"`
 *                       → the pack references a gate the runner never
 *                         registered (the original #8795 / pre-#9563 bug).
 *
 * The final test removes `personal_baseline_sufficient` from the registry to
 * prove this harness WOULD have caught the original unregistered-gate
 * regression — i.e. the coverage is real, not tautological.
 */

import {
  bedtimeDefaultPack,
  HEALTH_DEFAULT_PACKS,
  sleepRecapDefaultPack,
  wakeUpDefaultPack,
} from "@elizaos/plugin-health";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
  TaskGateRegistry,
} from "@elizaos/plugin-scheduling";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";

const FIXED_NOW_ISO = "2026-05-09T07:30:00.000Z";

/**
 * Construct a real runner. Callers can mutate the supplied `gates` registry
 * before scheduling to model "this gate was never registered" — the bug the
 * default packs originally shipped with.
 */
function makeRunner(gates: TaskGateRegistry): ScheduledTaskRunnerHandle {
  const ownerFacts: OwnerFactsView = {
    timezone: "UTC",
    morningWindow: { start: "07:00", end: "10:00" },
    eveningWindow: { start: "21:00", end: "23:30" },
    // sleep-recap's `personal_baseline_sufficient` gate (minSamples: 5) denies
    // with "sample count unavailable" unless the owner has a projected baseline;
    // give the modelled owner a sufficient sample window so the pack reaches a
    // real fire decision instead of skipping on missing baseline.
    personalBaseline: { sampleCount: 14, windowDays: 30 },
  };
  const globalPause: GlobalPauseView = {
    current: async () => ({ active: false }),
  };
  const activity: ActivitySignalBusView = { hasSignalSince: () => false };
  const subjectStore: SubjectStoreView = { wasUpdatedSince: () => false };

  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  let counter = 0;
  return createScheduledTaskRunner({
    agentId: "test-agent-health-packs",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ownerFacts,
    globalPause,
    activity,
    subjectStore,
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `hpk_${counter}`;
    },
    now: () => new Date(FIXED_NOW_ISO),
  });
}

/**
 * Schedule the single record a default pack ships and drive it through the
 * runner's real fire path. Returns the strict fire result so callers can
 * assert the actual gate outcome (`fired` vs `skipped` with a gate reason)
 * instead of a simulated approximation.
 */
async function fireFirstRecord(
  runner: ScheduledTaskRunnerHandle,
  record: Omit<ScheduledTask, "taskId" | "state">,
) {
  const scheduled = await runner.schedule(record);
  expect(scheduled.state.status).toBe("scheduled");
  return runner.fireWithResult(scheduled.taskId);
}

describe("plugin-health default packs through the real scheduled-task runner (#8795)", () => {
  it("registerBuiltInGates registers every gate kind the packs reference", () => {
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);

    const referenced = new Set<string>();
    for (const pack of HEALTH_DEFAULT_PACKS) {
      for (const record of pack.records) {
        for (const gate of record.shouldFire?.gates ?? []) {
          referenced.add(gate.kind);
        }
      }
    }
    // The packs use these three; each must resolve to a registered
    // contribution or the runner denies with "unknown gate kind".
    expect([...referenced].sort()).toEqual([
      "circadian_state_in",
      "no_recent_user_message_in",
      "personal_baseline_sufficient",
    ]);
    for (const kind of referenced) {
      expect(gates.get(kind)).not.toBeNull();
    }
  });

  it("sleep-recap fires through the real runner (personal_baseline_sufficient now resolves, post-#9563)", async () => {
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);
    const runner = makeRunner(gates);

    const record = sleepRecapDefaultPack.records[0];
    if (!record) throw new Error("sleepRecapDefaultPack should ship a record");
    // Guard the precondition that made this pack the #8795 canary: it depends
    // on the `personal_baseline_sufficient` gate being registered.
    expect(record.shouldFire?.gates?.map((g) => g.kind)).toContain(
      "personal_baseline_sufficient",
    );

    const result = await fireFirstRecord(runner, record);

    expect(result.kind).toBe("fired");
    if (result.kind === "skipped") {
      throw new Error(
        `sleep-recap was skipped by the real runner: ${result.reason}`,
      );
    }
  });

  it("bedtime and wake-up packs reach a real fire decision (no unknown-gate skip)", async () => {
    for (const pack of [bedtimeDefaultPack, wakeUpDefaultPack]) {
      const gates = createTaskGateRegistry();
      registerBuiltInGates(gates);
      const runner = makeRunner(gates);

      const record = pack.records[0];
      if (!record) throw new Error(`${pack.key} should ship a record`);

      const result = await fireFirstRecord(runner, record);

      expect(
        result.kind,
        `${pack.key} should fire, not skip on an unknown gate`,
      ).toBe("fired");
    }
  });

  it("REGRESSION GUARD: dropping personal_baseline_sufficient rejects sleep-recap at schedule()", async () => {
    // Build the registry the way develop shipped BEFORE #9563: every
    // built-in gate EXCEPT the one sleep-recap depends on. Since #11791 the
    // runner refuses to even persist a task referencing an unregistered gate
    // (fail-closed at schedule time, earlier than the fire-time skip this
    // guard originally pinned) — proving the fire test above is load-bearing
    // and would have caught the original bug before any task existed.
    const fullGates = createTaskGateRegistry();
    registerBuiltInGates(fullGates);
    const partialGates = createTaskGateRegistry();
    for (const contribution of fullGates.list()) {
      if (contribution.kind === "personal_baseline_sufficient") continue;
      partialGates.register(contribution);
    }
    expect(partialGates.get("personal_baseline_sufficient")).toBeNull();

    const runner = makeRunner(partialGates);
    const record = sleepRecapDefaultPack.records[0];
    if (!record) throw new Error("sleepRecapDefaultPack should ship a record");

    await expect(fireFirstRecord(runner, record)).rejects.toThrow(
      /shouldFire\.gates\[\d+\]\.kind "personal_baseline_sufficient" is not registered/,
    );
    expect(await runner.list()).toHaveLength(0);
  });
});
