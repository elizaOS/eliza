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
    id: ("msg-" + Math.random().toString(36).slice(2, 8)) as UUID,
    entityId: agentId,
    roomId: agentId,
    agentId,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
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
      ownerMessage(runtime.agentId, "schedule a reminder"),
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
    const createdTask = (created?.data as { task?: ScheduledTask }).task;
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
    const tasks = (listed?.data as { tasks?: ScheduledTask[] }).tasks ?? [];
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
    const snoozedTask = (snoozed?.data as { task?: ScheduledTask }).task;
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
    const completedTask = (completed?.data as { task?: ScheduledTask }).task;
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
    expect(
      (result?.data as { error?: string } | undefined)?.error,
    ).toBe("MISSING_SUBACTION");
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
    expect(
      (result?.data as { error?: string } | undefined)?.error,
    ).toBe("NOT_FOUND");
  });
});
