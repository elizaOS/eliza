// @journey-2
/**
 * J2 — Spine + first-run integration (`UX_JOURNEYS §2 Core data model`).
 *
 * Walks the seam between the W1-A `ScheduledTask` runner and the W1-C
 * first-run flow:
 *   1. Run first-run defaults to seed gm/gn/checkin/morning-brief/local-backup tasks.
 *   2. Confirm the cached fallback records have the expected shape.
 *   3. Wire those records into a fresh in-memory runner and confirm the
 *      runner can apply verbs against them (acknowledge, complete).
 *
 * This is the contract the production code follows: first-run produces
 * `ScheduledTaskInput` records; the runner consumes them; verbs work
 * end-to-end without needing a database.
 */

import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
} from "@elizaos/plugin-scheduling";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  TestNoopScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import {
  FirstRunService,
  readFallbackScheduledTasks,
} from "../src/lifeops/first-run/service.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function makeFreshRunner() {
  const ownerFacts: OwnerFactsView = { timezone: "UTC" };
  const pause: GlobalPauseView = { current: async () => ({ active: false }) };
  const activity: ActivitySignalBusView = { hasSignalSince: () => false };
  const subjectStore: SubjectStoreView = { wasUpdatedSince: () => false };

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

  let counter = 0;
  return createScheduledTaskRunner({
    agentId: "test-agent-spine-first-run",
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation,
    ownerFacts: () => ownerFacts,
    globalPause: pause,
    activity,
    subjectStore,
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `spine_${counter}`;
    },
    now: () => new Date("2026-05-09T08:00:00.000Z"),
  });
}

describe("J2 — spine + first-run integration", () => {
  it("first-run defaults seed task records → spine runner can apply verbs", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = new FirstRunService(runtime);

    // Step 1: ask wake time → status=needs_more_input.
    const ask = await service.runDefaultsPath({});
    expect(ask.status).toBe("needs_more_input");

    // Step 2: provide wake time → completes.
    const done = await service.runDefaultsPath({ wakeTime: "6:30am" });
    expect(done.status).toBe("ok");
    expect(done.scheduledTasks.length).toBe(6);

    const cached = await readFallbackScheduledTasks(runtime);
    expect(cached.length).toBe(6);
    const slots = new Set(
      cached
        .map((t) => t.input.metadata?.slot)
        .filter((s): s is string => typeof s === "string"),
    );
    expect(slots).toEqual(
      new Set([
        "gm",
        "gn",
        "checkin",
        "morningBrief",
        "weeklyReview",
        "localBackup",
      ]),
    );

    // Step 3: pipe the cached inputs into a fresh in-memory runner — this
    // models what the production runner does when it loads cached tasks
    // from disk on boot. The cached inputs come from `wave1-types.ts`'s
    // `ScheduledTaskInput`, which is structurally compatible with the
    // runner's `Omit<ScheduledTask, "taskId" | "state">` (W1-A's typing
    // is the canonical source; the wave1-types stub mirrors it).
    const runner = makeFreshRunner();
    const scheduled: ScheduledTask[] = [];
    for (const cachedRec of cached) {
      const t = await runner.schedule(cachedRec.input);
      scheduled.push(t);
    }
    expect(scheduled.length).toBe(6);
    expect(scheduled.every((t) => t.state.status === "scheduled")).toBe(true);

    // Step 4: apply lifecycle verbs across the seeded tasks.
    const ackTask = scheduled.at(0);
    if (!ackTask) throw new Error("expected an ack task");
    const acknowledged = await runner.apply(ackTask.taskId, "acknowledge");
    expect(acknowledged.state.status).toBe("acknowledged");

    const completeTask = scheduled.at(1);
    if (!completeTask) throw new Error("expected a complete task");
    const completed = await runner.apply(completeTask.taskId, "complete", {
      reason: "user did the thing",
    });
    expect(completed.state.status).toBe("completed");

    const skipTask = scheduled.at(2);
    if (!skipTask) throw new Error("expected a skip task");
    const skipped = await runner.apply(skipTask.taskId, "skip", {
      reason: "user said skip",
    });
    expect(skipped.state.status).toBe("skipped");

    const snoozeTask = scheduled.at(3);
    if (!snoozeTask) throw new Error("expected a snooze task");
    const snoozed = await runner.apply(snoozeTask.taskId, "snooze", {
      minutes: 30,
    });
    expect(snoozed.state.firedAt).toBe("2026-05-09T08:30:00.000Z");
  });

  it("boot seeder feeds the spine runner and is idempotent across two boots", async () => {
    const runtime = createMinimalRuntimeStub();
    // Use the real spine runner (production-shaped) as the FirstRunService
    // runner so boot-seeded inputs flow straight into the scheduler store.
    const runner = makeFreshRunner();
    const service = new FirstRunService(runtime, { runner });

    // First boot on an already-initialized runtime that never ran first-run:
    // the full default pack materializes in the spine store.
    const firstBoot = await service.seedDefaultPackOnBoot();
    expect(firstBoot.seeded.length).toBe(6);
    const afterFirst = await runner.list();
    expect(afterFirst.length).toBe(6);

    // Second boot: per-key marker short-circuits before scheduling, so the
    // spine store still holds exactly six rows (no duplicates).
    const secondBoot = await new FirstRunService(runtime, {
      runner,
    }).seedDefaultPackOnBoot();
    expect(secondBoot.seeded.length).toBe(0);
    expect(secondBoot.skipped.length).toBe(6);
    const afterSecond = await runner.list();
    expect(afterSecond.length).toBe(6);
  });

  it("first-run replay path leaves scheduled inputs idempotent under the runner", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = new FirstRunService(runtime);
    await service.runDefaultsPath({ wakeTime: "6:30am" });
    const cached = await readFallbackScheduledTasks(runtime);

    const runner = makeFreshRunner();
    const firstPass: string[] = [];
    for (const rec of cached) {
      const t = await runner.schedule(rec.input);
      firstPass.push(t.taskId);
    }

    // Replay: schedule same inputs again — idempotency key should dedupe.
    const secondPass: string[] = [];
    for (const rec of cached) {
      const t = await runner.schedule(rec.input);
      secondPass.push(t.taskId);
    }

    // Inputs that have an idempotencyKey should resolve to the same taskId.
    for (let i = 0; i < cached.length; i += 1) {
      if (cached[i]?.input.idempotencyKey) {
        expect(secondPass[i]).toBe(firstPass[i]);
      }
    }
  });
});
