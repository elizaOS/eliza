/**
 * A9 — `trigger.kind: "after_task"` chain-after-terminal coverage.
 *
 * The spine schema accepts `trigger: { kind: "after_task"; taskId; outcome }`
 * with `outcome: TerminalState` (`completed | skipped | expired | failed |
 * dismissed`). The runner does NOT auto-fire from `after_task` triggers — the
 * scheduler tick is the entry point, and the in-memory test fixture has no
 * tick. These tests therefore lock down the **structural acceptance** plus
 * the schedule-time semantics: the child task is persisted with the
 * `after_task` trigger pointing at the parent, and remains in `scheduled`
 * even after the parent reaches the recorded terminal outcome.
 *
 * If a future runner gains an `after_task` evaluator, the
 * "child does not auto-fire" assertion below is the contract that needs to
 * change first — making this file the canonical seam.
 */

import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { GlobalPauseView, ScheduledTask, TerminalState } from "./types.js";

function makeRunner(): {
  runner: ScheduledTaskRunnerHandle;
  setNow: (iso: string) => void;
} {
  let nowIso = "2026-05-09T12:00:00.000Z";
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: "test-agent",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({}),
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
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
  promptInstructions: "do the thing",
  trigger: { kind: "manual" },
  priority: "medium",
  respectsGlobalPause: true,
  source: "user_chat",
  createdBy: "tester",
  ownerVisible: true,
  ...overrides,
});

async function forceParentTerminal(
  runner: ScheduledTaskRunnerHandle,
  parentId: string,
  outcome: TerminalState,
): Promise<void> {
  switch (outcome) {
    case "completed":
      await runner.apply(parentId, "complete", { reason: "test" });
      return;
    case "skipped":
      await runner.apply(parentId, "skip", { reason: "test" });
      return;
    case "dismissed":
      await runner.apply(parentId, "dismiss", { reason: "test" });
      return;
    case "expired":
    case "failed":
      // No public verb; pipeline() flips the parent state when the outcome is
      // dispatched without a prior matching apply().
      await runner.pipeline(parentId, outcome);
      return;
  }
}

const TERMINAL_OUTCOMES: TerminalState[] = [
  "completed",
  "skipped",
  "dismissed",
  "expired",
  "failed",
];

describe("ScheduledTaskRunner — after_task trigger structural acceptance (A9)", () => {
  for (const outcome of TERMINAL_OUTCOMES) {
    it(`accepts a child trigger after_task<${outcome}> and persists the parent linkage`, async () => {
      const { runner } = makeRunner();
      const parent = await runner.schedule(baseInput());
      const child = await runner.schedule(
        baseInput({
          promptInstructions: `chain after ${outcome}`,
          trigger: { kind: "after_task", taskId: parent.taskId, outcome },
        }),
      );
      expect(child.state.status).toBe("scheduled");
      expect(child.trigger.kind).toBe("after_task");
      if (child.trigger.kind !== "after_task") {
        throw new Error("trigger kind narrowing failed");
      }
      expect(child.trigger.taskId).toBe(parent.taskId);
      expect(child.trigger.outcome).toBe(outcome);
    });
  }

  for (const outcome of TERMINAL_OUTCOMES) {
    it(`child does NOT auto-fire when the parent reaches ${outcome} (no scheduler-tick in fixture)`, async () => {
      const { runner } = makeRunner();
      const parent = await runner.schedule(baseInput());
      const child = await runner.schedule(
        baseInput({
          promptInstructions: `chain after ${outcome}`,
          trigger: { kind: "after_task", taskId: parent.taskId, outcome },
        }),
      );

      await forceParentTerminal(runner, parent.taskId, outcome);

      const reloadedParent = (await runner.list()).find(
        (t) => t.taskId === parent.taskId,
      );
      expect(reloadedParent?.state.status).toBe(outcome);

      const reloadedChild = (await runner.list()).find(
        (t) => t.taskId === child.taskId,
      );
      expect(reloadedChild?.state.status).toBe("scheduled");
      expect(reloadedChild?.state.firedAt).toBeUndefined();
    });
  }
});

describe("ScheduledTaskRunner — after_task trigger fire path is verb-driven (A9)", () => {
  it("manual fire() of the child still works regardless of parent state — runner does not consult after_task at fire time", async () => {
    const { runner } = makeRunner();
    const parent = await runner.schedule(baseInput());
    const child = await runner.schedule(
      baseInput({
        promptInstructions: "chain after completed",
        trigger: {
          kind: "after_task",
          taskId: parent.taskId,
          outcome: "completed",
        },
      }),
    );
    // Parent still scheduled; firing the child directly should still work
    // because fire() runs gates + dispatches without inspecting the trigger
    // kind. This locks the documented invariant: trigger kind drives the
    // scheduler tick, not the fire path.
    const fired = await runner.fire(child.taskId);
    expect(fired.state.status).toBe("fired");
  });
});
