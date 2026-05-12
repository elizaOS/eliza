/**
 * D12 regression: when callers invoke `runner.pipeline(taskId, "failed")` —
 * which is how dispatcher infra-failures and explicit fail-outs surface —
 * the spine must flip the parent task's terminal status to `failed` and
 * propagate `pipeline.onFail` children. Previously the pipeline propagated
 * children but left the parent in `scheduled`, which broke observers that
 * read terminal state to decide downstream behavior.
 */

import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../src/lifeops/scheduled-task/completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../src/lifeops/scheduled-task/consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "../src/lifeops/scheduled-task/escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../src/lifeops/scheduled-task/gate-registry.js";
import {
  ChannelKeyError,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  TestNoopScheduledTaskDispatcher,
} from "../src/lifeops/scheduled-task/runner.js";
import { createInMemoryScheduledTaskLogStore } from "../src/lifeops/scheduled-task/state-log.js";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  ScheduledTask,
  SubjectStoreView,
} from "../src/lifeops/scheduled-task/types.js";

function makeRunner(opts?: { channelKeys?: () => ReadonlySet<string> }) {
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
  const globalPause: GlobalPauseView = {
    current: async () => ({ active: false }),
  };
  const activity: ActivitySignalBusView = { hasSignalSince: () => false };
  const subjectStore: SubjectStoreView = { wasUpdatedSince: () => false };
  let counter = 0;
  return {
    runner: createScheduledTaskRunner({
      agentId: "test-d12",
      store,
      logStore,
      gates,
      completionChecks,
      ladders,
      anchors,
      consolidation,
      ownerFacts: () => ({}),
      globalPause,
      activity,
      subjectStore,
      dispatcher: TestNoopScheduledTaskDispatcher,
      channelKeys: opts?.channelKeys,
      newTaskId: () => {
        counter += 1;
        return `t_${counter}`;
      },
      now: () => new Date("2026-05-09T12:00:00.000Z"),
    }),
    logStore,
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

describe("D12 — pipeline.onFail propagates parent terminal state", () => {
  it("pipeline('failed') flips parent state to failed AND spawns onFail children", async () => {
    const { runner, logStore } = makeRunner();
    const parent = await runner.schedule(
      baseInput({
        kind: "reminder",
        promptInstructions: "sign portal upload before 5pm",
        trigger: { kind: "once", atIso: "2026-05-09T17:00:00.000Z" },
        subject: { kind: "document", id: "doc-w9-2026" },
        priority: "high",
        pipeline: {
          onFail: [
            baseInput({
              kind: "followup",
              promptInstructions: "escalate to backup channel",
            }),
          ],
        },
      }),
    );
    const children = await runner.pipeline(parent.taskId, "failed");
    expect(children).toHaveLength(1);

    const all = await runner.list();
    const updated = all.find((t) => t.taskId === parent.taskId);
    expect(updated?.state.status).toBe("failed");
    expect(updated?.state.lastDecisionLog).toContain("pipeline: failed");

    const child = all.find(
      (t) => t.promptInstructions === "escalate to backup channel",
    );
    expect(child).toBeDefined();
    expect(child?.state.pipelineParentId).toBe(parent.taskId);

    const log = await logStore.list({ agentId: "test-d12", taskId: parent.taskId });
    expect(log.some((l) => l.transition === "failed")).toBe(true);
  });

  it("pipeline('failed') is idempotent on already-terminal parents", async () => {
    const { runner } = makeRunner();
    const parent = await runner.schedule(
      baseInput({
        pipeline: {
          onFail: [baseInput({ promptInstructions: "fail-child" })],
        },
      }),
    );
    await runner.apply(parent.taskId, "complete", { reason: "first" });
    // Parent is now `completed`. A subsequent pipeline("failed") still
    // propagates onFail children but does NOT rewrite the parent's status.
    const children = await runner.pipeline(parent.taskId, "failed");
    expect(children).toHaveLength(1);
    const all = await runner.list();
    const stillCompleted = all.find((t) => t.taskId === parent.taskId);
    expect(stillCompleted?.state.status).toBe("completed");
  });

  it("pipeline('failed') without onFail children still flips parent state", async () => {
    const { runner } = makeRunner();
    const parent = await runner.schedule(baseInput());
    const children = await runner.pipeline(parent.taskId, "failed");
    expect(children).toHaveLength(0);
    const updated = await runner.list();
    expect(updated[0]?.state.status).toBe("failed");
  });
});

describe("A11 — escalation.steps[].channelKey validation", () => {
  it("schedule() throws ChannelKeyError when a channelKey is not registered", async () => {
    const { runner } = makeRunner({
      channelKeys: () => new Set(["in_app", "push"]),
    });
    await expect(
      runner.schedule(
        baseInput({
          escalation: {
            steps: [
              { delayMinutes: 0, channelKey: "in_app" },
              { delayMinutes: 30, channelKey: "carrier_pigeon" },
            ],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ChannelKeyError);
  });

  it("schedule() accepts steps when every channelKey is registered", async () => {
    const { runner } = makeRunner({
      channelKeys: () => new Set(["in_app", "push", "imessage"]),
    });
    const task = await runner.schedule(
      baseInput({
        escalation: {
          steps: [
            { delayMinutes: 0, channelKey: "in_app" },
            { delayMinutes: 15, channelKey: "push" },
            { delayMinutes: 45, channelKey: "imessage" },
          ],
        },
      }),
    );
    expect(task.state.status).toBe("scheduled");
  });

  it("schedule() skips validation when no channelKeys provider is configured", async () => {
    const { runner } = makeRunner();
    const task = await runner.schedule(
      baseInput({
        escalation: {
          steps: [{ delayMinutes: 0, channelKey: "anything" }],
        },
      }),
    );
    expect(task.state.status).toBe("scheduled");
  });
});

describe("A7 — approval-kind default followupAfterMinutes", () => {
  it("schedule() bakes followupAfterMinutes=60 onto approval tasks without an explicit value", async () => {
    const { runner } = makeRunner();
    const task = await runner.schedule(
      baseInput({
        kind: "approval",
        promptInstructions: "approve the booking",
      }),
    );
    expect(task.completionCheck?.kind).toBe("user_acknowledged");
    expect(task.completionCheck?.followupAfterMinutes).toBe(60);
  });

  it("schedule() preserves an explicitly-set followupAfterMinutes for approvals", async () => {
    const { runner } = makeRunner();
    const task = await runner.schedule(
      baseInput({
        kind: "approval",
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: 15,
        },
      }),
    );
    expect(task.completionCheck?.followupAfterMinutes).toBe(15);
  });

  it("schedule() does NOT inject the default when pipeline.onSkip is set", async () => {
    const { runner } = makeRunner();
    const task = await runner.schedule(
      baseInput({
        kind: "approval",
        pipeline: {
          onSkip: [baseInput({ promptInstructions: "child-skip" })],
        },
      }),
    );
    expect(task.completionCheck?.followupAfterMinutes).toBeUndefined();
  });

  it("schedule() does NOT inject the default for non-approval kinds", async () => {
    const { runner } = makeRunner();
    const task = await runner.schedule(baseInput({ kind: "reminder" }));
    expect(task.completionCheck).toBeUndefined();
  });
});
