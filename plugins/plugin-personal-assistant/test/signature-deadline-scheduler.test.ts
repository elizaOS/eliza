import { afterEach, describe, expect, it } from "vitest";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { processDueScheduledTasks } from "../src/lifeops/scheduled-task/scheduler.ts";
import type { ScheduledTask } from "../src/lifeops/scheduled-task/types.ts";
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
            source: "system",
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

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.completionTimeouts).toEqual([
      {
        taskId: seed.taskId,
        status: "skipped",
        reason: "completion_timeout_due",
        occurrenceAtIso: "2026-05-09T12:00:00.000Z",
      },
    ]);

    const repo = new LifeOpsRepository(runtime);
    const parent = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(parent?.state.status).toBe("skipped");
    expect(parent?.state.lastDecisionLog).toBe("completion_timeout_due");

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
