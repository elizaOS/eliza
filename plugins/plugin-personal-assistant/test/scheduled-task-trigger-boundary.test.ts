/**
 * LLM-tolerant trigger boundary + duplicate guard for SCHEDULED_TASKS create
 * (#10721 / #10723).
 *
 * Found by hand-reviewing a LIVE trajectory
 * (test-results/evidence/10757-cli-live-lane/report.json): the model
 * naturally emitted `{type:"cron", schedule:"0 8,21 * * *"}` and
 * `{kind:"cron", cron:"…"}` — the first bounced with a bare MISSING_TRIGGER,
 * the second passed the old kind-only check and blew up inside the runner as
 * an unlabeled `success:false` (`expression.trim` throw). It then created a
 * SECOND identical reminder on the next turn under a different
 * idempotencyKey. These tests pin the boundary: aliases normalize, incomplete
 * triggers keep teaching details in structured data instead of user copy, and
 * an identical active task is returned instead of duplicated.
 */

import type { Memory, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { scheduledTaskAction } from "../src/actions/scheduled-task.ts";
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

type CreateParams = Record<string, unknown>;

async function runScheduledTaskAction(
  runtime: RealTestRuntimeResult["runtime"],
  parameters: Record<string, unknown>,
) {
  return scheduledTaskAction.handler?.(
    runtime,
    ownerMessage(runtime.agentId, "scheduled-task operation"),
    undefined,
    { parameters },
    undefined,
    [],
  );
}

async function create(
  runtime: RealTestRuntimeResult["runtime"],
  parameters: CreateParams,
) {
  return runScheduledTaskAction(runtime, {
    subaction: "create",
    ...parameters,
  });
}

function expectPlainScheduledTaskText(text: string | undefined): void {
  expect(text).toBeDefined();
  expect(text).not.toMatch(
    /ISO-8601|promptInstructions|trigger type|taskId|OWNER_[A-Z_]+|expression|during_window/u,
  );
  expect(text).not.toMatch(/\b(?:st|task)_[a-z0-9_]+\b/u);
}

describe("SCHEDULED_TASKS create — trigger boundary", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("normalizes the observed live shape {type:'cron', schedule:'…'} into a working cron trigger", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Brush your teeth.",
      trigger: { type: "cron", schedule: "0 8,21 * * *", timezone: "UTC" },
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(result.success).toBe(true);
    const task = result.data?.task as {
      trigger: { kind: string; expression: string; tz?: string };
    };
    expect(task.trigger).toEqual({
      kind: "cron",
      expression: "0 8,21 * * *",
      tz: "UTC",
    });
  });

  it("normalizes {kind:'cron', cron:'…'} (the mid-runner-throw shape) instead of exploding", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Water the plants.",
      trigger: { kind: "cron", cron: "0 9 * * *" },
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(result.success).toBe(true);
    const task = result.data?.task as { trigger: { expression: string } };
    expect(task.trigger.expression).toBe("0 9 * * *");
  });

  it("normalizes once-trigger aliases {type:'once', at:'…'}", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Call mom.",
      trigger: { type: "once", at: "2026-07-03T17:00:00.000Z" },
    })) as { success: boolean; text?: string; data?: Record<string, unknown> };
    expect(result.success).toBe(true);
    expectPlainScheduledTaskText(result.text);
    const task = result.data?.task as {
      trigger: { kind: string; atIso: string };
    };
    expect(task.trigger).toEqual({
      kind: "once",
      atIso: "2026-07-03T17:00:00.000Z",
    });
  });

  it("task-control confirmations keep raw ids out of user-facing text", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const created = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Pay the electric bill.",
      trigger: { type: "once", at: "2026-07-03T17:00:00.000Z" },
    })) as { success: boolean; text?: string; data?: Record<string, unknown> };
    expect(created.success).toBe(true);
    expectPlainScheduledTaskText(created.text);
    const task = created.data?.task as { taskId: string };

    for (const parameters of [
      { subaction: "get", taskId: task.taskId },
      { subaction: "update", taskId: task.taskId, patch: { priority: "low" } },
      { subaction: "history", taskId: task.taskId },
      { subaction: "complete", taskId: task.taskId },
    ]) {
      const result = (await runScheduledTaskAction(runtime, parameters)) as {
        success: boolean;
        text?: string;
      };
      expect(result.success).toBe(true);
      expectPlainScheduledTaskText(result.text);
    }
  });

  it("an incomplete cron trigger fails with structured detail, never a bare success:false", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Take medication.",
      trigger: { kind: "cron" },
    })) as { success: boolean; text?: string; data?: Record<string, unknown> };
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("INVALID_TRIGGER");
    expectPlainScheduledTaskText(result.text);
    expect(result.data?.message).toContain('expression: "<5-field cron>"');
  });

  it("an unparseable once datetime keeps schema detail out of the user-facing message", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Call the dentist.",
      trigger: { kind: "once", atIso: "next thursday-ish" },
    })) as { success: boolean; text?: string; data?: Record<string, unknown> };
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("INVALID_TRIGGER");
    expectPlainScheduledTaskText(result.text);
    expect(result.data?.message).toContain("ISO-8601");
  });

  it("an unknown trigger kind keeps valid-kind detail in data only", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Stretch.",
      trigger: { kind: "daily" },
    })) as { success: boolean; text?: string; data?: Record<string, unknown> };
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("INVALID_TRIGGER");
    expectPlainScheduledTaskText(result.text);
    expect(result.data?.message).toContain("during_window");
  });

  it("an identical active task is returned instead of a duplicate (cross-turn re-ask)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const first = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Remind the owner to brush their teeth.",
      trigger: { kind: "cron", expression: "0 8,21 * * *", tz: "UTC" },
      idempotencyKey: "brush-teeth-daily-8am-9pm",
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(first.success).toBe(true);
    const firstTask = first.data?.task as { taskId: string };

    // Same intent, DIFFERENT idempotency key + alias trigger shape — the
    // exact live failure mode that produced two duplicate reminders.
    const second = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Remind the owner to brush their teeth. ",
      trigger: { type: "cron", cron: "0 8,21 * * *", timezone: "UTC" },
      idempotencyKey: "owner-brush-teeth-daily-8am-9pm",
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(second.success).toBe(true);
    expect(second.data?.deduplicated).toBe(true);
    expectPlainScheduledTaskText(second.text);
    const secondTask = second.data?.task as { taskId: string };
    expect(secondTask.taskId).toBe(firstTask.taskId);
  });

  it("a missing trigger teaches the habit-definition redirect (live gemma retried the raw surface 5x on brush-teeth-basic)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Time to brush your teeth!",
    })) as { success: boolean; text?: string; data?: Record<string, unknown> };
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("MISSING_TRIGGER");
    expectPlainScheduledTaskText(result.text);
    expect(result.data?.repair).toContain("OWNER_ROUTINES");
    expect(result.data?.repair).toContain("action=create");
  });

  it("an invalid trigger also carries the habit-definition redirect", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const result = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Time to brush your teeth!",
      trigger: {},
    })) as { success: boolean; text?: string; data?: Record<string, unknown> };
    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("INVALID_TRIGGER");
    expectPlainScheduledTaskText(result.text);
    expect(result.data?.repair).toContain("OWNER_ROUTINES");
  });

  it("a retried create that reuses the same planner-supplied taskId is idempotent, even with a fresh idempotencyKey and rewritten body", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const first = (await create(runtime, {
      kind: "reminder",
      taskId: "brush-teeth-8am-daily",
      promptInstructions: "Remind the user to brush their teeth.",
      trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
      idempotencyKey: "brush-teeth-8am",
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(first.success).toBe(true);
    const firstTask = first.data?.task as {
      taskId: string;
      metadata?: Record<string, unknown>;
    };
    expect(firstTask.metadata?.plannerTaskId).toBe("brush-teeth-8am-daily");

    // The exact live retry shape: same invented taskId, NEW idempotencyKey,
    // slightly different instructions + trigger.
    const second = (await create(runtime, {
      kind: "reminder",
      taskId: "brush-teeth-8am-daily",
      promptInstructions: "Brush teeth reminder (8 AM).",
      trigger: { kind: "cron", expression: "0 8 * * 1-5", tz: "UTC" },
      idempotencyKey: "brush-teeth-8am-cron",
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(second.success).toBe(true);
    expect(second.data?.deduplicated).toBe(true);
    const secondTask = second.data?.task as { taskId: string };
    expect(secondTask.taskId).toBe(firstTask.taskId);
  });

  it("distinct planner-supplied taskIds still create distinct tasks", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const first = (await create(runtime, {
      kind: "reminder",
      taskId: "brush-teeth-morning",
      promptInstructions: "Brush your teeth (morning).",
      trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
    })) as { success: boolean; data?: Record<string, unknown> };
    const second = (await create(runtime, {
      kind: "reminder",
      taskId: "brush-teeth-evening",
      promptInstructions: "Brush your teeth (evening).",
      trigger: { kind: "cron", expression: "0 21 * * *", tz: "UTC" },
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.data?.deduplicated).toBeUndefined();
    const a = first.data?.task as { taskId: string };
    const b = second.data?.task as { taskId: string };
    expect(b.taskId).not.toBe(a.taskId);
  });

  it("a different trigger time is NOT deduplicated", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const first = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Take out the trash.",
      trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
    })) as { success: boolean; data?: Record<string, unknown> };
    const second = (await create(runtime, {
      kind: "reminder",
      promptInstructions: "Take out the trash.",
      trigger: { kind: "cron", expression: "0 20 * * *", tz: "UTC" },
    })) as { success: boolean; data?: Record<string, unknown> };
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.data?.deduplicated).toBeUndefined();
    const a = first.data?.task as { taskId: string };
    const b = second.data?.task as { taskId: string };
    expect(b.taskId).not.toBe(a.taskId);
  });
});
