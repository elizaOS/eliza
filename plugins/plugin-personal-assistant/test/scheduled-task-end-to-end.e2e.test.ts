// @journey-3
/**
 * J3 — ScheduledTask end-to-end e2e (`UX_JOURNEYS §3 Habits`).
 *
 * Drives the W1-A `ScheduledTask` spine through the full lifecycle:
 *   create-from-chat → fire → verb → pipeline → completion → reopen.
 *
 * No LLM. The verb/pipeline/idempotency tests use the in-memory store +
 * runner with the built-in gates / completion-checks / escalation ladders,
 * so any future regression to verb semantics, pipeline routing,
 * terminal-state rules, or idempotency surfaces here. The global-pause test
 * runs the REAL production tick (`processDueScheduledTasks` over a
 * PGlite-backed runtime with an injected clock) so pause enforcement is
 * exercised on the actual fire path, not a stub.
 */

import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
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
import { createGlobalPauseStore } from "../src/lifeops/global-pause/store.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { processDueScheduledTasks } from "../src/lifeops/scheduled-task/scheduler.js";
import { getScheduledTaskRunner } from "../src/lifeops/scheduled-task/service.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

interface Harness {
  runner: ScheduledTaskRunnerHandle;
  setNow(iso: string): void;
}

function makeRunner(initialIso = "2026-05-09T08:00:00.000Z"): Harness {
  let nowIso = initialIso;
  const ownerFacts: OwnerFactsView = { timezone: "UTC" };
  const pause: GlobalPauseView = { current: async () => ({ active: false }) };
  const activity: ActivitySignalBusView = { hasSignalSince: () => false };
  const subjectStore: SubjectStoreView = { wasUpdatedSince: () => false };

  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const anchors = createAnchorRegistry();
  const consolidation = createConsolidationRegistry();
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();

  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: "test-agent-st-e2e",
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: () => ownerFacts,
    globalPause: pause,
    activity,
    subjectStore,
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `st_${counter}`;
    },
    now: () => new Date(nowIso),
  });

  return {
    runner,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

const baseInput = (
  overrides: Partial<Omit<ScheduledTask, "taskId" | "state">> = {},
): Omit<ScheduledTask, "taskId" | "state"> => ({
  kind: "reminder",
  promptInstructions: "drink water",
  trigger: { kind: "manual" },
  priority: "medium",
  respectsGlobalPause: true,
  source: "user_chat",
  createdBy: "tester",
  ownerVisible: true,
  ...overrides,
});

describe("J3 — ScheduledTask spine end-to-end", () => {
  it("create-from-chat → schedule → status=scheduled", async () => {
    const h = makeRunner();
    const created = await h.runner.schedule(
      baseInput({ promptInstructions: "drink a glass of water" }),
    );
    expect(created.state.status).toBe("scheduled");
    expect(created.state.followupCount).toBe(0);
    expect(created.taskId).toMatch(/^st_/);
  });

  it("acknowledge → status=acknowledged (non-terminal); pipeline.onComplete does NOT fire", async () => {
    const h = makeRunner();
    const childInput = baseInput({ promptInstructions: "child of completion" });
    const parent = await h.runner.schedule(
      baseInput({
        promptInstructions: "drink water",
        pipeline: { onComplete: [childInput as never] },
      }),
    );
    const ack = await h.runner.apply(parent.taskId, "acknowledge");
    expect(ack.state.status).toBe("acknowledged");
    // No child created on acknowledge — invariant from runner §7.6.
    const all = await h.runner.list();
    expect(
      all.some((t) => t.promptInstructions === "child of completion"),
    ).toBe(false);
  });

  it("complete → terminal; pipeline.onComplete fires; reopen brings task back", async () => {
    const h = makeRunner();
    const followupInput = baseInput({
      promptInstructions: "followup after habit",
    });
    const parent = await h.runner.schedule(
      baseInput({
        promptInstructions: "habit fire",
        pipeline: { onComplete: [followupInput as never] },
      }),
    );

    // Fire then complete → child schedules.
    const completed = await h.runner.apply(parent.taskId, "complete", {
      reason: "done",
    });
    expect(completed.state.status).toBe("completed");
    expect(completed.state.completedAt).toBeDefined();

    const all = await h.runner.list();
    const child = all.find(
      (t) => t.promptInstructions === "followup after habit",
    );
    expect(child).toBeDefined();
    expect(child?.state.pipelineParentId).toBe(parent.taskId);

    // reopen brings it back to `scheduled`.
    const reopened = await h.runner.apply(parent.taskId, "reopen");
    expect(reopened.state.status).toBe("scheduled");
  });

  it("snooze sets a future fire and resets escalation cursor (§7.7)", async () => {
    const h = makeRunner("2026-05-09T08:00:00.000Z");
    const t = await h.runner.schedule(
      baseInput({ priority: "high", promptInstructions: "high prio fire" }),
    );
    const snoozed = await h.runner.apply(t.taskId, "snooze", { minutes: 45 });
    expect(snoozed.state.status).toBe("scheduled");
    expect(snoozed.state.firedAt).toBe("2026-05-09T08:45:00.000Z");
    const cursor = snoozed.metadata?.escalationCursor as
      | { stepIndex: number }
      | undefined;
    expect(cursor?.stepIndex).toBe(-1);
  });

  it("skip moves to skipped + fires pipeline.onSkip child", async () => {
    const h = makeRunner();
    const childInput = baseInput({ promptInstructions: "skip-followup" });
    const parent = await h.runner.schedule(
      baseInput({
        promptInstructions: "primary",
        pipeline: { onSkip: [childInput as never] },
      }),
    );
    const skipped = await h.runner.apply(parent.taskId, "skip", {
      reason: "user said skip",
    });
    expect(skipped.state.status).toBe("skipped");
    const all = await h.runner.list();
    expect(all.some((t) => t.promptInstructions === "skip-followup")).toBe(
      true,
    );
  });

  it("dismiss is a clean terminal — no children, no escalation", async () => {
    const h = makeRunner();
    const childInput = baseInput({ promptInstructions: "should-not-appear" });
    const t = await h.runner.schedule(
      baseInput({
        promptInstructions: "dismiss-target",
        pipeline: { onComplete: [childInput as never] },
      }),
    );
    const dismissed = await h.runner.apply(t.taskId, "dismiss");
    expect(dismissed.state.status).toBe("dismissed");
    const all = await h.runner.list();
    expect(all.some((x) => x.promptInstructions === "should-not-appear")).toBe(
      false,
    );
  });

  it("idempotencyKey dedupes — second schedule returns the first taskId", async () => {
    const h = makeRunner();
    const a = await h.runner.schedule(
      baseInput({ idempotencyKey: "habit-water-default-pack" }),
    );
    const b = await h.runner.schedule(
      baseInput({
        idempotencyKey: "habit-water-default-pack",
        priority: "high", // ignored
      }),
    );
    expect(b.taskId).toBe(a.taskId);
    expect(b.priority).toBe("medium");
  });

  it("global pause end-to-end: emergency fires during pause, paused occurrence skips, recurrence fires after unpause", async () => {
    // Real DB runtime (PGlite + production wiring), injected tick clock —
    // same pattern as src/lifeops/scheduled-task/scheduler.integration.test.ts.
    // A previous version of this test never ticked anything: it activated a
    // stub pause flag and then asserted `apply("complete")` works, which is
    // true whether or not the runner honors the pause.
    const runtimeResult = await createLifeOpsTestRuntime();
    try {
      const { runtime } = runtimeResult;
      const agentId = runtime.agentId;
      const repo = new LifeOpsRepository(runtime);

      // Create-from-chat spine: schedule through the REAL runner.
      const scheduleAt = new Date("2026-05-09T08:00:00.000Z");
      const runner = getScheduledTaskRunner(runtime, {
        agentId,
        now: () => scheduleAt,
      });
      // A routine recurring check-in that respects the pause. Recurring, so
      // the paused occurrence is skipped but the row keeps a trigger-derived
      // `next_fire_at` and refires after the pause clears.
      const routine = await runner.schedule({
        kind: "checkin",
        promptInstructions: "hourly hydration check",
        trigger: { kind: "interval", everyMinutes: 60 },
        priority: "medium",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: agentId,
        ownerVisible: true,
      });
      // An emergency one-shot that must cut through the pause.
      const emergency = await runner.schedule({
        kind: "reminder",
        promptInstructions: "take the heart medication now",
        trigger: { kind: "once", atIso: "2026-05-09T08:30:00.000Z" },
        priority: "high",
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: agentId,
        ownerVisible: true,
      });
      expect(routine.state.status).toBe("scheduled");
      expect(emergency.state.status).toBe("scheduled");

      // Pause globally via the SAME store the production runner consults.
      const pause = createGlobalPauseStore(runtime);
      await pause.set({
        startIso: "2026-05-09T08:10:00.000Z",
        reason: "vacation",
      });

      // Tick inside the pause window: the emergency fires, the routine skips.
      const pausedTick = new Date("2026-05-09T09:00:00.000Z");
      expect((await pause.current(pausedTick)).active).toBe(true);
      const pausedResult = await processDueScheduledTasks({
        runtime,
        agentId,
        now: pausedTick,
        limit: 10,
      });
      expect(pausedResult.errors).toEqual([]);

      const skippedRoutine = await repo.getScheduledTask(
        agentId,
        routine.taskId,
      );
      expect(skippedRoutine?.state.status).toBe("skipped");
      expect(skippedRoutine?.state.lastDecisionLog).toContain("global_pause");

      const firedEmergency = await repo.getScheduledTask(
        agentId,
        emergency.taskId,
      );
      expect(firedEmergency?.state.status).toBe("fired");
      expect(firedEmergency?.state.firedAt).toBeDefined();

      // Unpause; the next tick refires the routine's next occurrence through
      // the recurrence-refire claim. The settled emergency stays fired.
      await pause.clear();
      const resumedTick = new Date("2026-05-09T10:00:00.000Z");
      expect((await pause.current(resumedTick)).active).toBe(false);
      const resumedResult = await processDueScheduledTasks({
        runtime,
        agentId,
        now: resumedTick,
        limit: 10,
      });
      expect(resumedResult.errors).toEqual([]);
      const routineFire = resumedResult.fires.find(
        (f) => f.taskId === routine.taskId,
      );
      expect(routineFire?.status).toBe("fired");

      const refiredRoutine = await repo.getScheduledTask(
        agentId,
        routine.taskId,
      );
      expect(refiredRoutine?.state.status).toBe("fired");
      expect(refiredRoutine?.state.firedAt).toBe(resumedTick.toISOString());

      // Full transition history from the real state log: skipped under
      // pause, fired after clear.
      const routineTransitions = (
        await repo.listScheduledTaskLog({ agentId, taskId: routine.taskId })
      ).map((entry) => entry.transition);
      expect(routineTransitions).toContain("skipped");
      expect(routineTransitions).toContain("fired");

      // The emergency fired exactly once — during the pause, never again.
      const emergencyFired = (
        await repo.listScheduledTaskLog({ agentId, taskId: emergency.taskId })
      ).filter((entry) => entry.transition === "fired");
      expect(emergencyFired).toHaveLength(1);
    } finally {
      await runtimeResult.cleanup();
    }
  });
});
