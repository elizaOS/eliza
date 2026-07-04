/**
 * Regression coverage for #11793: completion timeouts use structural
 * no-reply policy/state instead of a single unconditional skip.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { resolveOwnerFactStore } from "../owner/fact-store.ts";
import { LifeOpsRepository } from "../repository.ts";
import type { ScheduledTask } from "./index.ts";
import { processDueScheduledTasks } from "./scheduler.ts";

let runtimeResult: RealTestRuntimeResult | undefined;

afterEach(async () => {
  await runtimeResult?.cleanup?.();
  runtimeResult = undefined;
});

interface Seed extends Omit<ScheduledTask, "taskId" | "state" | "createdBy"> {
  taskId?: string;
  createdBy?: string;
  state?: ScheduledTask["state"];
}

async function seedScheduledTask(
  runtime: RealTestRuntimeResult["runtime"],
  seed: Seed,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: seed.taskId ?? `st_${Math.random().toString(36).slice(2, 10)}`,
    kind: seed.kind,
    promptInstructions: seed.promptInstructions,
    trigger: seed.trigger,
    priority: seed.priority,
    respectsGlobalPause: seed.respectsGlobalPause,
    source: seed.source,
    createdBy: seed.createdBy ?? runtime.agentId,
    ownerVisible: seed.ownerVisible,
    state: seed.state ?? { status: "scheduled", followupCount: 0 },
    ...(seed.completionCheck ? { completionCheck: seed.completionCheck } : {}),
    ...(seed.escalation ? { escalation: seed.escalation } : {}),
    ...(seed.output ? { output: seed.output } : {}),
    ...(seed.pipeline ? { pipeline: seed.pipeline } : {}),
    ...(seed.subject ? { subject: seed.subject } : {}),
    ...(seed.idempotencyKey ? { idempotencyKey: seed.idempotencyKey } : {}),
    ...(seed.metadata ? { metadata: seed.metadata } : {}),
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

describe("processDueScheduledTasks — no-reply policy (#11793)", () => {
  it("re-surfaces an unanswered reminder once before terminal skip", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const reminder = await seedScheduledTask(runtime, {
      taskId: "st_no_reply_reminder",
      kind: "reminder",
      promptInstructions: "Take medication.",
      trigger: { kind: "once", atIso: "2026-05-09T11:00:00.000Z" },
      priority: "high",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-09T11:00:00.000Z",
      },
    });

    const retryResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T11:31:00.000Z"),
      limit: 5,
    });

    expect(retryResult.errors).toEqual([]);
    expect(retryResult.completionTimeouts).toEqual([
      {
        taskId: reminder.taskId,
        status: "scheduled",
        reason: "no_reply_retry_1",
        occurrenceAtIso: "2026-05-09T11:30:00.000Z",
      },
    ]);
    const retried = await repo.getScheduledTask(
      runtime.agentId,
      reminder.taskId,
    );
    expect(retried?.trigger).toEqual({
      kind: "once",
      atIso: "2026-05-09T12:31:00.000Z",
    });
    expect(retried?.metadata?.noReplyPolicy).toMatchObject({
      maxRetries: 1,
      retryCadenceMinutes: [60],
      terminalStatus: "skipped",
      terminalReason: "no_reply_reminder_expired",
      allowCrossChannel: false,
      allowNonOwnerNotification: false,
    });
    expect(retried?.metadata?.noReplyState).toMatchObject({
      retryCount: 1,
      lastTimedOutAt: "2026-05-09T11:31:00.000Z",
      nextRetryAt: "2026-05-09T12:31:00.000Z",
    });

    const refireResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T12:32:00.000Z"),
      limit: 5,
    });

    expect(refireResult.errors).toEqual([]);
    expect(refireResult.fires).toEqual([
      {
        taskId: reminder.taskId,
        status: "fired",
        reason: "once_due",
        occurrenceAtIso: "2026-05-09T12:31:00.000Z",
      },
    ]);

    const terminalResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T13:02:00.000Z"),
      limit: 5,
    });

    expect(terminalResult.errors).toEqual([]);
    expect(terminalResult.completionTimeouts).toEqual([
      {
        taskId: reminder.taskId,
        status: "skipped",
        reason: "no_reply_reminder_expired",
        occurrenceAtIso: "2026-05-09T13:02:00.000Z",
      },
    ]);
    const skipped = await repo.getScheduledTask(
      runtime.agentId,
      reminder.taskId,
    );
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.metadata?.noReplyState).toMatchObject({
      retryCount: 1,
      terminalReason: "no_reply_reminder_expired",
      terminalOutcome: "skipped",
    });
  });

  it("expires unanswered non-sensitive approvals instead of firing onSkip", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const approval = await seedScheduledTask(runtime, {
      taskId: "st_no_reply_approval",
      kind: "approval",
      promptInstructions: "Approve the low-risk plan?",
      trigger: { kind: "once", atIso: "2026-05-09T11:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      pipeline: {
        onSkip: [
          {
            taskId: "st_on_skip_template",
            kind: "followup",
            promptInstructions:
              "This should not be created by no-reply expiry.",
            trigger: { kind: "manual" },
            priority: "medium",
            respectsGlobalPause: false,
            source: "user_chat",
            createdBy: runtime.agentId,
            ownerVisible: true,
            state: { status: "scheduled", followupCount: 0 },
          },
        ],
      },
      metadata: {
        noReplyState: { retryCount: 2 },
      },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-09T11:00:00.000Z",
      },
    });

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T11:31:00.000Z"),
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.completionTimeouts).toEqual([
      {
        taskId: approval.taskId,
        status: "expired",
        reason: "no_reply_approval_expired",
        occurrenceAtIso: "2026-05-09T11:30:00.000Z",
      },
    ]);
    const expired = await repo.getScheduledTask(
      runtime.agentId,
      approval.taskId,
    );
    expect(expired?.state.status).toBe("expired");
    expect(expired?.metadata?.noReplyState).toMatchObject({
      retryCount: 2,
      terminalReason: "no_reply_approval_expired",
      terminalOutcome: "expired",
    });
    const followups = await repo.listScheduledTasks(runtime.agentId, {
      kind: "followup",
    });
    expect(
      followups.find((task) => task.state.pipelineParentId === approval.taskId),
    ).toBeUndefined();
  });

  it("fails closed for sensitive approvals without cross-channel or non-owner defaults", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const approval = await seedScheduledTask(runtime, {
      taskId: "st_sensitive_no_reply_approval",
      kind: "approval",
      promptInstructions: "Approve sending the account export?",
      trigger: { kind: "once", atIso: "2026-05-09T11:00:00.000Z" },
      priority: "high",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      output: {
        destination: "channel",
        target: "external-email",
        persistAs: "external_only",
      },
      metadata: {
        privacyClass: "sensitive",
        noReplyState: { retryCount: 1 },
      },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-09T11:00:00.000Z",
      },
    });

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T11:31:00.000Z"),
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.completionTimeouts).toEqual([
      {
        taskId: approval.taskId,
        status: "expired",
        reason: "no_reply_sensitive_denied",
        occurrenceAtIso: "2026-05-09T11:30:00.000Z",
      },
    ]);
    const denied = await repo.getScheduledTask(
      runtime.agentId,
      approval.taskId,
    );
    expect(denied?.state.status).toBe("expired");
    expect(denied?.output).toEqual({
      destination: "channel",
      target: "external-email",
      persistAs: "external_only",
    });
    expect(denied?.metadata?.noReplyPolicy).toMatchObject({
      sensitive: true,
      allowCrossChannel: false,
      allowNonOwnerNotification: false,
      terminalStatus: "expired",
      terminalReason: "no_reply_sensitive_denied",
    });
    expect(denied?.metadata?.noReplyState).toMatchObject({
      retryCount: 1,
      terminalReason: "no_reply_sensitive_denied",
      terminalOutcome: "denied",
    });
  });

  it("keeps legacy timeout skip behavior for custom tasks without a no-reply policy", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const task = await seedScheduledTask(runtime, {
      taskId: "st_custom_completion_timeout",
      kind: "custom",
      promptInstructions: "Custom task with legacy timeout semantics.",
      trigger: { kind: "once", atIso: "2026-05-09T11:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "plugin",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-09T11:00:00.000Z",
      },
    });

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T11:31:00.000Z"),
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.completionTimeouts).toEqual([
      {
        taskId: task.taskId,
        status: "skipped",
        reason: "completion_timeout_due",
        occurrenceAtIso: "2026-05-09T11:30:00.000Z",
      },
    ]);
    const skipped = await repo.getScheduledTask(runtime.agentId, task.taskId);
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.metadata?.noReplyPolicy).toBeUndefined();
  });
});

describe("processDueScheduledTasks — reminder intensity modulates the no-reply loop (#12284)", () => {
  const provenance = {
    source: "policy_action" as const,
    recordedAt: "2026-05-09T10:00:00.000Z",
  };

  async function seedFiredReminder(
    runtime: RealTestRuntimeResult["runtime"],
    priority: ScheduledTask["priority"],
  ): Promise<ScheduledTask> {
    return seedScheduledTask(runtime, {
      taskId: `st_intensity_${Math.random().toString(36).slice(2, 8)}`,
      kind: "reminder",
      promptInstructions: "Take medication.",
      trigger: { kind: "once", atIso: "2026-05-09T11:00:00.000Z" },
      priority,
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-09T11:00:00.000Z",
      },
    });
  }

  const timeoutTick = (runtime: RealTestRuntimeResult["runtime"]) =>
    processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T11:31:00.000Z"),
      limit: 5,
    });

  it("minimal: a fired reminder times out straight to terminal skip, no retry", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);
    await resolveOwnerFactStore(runtime).setReminderIntensity(
      { intensity: "minimal" },
      provenance,
    );
    const reminder = await seedFiredReminder(runtime, "high");

    const result = await timeoutTick(runtime);

    expect(result.errors).toEqual([]);
    // No retry ("no_reply_retry_1"): the first timeout is terminal.
    expect(result.completionTimeouts).toHaveLength(1);
    expect(result.completionTimeouts[0]).toMatchObject({
      taskId: reminder.taskId,
      status: "skipped",
    });
    const skipped = await repo.getScheduledTask(
      runtime.agentId,
      reminder.taskId,
    );
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.metadata?.noReplyPolicy).toMatchObject({
      maxRetries: 0,
      retryCadenceMinutes: [],
    });
  });

  it("persistent: a fired reminder earns an extra nudge before terminal (maxRetries 2)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);
    await resolveOwnerFactStore(runtime).setReminderIntensity(
      { intensity: "persistent" },
      provenance,
    );
    const reminder = await seedFiredReminder(runtime, "high");

    const result = await timeoutTick(runtime);

    expect(result.errors).toEqual([]);
    // Still retries (not terminal), but the policy now carries an extra step.
    expect(result.completionTimeouts).toHaveLength(1);
    expect(result.completionTimeouts[0]).toMatchObject({
      taskId: reminder.taskId,
      status: "scheduled",
      reason: "no_reply_retry_1",
    });
    const retried = await repo.getScheduledTask(
      runtime.agentId,
      reminder.taskId,
    );
    expect(retried?.metadata?.noReplyPolicy).toMatchObject({
      maxRetries: 2,
      retryCadenceMinutes: [60, 60],
    });
  });

  it("high_priority_only: a medium-priority reminder is suppressed to fire-once", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);
    await resolveOwnerFactStore(runtime).setReminderIntensity(
      { intensity: "high_priority_only" },
      provenance,
    );
    const reminder = await seedFiredReminder(runtime, "medium");

    const result = await timeoutTick(runtime);

    expect(result.errors).toEqual([]);
    expect(result.completionTimeouts[0]?.status).toBe("skipped");
    const skipped = await repo.getScheduledTask(
      runtime.agentId,
      reminder.taskId,
    );
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.metadata?.noReplyPolicy).toMatchObject({ maxRetries: 0 });
  });

  it("high_priority_only: a high-priority reminder keeps its default nudge", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);
    await resolveOwnerFactStore(runtime).setReminderIntensity(
      { intensity: "high_priority_only" },
      provenance,
    );
    const reminder = await seedFiredReminder(runtime, "high");

    const result = await timeoutTick(runtime);

    expect(result.errors).toEqual([]);
    expect(result.completionTimeouts[0]?.status).toBe("scheduled");
    const retried = await repo.getScheduledTask(
      runtime.agentId,
      reminder.taskId,
    );
    expect(retried?.metadata?.noReplyPolicy).toMatchObject({ maxRetries: 1 });
  });
});
