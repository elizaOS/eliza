/**
 * `trigger.kind: "after_task"` — chain-after-terminal contract.
 *
 * CONTRACT CHANGE (#10721/#10723 trigger-realness wave): the previous
 * revision of this file pinned that the runner does NOT auto-fire `after_task`
 * children, making the trigger kind contract larp — schema-accepted, never
 * fired by anything. The trigger is live in the SCHEDULED_TASKS action (users
 * create chains from chat without editing the parent) and is NOT redundant
 * with `pipeline.on*`: pipeline refs are declared on the PARENT and only
 * propagate completed/skipped/failed, while `after_task` is declared on the
 * CHILD and covers all five terminal outcomes. The runner now fires matching
 * children on the parent's terminal transition (`settleTerminal` /
 * `fireAfterTaskChildren` in runner.ts), race-safe via the store's atomic
 * fire claim.
 *
 * These tests lock the new contract: structural acceptance, auto-fire on the
 * matching outcome, no fire on mismatched outcome/parent, and the documented
 * global-pause exception (pause suppresses chaining).
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

function makeRunner(opts: { pauseActive?: boolean } = {}): {
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
      current: async () => ({ active: opts.pauseActive === true }),
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

async function getTask(
  runner: ScheduledTaskRunnerHandle,
  taskId: string,
): Promise<ScheduledTask> {
  const found = (await runner.list()).find((t) => t.taskId === taskId);
  if (!found) throw new Error(`task ${taskId} not found`);
  return found;
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
});

describe("ScheduledTaskRunner — after_task children fire on the parent's terminal transition", () => {
  for (const outcome of TERMINAL_OUTCOMES) {
    it(`auto-fires the child when the parent reaches ${outcome}`, async () => {
      const { runner } = makeRunner();
      const parent = await runner.schedule(baseInput());
      const child = await runner.schedule(
        baseInput({
          promptInstructions: `chain after ${outcome}`,
          trigger: { kind: "after_task", taskId: parent.taskId, outcome },
        }),
      );

      await forceParentTerminal(runner, parent.taskId, outcome);

      expect((await getTask(runner, parent.taskId)).state.status).toBe(outcome);
      const reloadedChild = await getTask(runner, child.taskId);
      expect(reloadedChild.state.status).toBe("fired");
      expect(reloadedChild.state.firedAt).toBe("2026-05-09T12:00:00.000Z");
    });
  }

  it("does not fire a child whose recorded outcome mismatches the transition", async () => {
    const { runner } = makeRunner();
    const parent = await runner.schedule(baseInput());
    const onFailure = await runner.schedule(
      baseInput({
        promptInstructions: "chain after failed",
        trigger: {
          kind: "after_task",
          taskId: parent.taskId,
          outcome: "failed",
        },
      }),
    );

    await runner.apply(parent.taskId, "complete", { reason: "test" });

    expect((await getTask(runner, onFailure.taskId)).state.status).toBe(
      "scheduled",
    );
  });

  it("does not fire a child pointing at a different parent", async () => {
    const { runner } = makeRunner();
    const parent = await runner.schedule(baseInput());
    const otherParent = await runner.schedule(baseInput());
    const child = await runner.schedule(
      baseInput({
        trigger: {
          kind: "after_task",
          taskId: otherParent.taskId,
          outcome: "completed",
        },
      }),
    );

    await runner.apply(parent.taskId, "complete", { reason: "test" });

    expect((await getTask(runner, child.taskId)).state.status).toBe(
      "scheduled",
    );
  });

  it("fires every child chained on the same parent + outcome", async () => {
    const { runner } = makeRunner();
    const parent = await runner.schedule(baseInput());
    const first = await runner.schedule(
      baseInput({
        trigger: {
          kind: "after_task",
          taskId: parent.taskId,
          outcome: "completed",
        },
      }),
    );
    const second = await runner.schedule(
      baseInput({
        trigger: {
          kind: "after_task",
          taskId: parent.taskId,
          outcome: "completed",
        },
      }),
    );

    await runner.apply(parent.taskId, "complete", { reason: "test" });

    expect((await getTask(runner, first.taskId)).state.status).toBe("fired");
    expect((await getTask(runner, second.taskId)).state.status).toBe("fired");
  });

  it("chains transitively: grandchild fires when the fired child later completes", async () => {
    const { runner } = makeRunner();
    const parent = await runner.schedule(baseInput());
    const child = await runner.schedule(
      baseInput({
        trigger: {
          kind: "after_task",
          taskId: parent.taskId,
          outcome: "completed",
        },
      }),
    );
    const grandchild = await runner.schedule(
      baseInput({
        trigger: {
          kind: "after_task",
          taskId: child.taskId,
          outcome: "completed",
        },
      }),
    );

    await runner.apply(parent.taskId, "complete", { reason: "test" });
    expect((await getTask(runner, child.taskId)).state.status).toBe("fired");
    expect((await getTask(runner, grandchild.taskId)).state.status).toBe(
      "scheduled",
    );

    await runner.apply(child.taskId, "complete", { reason: "test" });
    expect((await getTask(runner, grandchild.taskId)).state.status).toBe(
      "fired",
    );
  });

  it("global-pause skip does NOT chain: pause suppresses proactive behavior", async () => {
    const { runner } = makeRunner({ pauseActive: true });
    const parent = await runner.schedule(
      baseInput({ respectsGlobalPause: true }),
    );
    const child = await runner.schedule(
      baseInput({
        trigger: {
          kind: "after_task",
          taskId: parent.taskId,
          outcome: "skipped",
        },
      }),
    );

    const result = await runner.fireWithResult(parent.taskId);
    expect(result.kind).toBe("skipped");
    expect((await getTask(runner, parent.taskId)).state.status).toBe("skipped");
    expect((await getTask(runner, child.taskId)).state.status).toBe(
      "scheduled",
    );
  });
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
