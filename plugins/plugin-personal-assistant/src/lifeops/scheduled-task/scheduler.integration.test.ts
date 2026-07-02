/**
 * Integration tests for the production `processDueScheduledTasks` wrapper.
 *
 * Today's `runner.test.ts` is a harness with injected providers — it does NOT
 * exercise the production wiring path: real `LifeOpsRepository`-backed store,
 * real `GlobalPauseStore`, real `ActivitySignalBus`, real production dispatcher
 * resolved from the live `IAgentRuntime`. This file walks `processDueScheduledTasks`
 * end-to-end against that wiring so wiring drift (e.g. silent dispatcher
 * swaps, lost log rows, mis-keyed pause cache, broken gate registration order)
 * is caught by a fast in-process test rather than a manual smoke.
 *
 * Tests are intentionally tied to the production tick wrapper at
 * `scheduler.ts:88-204` — the same path the W1 scheduler service-mixin and the
 * mobile `/api/background/run-due-tasks` route both call.
 */

import { EventType, logger, type Memory, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { createGlobalPauseStore } from "../global-pause/store.ts";
import { resolvePendingPromptsStore } from "../pending-prompts/store.ts";
import { LifeOpsRepository } from "../repository.ts";
import {
  APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
  type ScheduledTask,
} from "./index.ts";
import { registerLifeOpsScheduledTaskSubjectStore } from "./runtime-wiring.ts";
import { processDueScheduledTasks } from "./scheduler.ts";
import { getScheduledTaskRunner } from "./service.ts";

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

describe("processDueScheduledTasks — production wiring", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  beforeEach(() => {
    runtimeResult = null;
  });

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("fires a due one-shot reminder via the real runner wired through LifeOpsRepository", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const fireAt = "2026-05-09T12:00:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Drink a glass of water.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      ownerVisible: true,
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.fires).toHaveLength(1);
    const fired = result.fires[0];
    expect(fired?.taskId).toBe(seed.taskId);
    expect(fired?.status).toBe("fired");
    expect(fired?.reason).toBe("once_due");
    expect(fired?.occurrenceAtIso).toBe(fireAt);

    // Round-trip through the DB to confirm the production runner persisted the
    // transition (and didn't only update in-memory state).
    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
    expect(persisted?.state.firedAt).toBeDefined();

    const log = await repo.listScheduledTaskLog({
      agentId: runtime.agentId,
      taskId: seed.taskId,
    });
    const transitions = log.map((entry) => entry.transition);
    expect(transitions).toContain("fired");
  });

  it("respectsGlobalPause via the real GlobalPauseStore: paused tasks skip, then fire after clear()", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const fireAt = "2026-05-09T12:00:00.000Z";
    const tickAt = new Date("2026-05-09T12:01:00.000Z");

    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Pause-respecting reminder.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      ownerVisible: true,
    });

    // Engage the pause via the SAME store the production runner consults.
    const pause = createGlobalPauseStore(runtime);
    await pause.set({
      startIso: "2026-05-09T11:00:00.000Z",
      endIso: "2026-05-09T20:00:00.000Z",
      reason: "vacation",
    });
    const status = await pause.current(tickAt);
    expect(status.active).toBe(true);
    expect(status.reason).toBe("vacation");

    const skippedResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });
    expect(skippedResult.errors).toEqual([]);
    expect(skippedResult.fires).toHaveLength(1);
    expect(skippedResult.fires[0]?.taskId).toBe(seed.taskId);
    // processDueScheduledTasks reports the runner's outcome regardless of
    // skipped/fired; the runner's own state is the source of truth for
    // pause-handling. Read it back and assert the skip + reason.
    const repo = new LifeOpsRepository(runtime);
    const skipped = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.state.lastDecisionLog).toContain("global_pause");

    // Clear the pause; tick again; task should now fire.
    await pause.clear();
    expect((await pause.current(tickAt)).active).toBe(false);

    // The runner already saw the task as terminal (skipped); processDueScheduledTasks
    // does not refire one-shot tasks once they've transitioned out of "scheduled".
    // To prove the wiring goes through the pause check correctly when the gate
    // is open, schedule a sibling task and tick.
    const sibling = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Sibling reminder (post-clear).",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      ownerVisible: true,
    });
    const tickAfter = new Date("2026-05-09T12:02:00.000Z");
    const fireResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAfter,
      limit: 5,
    });
    expect(fireResult.errors).toEqual([]);
    const firedSibling = fireResult.fires.find(
      (f) => f.taskId === sibling.taskId,
    );
    expect(firedSibling?.status).toBe("fired");
    const persistedSibling = await repo.getScheduledTask(
      runtime.agentId,
      sibling.taskId,
    );
    expect(persistedSibling?.state.status).toBe("fired");
  });

  // The atomic claim (`LifeOpsRepository.claimScheduledTaskForFire`, the
  // `claimForFire` seam wired at runner.ts:1041) does
  // `UPDATE … WHERE status='scheduled' RETURNING *` so exactly one parallel
  // tick flips `scheduled` → `fired`; the loser matches zero rows and the
  // runner reports `{ kind: "raced" }`. `handleFireResult` drops the raced
  // outcome without recording a fire, so both invariants below hold: one
  // fire across both tick results, and one "fired" state-log row.
  it("two parallel ticks on the same ready task fire it exactly once", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const fireAt = "2026-05-09T12:00:00.000Z";
    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Concurrent fire reminder.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
    });

    const [a, b] = await Promise.all([
      processDueScheduledTasks({
        runtime,
        agentId: runtime.agentId,
        now: tickAt,
        limit: 5,
      }),
      processDueScheduledTasks({
        runtime,
        agentId: runtime.agentId,
        now: tickAt,
        limit: 5,
      }),
    ]);

    const allFires = [...a.fires, ...b.fires].filter(
      (f) => f.taskId === seed.taskId,
    );
    // Exactly one tick observes the task as "fired" the moment it transitions;
    // the other sees the row already past `scheduled` and races out.
    expect(allFires).toHaveLength(1);
    expect(allFires[0]?.status).toBe("fired");

    // The losing tick must NOT surface as an error — `raced` is a benign,
    // expected outcome that is silently dropped.
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);

    const repo = new LifeOpsRepository(runtime);
    const log = await repo.listScheduledTaskLog({
      agentId: runtime.agentId,
      taskId: seed.taskId,
    });
    const fired = log.filter((entry) => entry.transition === "fired");
    expect(fired).toHaveLength(1);

    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
  });

  it("fires a recurring checkin (interval) and recomputes next_fire_at", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    // No `firedAt` in state → `intervalDue` returns `interval_first_due`. The
    // seed leaves `next_fire_at` NULL, which the due query treats as a fire
    // candidate.
    const seed = await seedScheduledTask(runtime, {
      kind: "checkin",
      promptInstructions: "How are you feeling this hour?",
      trigger: { kind: "interval", everyMinutes: 60 },
      priority: "low",
      respectsGlobalPause: false,
      source: "default_pack",
      ownerVisible: true,
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    const fired = result.fires.find((f) => f.taskId === seed.taskId);
    expect(fired?.status).toBe("fired");
    expect(fired?.reason).toBe("interval_first_due");

    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
    expect(persisted?.state.firedAt).toBeDefined();

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: seed.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions).toContain("fired");

    // Recurring trigger → the post-fire persist recomputes `next_fire_at`
    // (NOT NULL). The `requireNextFireAt` filter restricts to rows whose
    // indexed `next_fire_at` column survived the fire.
    const withNextFire = await repo.listScheduledTasks(runtime.agentId, {
      status: ["fired"],
      requireNextFireAt: true,
    });
    expect(withNextFire.map((t) => t.taskId)).toContain(seed.taskId);
  });

  it("fires a followup (after_task) via a due scheduled-override", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    // `after_task` triggers are pipeline-driven and never wall-clock due, so
    // the production override path is the only way the tick fires them: a
    // `scheduled` row whose `state.firedAt` (the scheduled-override marker)
    // is already in the past resolves `scheduled_override_due`.
    const overrideAt = "2026-05-09T11:59:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "followup",
      promptInstructions: "Did the earlier task land?",
      trigger: {
        kind: "after_task",
        taskId: "st_parent_does_not_matter",
        outcome: "completed",
      },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      state: {
        status: "scheduled",
        followupCount: 0,
        firedAt: overrideAt,
      },
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    const fired = result.fires.find((f) => f.taskId === seed.taskId);
    expect(fired?.status).toBe("fired");
    expect(fired?.reason).toBe("scheduled_override_due");

    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
    // The atomic claim overwrites the override marker with the real fire
    // instant (the tick clock), so `firedAt` advances to the tick time.
    expect(persisted?.state.firedAt).toBe(tickAt.toISOString());

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: seed.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions).toContain("fired");
  });

  it("fires an approval through runner.schedule and auto-defaults followupAfterMinutes + records a pending prompt", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const fireAt = "2026-05-09T12:00:00.000Z";
    const tickAt = new Date("2026-05-09T12:01:00.000Z");

    // Schedule through the production runner (NOT the raw seed) so the
    // approval-default rule in `applyApprovalCompletionDefault` runs: no
    // explicit `followupAfterMinutes`, no `pipeline.onSkip` → the runner
    // backfills `APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES`.
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => tickAt,
    });
    const scheduled = await runner.schedule({
      kind: "approval",
      promptInstructions: "Approve sending the draft reply?",
      trigger: { kind: "once", atIso: fireAt },
      priority: "high",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
      metadata: { pendingPromptRoomId: "room-approval" },
    });
    expect(scheduled.completionCheck?.followupAfterMinutes).toBe(
      APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
    );

    const repo = new LifeOpsRepository(runtime);
    const persistedSeed = await repo.getScheduledTask(
      runtime.agentId,
      scheduled.taskId,
    );
    expect(persistedSeed?.completionCheck?.followupAfterMinutes).toBe(
      APPROVAL_DEFAULT_FOLLOWUP_AFTER_MINUTES,
    );

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    const fired = result.fires.find((f) => f.taskId === scheduled.taskId);
    expect(fired?.status).toBe("fired");

    const persisted = await repo.getScheduledTask(
      runtime.agentId,
      scheduled.taskId,
    );
    expect(persisted?.state.status).toBe("fired");
    expect(persisted?.state.firedAt).toBeDefined();

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: scheduled.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions).toContain("fired");

    // Approval-kind fires record a pending prompt keyed to the room the
    // approval addressed.
    const recorded = result.pendingPrompts.find(
      (p) => p.taskId === scheduled.taskId,
    );
    expect(recorded?.roomId).toBe("room-approval");
    expect(recorded?.expectedReplyKind).toBe("approval");
  });

  it("completes a fired user_replied_within task from an owner MESSAGE_RECEIVED event", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const ownerId = "owner-11354";
    const roomId = "room-11354-reply";
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId, false);

    const fireAt = "2026-05-09T12:00:00.000Z";
    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => tickAt,
    });
    const scheduled = await runner.schedule({
      kind: "checkin",
      promptInstructions: "How is the morning going?",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
      completionCheck: {
        kind: "user_replied_within",
        followupAfterMinutes: 30,
      },
      metadata: { pendingPromptRoomId: roomId },
    });

    const fireResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });
    expect(fireResult.errors).toEqual([]);
    expect(
      fireResult.fires.find((f) => f.taskId === scheduled.taskId)?.status,
    ).toBe("fired");
    expect(
      (
        await resolvePendingPromptsStore(runtime).list(roomId, {
          now: tickAt,
        })
      ).map((prompt) => prompt.taskId),
    ).toContain(scheduled.taskId);

    const replyAt = "2026-05-09T12:02:00.000Z";
    const message: Memory = {
      id: "msg-11354-reply" as UUID,
      entityId: ownerId as UUID,
      roomId: roomId as UUID,
      createdAt: Date.parse(replyAt),
      content: { text: "I am back online." },
    };
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      message,
      source: "client_chat",
    });

    const repo = new LifeOpsRepository(runtime);
    const completed = await repo.getScheduledTask(
      runtime.agentId,
      scheduled.taskId,
    );
    expect(completed?.state.status).toBe("completed");
    expect(completed?.state.completedAt).toBe(replyAt);
    expect(completed?.state.lastDecisionLog).toBe(
      "completion-check:user_replied_within",
    );
    expect(
      await resolvePendingPromptsStore(runtime).list(roomId, {
        now: new Date(replyAt),
      }),
    ).toEqual([]);
  });

  it("leaves a fired user_replied_within task open when no reply arrived before timeout", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const firedAt = "2026-05-09T12:00:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "checkin",
      promptInstructions: "Check in with the owner.",
      trigger: { kind: "once", atIso: firedAt },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: {
        kind: "user_replied_within",
        followupAfterMinutes: 30,
      },
      metadata: { pendingPromptRoomId: "room-11354-no-reply" },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt,
      },
    });

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T12:10:00.000Z"),
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.completions).toEqual([]);
    expect(result.completionTimeouts).toEqual([]);
    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
  });

  it("completes subject_updated during the production tick before timeout skip", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    registerLifeOpsScheduledTaskSubjectStore(runtime, {
      wasUpdatedSince: async ({ subject, sinceIso }) =>
        subject.kind === "document" &&
        subject.id === "doc-11354" &&
        sinceIso === "2026-05-09T12:00:00.000Z",
    });

    const firedAt = "2026-05-09T12:00:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "watcher",
      promptInstructions: "Watch the document until it changes.",
      trigger: { kind: "event", eventKind: "document.updated" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "plugin",
      ownerVisible: true,
      subject: { kind: "document", id: "doc-11354" },
      completionCheck: {
        kind: "subject_updated",
        followupAfterMinutes: 1,
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
      now: new Date("2026-05-09T12:02:00.000Z"),
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.completions).toEqual([
      {
        taskId: seed.taskId,
        status: "completed",
        reason: "completion-check:subject_updated",
        completionCheckKind: "subject_updated",
      },
    ]);
    expect(result.completionTimeouts).toEqual([]);
    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("completed");
    expect(persisted?.state.completedAt).toBe("2026-05-09T12:02:00.000Z");
  });

  it("fires a watcher (event) via a due scheduled-override", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    // Like `after_task`, an `event` trigger is signal-driven and never
    // wall-clock due; the override marker is the production path that lets a
    // watcher fire on a tick.
    const overrideAt = "2026-05-09T11:59:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "watcher",
      promptInstructions: "Surface the inbound the watcher caught.",
      trigger: { kind: "event", eventKind: "message.received" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "plugin",
      ownerVisible: true,
      state: {
        status: "scheduled",
        followupCount: 0,
        firedAt: overrideAt,
      },
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    const fired = result.fires.find((f) => f.taskId === seed.taskId);
    expect(fired?.status).toBe("fired");
    expect(fired?.reason).toBe("scheduled_override_due");

    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: seed.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions).toContain("fired");
  });

  it("fires an output (once) task and persists the fired transition", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const fireAt = "2026-05-09T12:00:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "output",
      promptInstructions: "Render the daily digest card.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "low",
      respectsGlobalPause: false,
      source: "default_pack",
      ownerVisible: true,
      output: { destination: "in_app_card" },
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    const fired = result.fires.find((f) => f.taskId === seed.taskId);
    expect(fired?.status).toBe("fired");
    expect(fired?.reason).toBe("once_due");

    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
    expect(persisted?.state.firedAt).toBeDefined();

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: seed.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions).toContain("fired");
  });

  it("times out an unanswered approval into skip and spawns the pipeline.onSkip followup", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const repo = new LifeOpsRepository(runtime);
    const fireAt = "2026-05-09T12:00:00.000Z";
    const firstTick = new Date("2026-05-09T12:01:00.000Z");

    // Approval with an EXPLICIT completion timeout and a `pipeline.onSkip`
    // followup. (When `pipeline.onSkip` is set the approval-default rule does
    // NOT backfill `followupAfterMinutes`, so it must be provided.) On the
    // first tick the approval fires; once the timeout elapses a later tick
    // runs the completion-timeout pass, which applies `skip` and propagates
    // the onSkip child.
    const seed = await seedScheduledTask(runtime, {
      kind: "approval",
      promptInstructions: "Approve the wire transfer?",
      trigger: { kind: "once", atIso: fireAt },
      priority: "high",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      pipeline: {
        onSkip: [
          {
            // A fully-shaped ScheduledTask ref; `runPipeline` strips the
            // server-managed fields and re-runs `schedule()` to mint a child.
            taskId: "st_onskip_template",
            kind: "followup",
            promptInstructions: "The approval went stale — nudge the owner.",
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
    });

    const firstResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: firstTick,
      limit: 5,
    });
    expect(firstResult.errors).toEqual([]);
    expect(
      firstResult.fires.find((f) => f.taskId === seed.taskId)?.status,
    ).toBe("fired");
    const afterFire = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(afterFire?.state.status).toBe("fired");

    // Advance past `firedAt + followupAfterMinutes` (30m). The completion
    // timeout pass now fires `skip`.
    const timeoutTick = new Date("2026-05-09T12:40:00.000Z");
    const timeoutResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: timeoutTick,
      limit: 5,
    });
    expect(timeoutResult.errors).toEqual([]);
    const timedOut = timeoutResult.completionTimeouts.find(
      (t) => t.taskId === seed.taskId,
    );
    expect(timedOut?.status).toBe("skipped");
    expect(timedOut?.reason).toBe("completion_timeout_due");

    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("skipped");

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: seed.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions).toContain("skipped");

    // The onSkip followup child is created and linked to the parent.
    const all = await repo.listScheduledTasks(runtime.agentId, {
      kind: "followup",
    });
    const child = all.find((t) => t.state.pipelineParentId === seed.taskId);
    expect(child).toBeDefined();
    expect(child?.kind).toBe("followup");
  });

  it("circadian_state_in gate falls through to allow and the task fires with a warn-once fallback", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    // Spy on the logger so we can observe the gate's warning if this happens
    // to be the first time the in-process gate evaluates. Across vitest
    // workers / test ordering the warning is module-deduped, so we ALSO
    // assert the behavioral fall-through (allow → fire).
    const warnSpy = vi.spyOn(logger, "warn");

    const fireAt = "2026-05-09T12:00:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Circadian-gated reminder.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      shouldFire: {
        compose: "first_deny",
        gates: [{ kind: "circadian_state_in", params: { in: ["awake"] } }],
      },
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    const fired = result.fires.find((f) => f.taskId === seed.taskId);
    expect(fired?.status).toBe("fired");

    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");

    // If the warning happens to fire in this test (first eval in the worker
    // process), the spy should see the diagnostic shape. We accept either
    // outcome — the module-level deduplication is intentional. The
    // behavioral check above proves the fall-through.
    const warningCalls = warnSpy.mock.calls.filter((args) =>
      JSON.stringify(args).includes("circadian_state_in"),
    );
    if (warningCalls.length > 0) {
      const callPayload = JSON.stringify(warningCalls[0]);
      expect(callPayload).toContain("falling through to allow");
    }
    warnSpy.mockRestore();
  });
});
