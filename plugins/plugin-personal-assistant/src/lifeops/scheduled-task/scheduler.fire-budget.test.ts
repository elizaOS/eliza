/**
 * Unit-lane regression for #10723 (runs in the gating `test` lane, unlike the
 * `.integration.test.ts` sibling which the package config excludes). Proves the
 * completion-timeout housekeeping pass and the user-facing due-fire pass each
 * get their OWN per-tick budget, so a saturating timeout burst can never starve
 * a due reminder (a dropped notification). Uses the REAL LifeOpsRepository +
 * runtime — no mock of the unit under test.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
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
  state?: ScheduledTask["state"];
}
async function seed(
  runtime: RealTestRuntimeResult["runtime"],
  s: Seed,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: s.taskId ?? `st_${Math.random().toString(36).slice(2, 10)}`,
    kind: s.kind,
    promptInstructions: s.promptInstructions,
    trigger: s.trigger,
    priority: s.priority,
    respectsGlobalPause: s.respectsGlobalPause,
    source: s.source,
    createdBy: runtime.agentId,
    ownerVisible: s.ownerVisible,
    state: s.state ?? { status: "scheduled", followupCount: 0 },
    ...(s.completionCheck ? { completionCheck: s.completionCheck } : {}),
  } as ScheduledTask;
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

describe("processDueScheduledTasks — fire-budget fairness (#10723)", () => {
  it("a full completion-timeout burst does NOT starve a due user-facing fire", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const limit = 3;
    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const staleFiredAt = "2026-05-09T11:00:00.000Z";
    for (let i = 0; i < limit; i++) {
      await seed(runtime, {
        taskId: `st_timeout_${i}`,
        kind: "approval",
        promptInstructions: `Stale approval ${i}.`,
        trigger: { kind: "once", atIso: staleFiredAt },
        priority: "high",
        respectsGlobalPause: false,
        source: "user_chat",
        ownerVisible: true,
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: 30,
        },
        state: { status: "fired", followupCount: 0, firedAt: staleFiredAt },
      });
    }
    const reminder = await seed(runtime, {
      kind: "reminder",
      promptInstructions: "Take your medication.",
      trigger: { kind: "once", atIso: "2026-05-09T12:00:00.000Z" },
      priority: "high",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
    });

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit,
    });

    expect(result.errors).toEqual([]);
    // Timeout pass fully consumed its OWN budget…
    expect(result.completionTimeouts).toHaveLength(limit);
    // …and the due reminder STILL fired the same tick (starved under the old
    // shared budget).
    const fired = result.fires.find((f) => f.taskId === reminder.taskId);
    expect(fired?.status).toBe("fired");

    const persisted = await repo.getScheduledTask(
      runtime.agentId,
      reminder.taskId,
    );
    expect(persisted?.state.status).toBe("fired");
  });
});
