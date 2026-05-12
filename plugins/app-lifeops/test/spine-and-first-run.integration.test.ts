// @journey-2
/**
 * J2 — Spine + first-run integration (`UX_JOURNEYS §2 Core data model`).
 *
 * Walks the seam between the W1-A `ScheduledTask` runner and the W1-C
 * first-run flow:
 *   1. Run first-run defaults to seed gm/gn/checkin/morning-brief tasks.
 *   2. Confirm the cached fallback records have the expected shape.
 *   3. Wire those records into a fresh in-memory runner and confirm the
 *      runner can apply verbs against them (acknowledge, complete).
 *
 * This is the contract the production code follows: first-run produces
 * `ScheduledTaskInput` records; the runner consumes them; verbs work
 * end-to-end without needing a database.
 */

import { describe, expect, it } from "vitest";
import {
  FirstRunService,
  readFallbackScheduledTasks,
} from "../src/lifeops/first-run/service.ts";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../src/lifeops/scheduled-task/completion-check-registry.ts";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../src/lifeops/scheduled-task/consolidation-policy.ts";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "../src/lifeops/scheduled-task/escalation.ts";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../src/lifeops/scheduled-task/gate-registry.ts";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  TestNoopScheduledTaskDispatcher,
} from "../src/lifeops/scheduled-task/runner.ts";
import { createInMemoryScheduledTaskLogStore } from "../src/lifeops/scheduled-task/state-log.ts";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  ScheduledTask,
  SubjectStoreView,
} from "../src/lifeops/scheduled-task/types.ts";
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
  it("first-run defaults seed four task records → spine runner can apply verbs", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = new FirstRunService(runtime);

    // Step 1: ask wake time → status=needs_more_input.
    const ask = await service.runDefaultsPath({});
    expect(ask.status).toBe("needs_more_input");

    // Step 2: provide wake time → completes.
    const done = await service.runDefaultsPath({ wakeTime: "6:30am" });
    expect(done.status).toBe("ok");
    expect(done.scheduledTasks.length).toBe(4);

    const cached = await readFallbackScheduledTasks(runtime);
    expect(cached.length).toBe(4);
    const slots = new Set(
      cached
        .map((t) => t.input.metadata?.slot)
        .filter((s): s is string => typeof s === "string"),
    );
    expect(slots).toEqual(new Set(["gm", "gn", "checkin", "morningBrief"]));

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
    expect(scheduled.length).toBe(4);
    expect(scheduled.every((t) => t.state.status === "scheduled")).toBe(true);

    // Step 4: apply lifecycle verbs across the seeded tasks.
    const ackTask = scheduled[0]!;
    const acknowledged = await runner.apply(ackTask.taskId, "acknowledge");
    expect(acknowledged.state.status).toBe("acknowledged");

    const completeTask = scheduled[1]!;
    const completed = await runner.apply(completeTask.taskId, "complete", {
      reason: "user did the thing",
    });
    expect(completed.state.status).toBe("completed");

    const skipTask = scheduled[2]!;
    const skipped = await runner.apply(skipTask.taskId, "skip", {
      reason: "user said skip",
    });
    expect(skipped.state.status).toBe("skipped");

    const snoozeTask = scheduled[3]!;
    const snoozed = await runner.apply(snoozeTask.taskId, "snooze", {
      minutes: 30,
    });
    expect(snoozed.state.firedAt).toBe("2026-05-09T08:30:00.000Z");
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
      if (cached[i]!.input.idempotencyKey) {
        expect(secondPass[i]).toBe(firstPass[i]);
      }
    }
  });
});
