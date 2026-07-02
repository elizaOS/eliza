/**
 * Finding: the BLOCK_RULE_RECONCILE task worker was registered but no Task
 * row was ever created, so the reconciler never ran — until_todo gates never
 * released, fixed_duration rules never deactivated, and auto re-lock was
 * unreachable.
 *
 * This suite proves the persisted task exists (idempotently) and that the
 * REAL core `TaskService.runTick` fires the worker on its repeat interval
 * under a fake clock, releasing a gated rule and cleaning the real temp
 * hosts file end to end.
 */

import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskService } from "../../../../../../packages/core/src/services/task.ts";
import {
  BLOCK_RULE_RECONCILE_INTERVAL_MS,
  BLOCK_RULE_RECONCILE_TASK_NAME,
  ensureBlockRuleReconcileTask,
  registerBlockRuleReconcilerWorker,
} from "../block-rule-reconciler.js";
import { BlockRuleReader, BlockRuleWriter } from "../block-rule-service.js";
import {
  type BlockRuleTestHarness,
  completeTodo,
  createBlockRuleHarness,
  seedTodo,
} from "./test-harness.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000eeee" as UUID;
const T0 = Date.parse("2026-07-01T10:00:00.000Z");

async function queueTasks(runtime: IAgentRuntime): Promise<Task[]> {
  return runtime.getTasks({ tags: ["queue"], agentIds: [runtime.agentId] });
}

describe("BLOCK_RULE_RECONCILE task through the real core task tick", () => {
  let harness: BlockRuleTestHarness;

  beforeEach(async () => {
    // Fake only Date so PGlite / fs keep their real async machinery.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    harness = await createBlockRuleHarness(AGENT_ID);
  });

  afterEach(async () => {
    await harness.close();
    vi.useRealTimers();
  });

  it("ensureBlockRuleReconcileTask persists one repeating task row, idempotently", async () => {
    const taskId = await ensureBlockRuleReconcileTask(harness.runtime);
    const task = harness.tasks.get(taskId);
    expect(task).toBeDefined();
    expect(task?.name).toBe(BLOCK_RULE_RECONCILE_TASK_NAME);
    expect(task?.tags).toContain("queue");
    // Without the repeat tag the core tick deletes the task after one run.
    expect(task?.tags).toContain("repeat");
    expect(task?.metadata?.updateInterval).toBe(
      BLOCK_RULE_RECONCILE_INTERVAL_MS,
    );

    const secondId = await ensureBlockRuleReconcileTask(harness.runtime);
    expect(secondId).toBe(taskId);
    expect(harness.tasks.size).toBe(1);
  });

  it("the real TaskService.runTick fires the worker on interval and it releases a fulfilled gate", async () => {
    registerBlockRuleReconcilerWorker(harness.runtime);
    const taskId = await ensureBlockRuleReconcileTask(harness.runtime);

    await seedTodo(harness, { id: "todo-tick-1", title: "Tick me" });
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);
    const ruleId = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-tick-1",
    });
    expect(harness.readHosts()).toContain("0.0.0.0 x.com");
    await completeTodo(harness, "todo-tick-1");

    const service = new TaskService(harness.runtime);

    // Interval not yet elapsed: the tick must NOT run the worker.
    await service.runTick(await queueTasks(harness.runtime));
    expect((await reader.getBlockRuleById(ruleId))?.active).toBe(true);

    // Advance past the repeat interval: the tick runs the reconciler, the
    // fulfilled gate releases the rule, and the OS block is removed.
    vi.setSystemTime(T0 + BLOCK_RULE_RECONCILE_INTERVAL_MS + 1_000);
    await service.runTick(await queueTasks(harness.runtime));

    const rule = await reader.getBlockRuleById(ruleId);
    expect(rule?.active).toBe(false);
    expect(rule?.releasedReason).toBe("todo_completed");
    expect(harness.readHosts()).not.toContain("eliza-selfcontrol");

    // Repeat semantics: the task row survives the run and records it.
    const task = harness.tasks.get(taskId);
    expect(task).toBeDefined();
    expect(task?.metadata?.updatedAt).toBe(
      T0 + BLOCK_RULE_RECONCILE_INTERVAL_MS + 1_000,
    );
  });
});
