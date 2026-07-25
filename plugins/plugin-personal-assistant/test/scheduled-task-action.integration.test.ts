/**
 * `SCHEDULED_TASK` action unit tests.
 *
 * Drives the umbrella action through its main verbs (create, list, complete,
 * snooze) against a real `LifeOpsRepository`-backed runner via the same
 * runtime helper used by other lifeops action tests. No LLM. No mocks for
 * the runner — the action talks to the production wiring and we assert the
 * round-trip.
 */

import type { Memory, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { scheduledTaskAction } from "../src/actions/scheduled-task.ts";
import type { ScheduledTask } from "../src/lifeops/scheduled-task/index.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

function ownerMessage(agentId: UUID, text: string): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}` as UUID,
    entityId: agentId,
    roomId: agentId,
    agentId,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

// Owner-chat reminder creates delegate to the OWNER_REMINDERS definition flow
// (routing contract in scheduled-task.ts); only autonomy-sourced messages keep
// the raw scheduler surface this file exercises. Creates therefore arrive as
// autonomy messages, the way background automations schedule their own work.
function autonomyMessage(agentId: UUID, text: string): Memory {
  const message = ownerMessage(agentId, text);
  message.content.source = "autonomy";
  return message;
}

describe("SCHEDULED_TASK action", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("create → list → complete → snooze round-trip via the registered runner", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const created = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "schedule a reminder"),
      undefined,
      {
        parameters: {
          subaction: "create",
          kind: "reminder",
          promptInstructions: "drink a glass of water",
          trigger: { kind: "manual" },
          priority: "medium",
        },
      },
      undefined,
      [],
    );
    expect(created?.success).toBe(true);
    const createdTask = (created?.data as { task?: ScheduledTask } | undefined)
      ?.task;
    expect(createdTask?.kind).toBe("reminder");
    expect(createdTask?.state.status).toBe("scheduled");
    const taskId = createdTask?.taskId;
    if (!taskId) throw new Error("create did not return a taskId");

    // list
    const listed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "what scheduled tasks do i have?"),
      undefined,
      { parameters: { subaction: "list", kind: "reminder" } },
      undefined,
      [],
    );
    expect(listed?.success).toBe(true);
    const tasks = (listed?.data as { tasks?: ScheduledTask[] } | undefined)
      ?.tasks;
    if (!tasks) throw new Error("list did not return scheduled tasks");
    expect(tasks.some((task) => task.taskId === taskId)).toBe(true);

    // snooze 30m
    const snoozed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "snooze it"),
      undefined,
      { parameters: { subaction: "snooze", taskId, minutes: 30 } },
      undefined,
      [],
    );
    expect(snoozed?.success).toBe(true);
    const snoozedTask = (snoozed?.data as { task?: ScheduledTask } | undefined)
      ?.task;
    expect(snoozedTask?.state.lastDecisionLog).toMatch(/snoozed until/);

    // complete
    const completed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "done"),
      undefined,
      { parameters: { subaction: "complete", taskId, reason: "done by user" } },
      undefined,
      [],
    );
    expect(completed?.success).toBe(true);
    const completedTask = (
      completed?.data as { task?: ScheduledTask } | undefined
    )?.task;
    expect(completedTask?.state.status).toBe("completed");
  });

  it("rejects missing-subaction calls cleanly", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const result = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "do something"),
      undefined,
      { parameters: {} },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string } | undefined)?.error).toBe(
      "MISSING_SUBACTION",
    );
  });

  it("rejects malformed LLM-supplied gate structure before writing a row (#11791)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const result = await scheduledTaskAction.handler?.(
      runtime,
      autonomyMessage(runtime.agentId, "schedule a gated reminder"),
      undefined,
      {
        parameters: {
          subaction: "create",
          kind: "reminder",
          promptInstructions: "drink a glass of water",
          trigger: { kind: "manual" },
          priority: "medium",
          shouldFire: {
            gates: [{ kind: "not_registered", params: {} }],
          },
        },
      },
      undefined,
      [],
    );

    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string } | undefined)?.error).toBe(
      "INVALID_SCHEDULED_TASK",
    );
    expect(
      JSON.stringify(
        (result?.data as { issues?: string[] } | undefined)?.issues,
      ),
    ).toContain("not_registered");

    const listed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "list scheduled tasks"),
      undefined,
      { parameters: { subaction: "list" } },
      undefined,
      [],
    );
    const tasks = (listed?.data as { tasks?: ScheduledTask[] } | undefined)
      ?.tasks;
    if (!tasks) throw new Error("list did not return scheduled tasks");
    // First-run defaults seed check-in/watcher/recap/output tasks on a fresh
    // runtime; the rejected create must not have written its reminder row.
    expect(tasks.filter((task) => task.kind === "reminder")).toHaveLength(0);
  });

  it("get returns NOT_FOUND for an unknown taskId", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const result = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "get task"),
      undefined,
      { parameters: { subaction: "get", taskId: "st_nonexistent" } },
      undefined,
      [],
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string } | undefined)?.error).toBe(
      "NOT_FOUND",
    );
  });

  // Recap turns ask for history without naming a task; that call used to hard
  // fail MISSING_TASK_ID and derail the whole read-then-summarize turn
  // (#16935). Id-less history now spans all scheduled items.
  it("history without a taskId returns recent entries across all scheduled items", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const taskIds: string[] = [];
    for (const instructions of ["sort the receipts", "reply to Jordan"]) {
      const created = await scheduledTaskAction.handler?.(
        runtime,
        autonomyMessage(runtime.agentId, `remind me to ${instructions}`),
        undefined,
        {
          parameters: {
            subaction: "create",
            kind: "reminder",
            promptInstructions: instructions,
            trigger: { kind: "manual" },
            priority: "medium",
          },
        },
        undefined,
        [],
      );
      expect(created?.success).toBe(true);
      const task = (created?.data as { task?: ScheduledTask } | undefined)
        ?.task;
      if (!task) throw new Error("create did not return a task");
      taskIds.push(task.taskId);
    }
    const completed = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "done sorting"),
      undefined,
      {
        parameters: {
          subaction: "complete",
          taskId: taskIds[0],
          reason: "done this morning",
        },
      },
      undefined,
      [],
    );
    expect(completed?.success).toBe(true);

    const history = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "what happened with my reminders today?"),
      undefined,
      { parameters: { subaction: "history" } },
      undefined,
      [],
    );
    expect(history?.success).toBe(true);
    const entries = (
      history?.data as
        | { entries?: Array<{ taskId: string; eventType?: string }> }
        | undefined
    )?.entries;
    if (!entries) throw new Error("history did not return entries");
    // Entries from BOTH tasks are present — the read spans the whole ledger.
    const seenTaskIds = new Set(entries.map((entry) => entry.taskId));
    expect(seenTaskIds.has(taskIds[0])).toBe(true);
    expect(seenTaskIds.has(taskIds[1])).toBe(true);

    // Single-task reads keep their narrowing contract.
    const scoped = await scheduledTaskAction.handler?.(
      runtime,
      ownerMessage(runtime.agentId, "history for the receipts reminder"),
      undefined,
      { parameters: { subaction: "history", taskId: taskIds[0] } },
      undefined,
      [],
    );
    expect(scoped?.success).toBe(true);
    const scopedEntries = (
      scoped?.data as { entries?: Array<{ taskId: string }> } | undefined
    )?.entries;
    if (!scopedEntries)
      throw new Error("scoped history did not return entries");
    expect(scopedEntries.length).toBeGreaterThan(0);
    expect(scopedEntries.every((entry) => entry.taskId === taskIds[0])).toBe(
      true,
    );
  });
});
