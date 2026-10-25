/**
 * Covers the signature-deadline scheduler: an unsigned document task times out and
 * schedules the SMS escalation follow-up through processDueScheduledTasks. DB-backed test
 * runtime.
 */
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { processDueScheduledTasks } from "../src/lifeops/scheduled-task/scheduler.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

interface ScheduledTaskSeed
  extends Omit<ScheduledTask, "taskId" | "state" | "createdBy"> {
  taskId?: string;
  createdBy?: string;
  state?: ScheduledTask["state"];
}

async function seedScheduledTask(
  runtime: RealTestRuntimeResult["runtime"],
  seed: ScheduledTaskSeed,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: seed.taskId ?? `st_test_${Math.random().toString(36).slice(2, 10)}`,
    kind: seed.kind,
    promptInstructions: seed.promptInstructions,
    trigger: seed.trigger,
    priority: seed.priority,
    respectsGlobalPause: seed.respectsGlobalPause,
    source: seed.source,
    createdBy: seed.createdBy ?? runtime.agentId,
    ownerVisible: seed.ownerVisible,
    state: seed.state ?? { status: "scheduled", followupCount: 0 },
    ...(seed.shouldFire ? { shouldFire: seed.shouldFire } : {}),
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

describe("signature deadline scheduler", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("times out an unsigned document task and schedules the SMS escalation follow-up", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const firedAt = "2026-05-09T08:00:00.000Z";
    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const seed = await seedScheduledTask(runtime, {
      taskId: "st_signature_deadline",
      kind: "reminder",
      promptInstructions: "Confirm the NDA is signed before the appointment.",
      trigger: { kind: "once", atIso: firedAt },
      priority: "high",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: {
        kind: "subject_updated",
        followupAfterMinutes: 240,
      },
      subject: { kind: "document", id: "doc_nda_123" },
      pipeline: {
        onSkip: [
          {
            kind: "followup",
            promptInstructions:
              "SMS escalation: NDA remains unsigned 4 hours before the appointment.",
            trigger: { kind: "manual" },
            priority: "high",
            respectsGlobalPause: false,
            // The escalation follow-up is authored by the same user request as
            // the parent; "system" was never a member of ScheduledTaskSource
            // and is rejected by the #11791 input validation.
            source: "user_chat",
            createdBy: runtime.agentId,
            ownerVisible: true,
            subject: { kind: "document", id: "doc_nda_123" },
            output: { destination: "channel", target: "sms:+15555550100" },
          },
        ],
      },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt,
      },
    });

    const repo = new LifeOpsRepository(runtime);

    // First completion timeout does NOT skip: the no-reply retry ladder
    // (#14459/#15055/#12284) snoozes the reminder for one 60-minute retry
    // (`reminder` default policy: maxRetries 1, cadence [60], terminal skip →
    // `no_reply_reminder_expired`) before giving up. `onSkip` only runs on the
    // TERMINAL skip, so the SMS escalation is deferred until the ladder is
    // exhausted — it is not scheduled on this first tick.
    const firstTick = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(firstTick.errors).toEqual([]);
    expect(firstTick.completionTimeouts).toEqual([
      {
        taskId: seed.taskId,
        status: "scheduled",
        reason: "no_reply_retry_1",
        occurrenceAtIso: "2026-05-09T12:00:00.000Z",
      },
    ]);
    const afterRetry = await repo.getScheduledTask(
      runtime.agentId,
      seed.taskId,
    );
    expect(afterRetry?.state.status).toBe("scheduled");
    expect(afterRetry?.state.lastDecisionLog).toBe(
      "no_reply_retry_1: completion_timeout_due",
    );
    expect(
      (
        await repo.listScheduledTasks(runtime.agentId, {
          status: ["scheduled"],
          subjectKind: "document",
          subjectId: "doc_nda_123",
        })
      ).find((task) => task.state.pipelineParentId === seed.taskId),
    ).toBeUndefined();

    // The snooze re-fires the reminder at the retry instant (60 min later), so
    // it is `fired` again and its completion window restarts.
    const refireAt = new Date("2026-05-09T13:01:30.000Z");
    await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: refireAt,
      limit: 5,
    });
    const refired = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(refired?.state.status).toBe("fired");

    // Second completion timeout (240 min past the re-fire) exhausts the ladder:
    // retryCount now equals maxRetries, so the reminder terminally skips and the
    // `onSkip` SMS escalation follow-up is finally scheduled.
    const terminalTick = new Date("2026-05-09T17:05:00.000Z");
    const finalResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: terminalTick,
      limit: 5,
    });

    expect(finalResult.errors).toEqual([]);
    expect(finalResult.completionTimeouts).toEqual([
      {
        taskId: seed.taskId,
        status: "skipped",
        reason: "no_reply_reminder_expired",
        occurrenceAtIso: "2026-05-09T17:01:30.000Z",
      },
    ]);

    const parent = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(parent?.state.status).toBe("skipped");
    expect(parent?.state.lastDecisionLog).toBe("no_reply_reminder_expired");

    const tasks = await repo.listScheduledTasks(runtime.agentId, {
      status: ["scheduled"],
      subjectKind: "document",
      subjectId: "doc_nda_123",
    });
    const escalation = tasks.find(
      (task) => task.state.pipelineParentId === seed.taskId,
    );
    expect(escalation).toMatchObject({
      kind: "followup",
      priority: "high",
      output: { destination: "channel", target: "sms:+15555550100" },
    });
    expect(escalation?.promptInstructions).toContain("NDA remains unsigned");
  });
});
