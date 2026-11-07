/**
 * Retiring occurrences that fell inside an ended global-pause window.
 *
 * An interval task's next due is `firedAt + everyMinutes`, so the runner must
 * park `firedAt` exactly one interval before the first occurrence at or after
 * the pause end. Parking at `end - 1ms` (the cron path) would drop the
 * occurrence at the pause end and shift the interval phase permanently.
 */

import { describe, expect, it } from "vitest";

import { createCompletionCheckRegistry } from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import { createEscalationLadderRegistry } from "./escalation.js";
import { createTaskGateRegistry } from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { ScheduledTaskTrigger } from "./types.js";

const PAUSE_START = "2026-10-12T09:00:00.000Z";

function makeHarness(pauseEndIso: string) {
  let nowIso = "2026-10-12T08:00:00.000Z";
  const dispatchedAt: string[] = [];
  const store = createInMemoryScheduledTaskStore();
  const runner = createScheduledTaskRunner({
    agentId: "test-agent",
    store,
    logStore: createInMemoryScheduledTaskLogStore(),
    gates: createTaskGateRegistry(),
    completionChecks: createCompletionCheckRegistry(),
    ladders: createEscalationLadderRegistry(),
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: {
      current: async (at?: Date) => {
        const atMs = (at ?? new Date(nowIso)).getTime();
        return {
          active:
            atMs >= Date.parse(PAUSE_START) && atMs < Date.parse(pauseEndIso),
          startIso: PAUSE_START,
          endIso: pauseEndIso,
        };
      },
    },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: {
      dispatch: async () => {
        dispatchedAt.push(nowIso);
      },
    },
    now: () => new Date(nowIso),
  });

  return {
    runner,
    store,
    dispatchedAt,
    setNow(iso: string) {
      nowIso = iso;
    },
    /** One scheduler tick, the way the standalone tick drives the runner. */
    async tick(iso: string, taskId: string) {
      nowIso = iso;
      const task = await store.get(taskId);
      if (!task) throw new Error(`missing task ${taskId}`);
      const decision = await runner.resolveDueDecision(task);
      if (!decision.due) return "not_due";
      const fire = await runner.fireWithResult(taskId, {
        cause: "automatic",
        allowTerminalRefire: true,
      });
      return fire.kind;
    },
  };
}

async function scheduleFiredAtEight(
  harness: ReturnType<typeof makeHarness>,
  trigger: ScheduledTaskTrigger,
) {
  harness.setNow("2026-10-12T08:00:00.000Z");
  const task = await harness.runner.schedule({
    kind: "reminder",
    promptInstructions: "hourly check-in",
    trigger,
    priority: "medium",
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: "test-agent",
    ownerVisible: true,
    metadata: { createdAtIso: "2026-10-12T07:00:00.000Z" },
  });
  expect(await harness.tick("2026-10-12T08:00:00.000Z", task.taskId)).toBe(
    "fired",
  );
  return task.taskId;
}

async function nextDueIso(
  harness: ReturnType<typeof makeHarness>,
  taskId: string,
  atIso: string,
): Promise<string | undefined> {
  harness.setNow(atIso);
  const task = await harness.store.get(taskId);
  if (!task) throw new Error(`missing task ${taskId}`);
  const decision = await harness.runner.resolveDueDecision(task);
  return decision.due ? decision.occurrenceAtIso : undefined;
}

describe("ended global pause retirement", () => {
  it("fires the interval occurrence at the pause end on a late tick", async () => {
    const harness = makeHarness("2026-10-12T12:00:00.000Z");
    const taskId = await scheduleFiredAtEight(harness, {
      kind: "interval",
      everyMinutes: 60,
      from: "2026-10-12T08:00:00.000Z",
    });

    // First tick after the pause: the 09:00 occurrence belongs to the pause.
    expect(await harness.tick("2026-10-12T12:30:00.000Z", taskId)).toBe(
      "skipped",
    );
    expect((await harness.store.get(taskId))?.state.firedAt).toBe(
      "2026-10-12T11:00:00.000Z",
    );
    // The 12:00 occurrence (exactly at the pause end) is not dropped.
    expect(await nextDueIso(harness, taskId, "2026-10-12T12:30:00.000Z")).toBe(
      "2026-10-12T12:00:00.000Z",
    );
    expect(await harness.tick("2026-10-12T12:30:00.000Z", taskId)).toBe(
      "fired",
    );
    expect(harness.dispatchedAt).toEqual([
      "2026-10-12T08:00:00.000Z",
      "2026-10-12T12:30:00.000Z",
    ]);
  });

  it("keeps the interval phase when the first tick lands on the pause end", async () => {
    const harness = makeHarness("2026-10-12T12:00:00.000Z");
    const taskId = await scheduleFiredAtEight(harness, {
      kind: "interval",
      everyMinutes: 60,
      from: "2026-10-12T08:00:00.000Z",
    });

    expect(await harness.tick("2026-10-12T12:00:00.000Z", taskId)).toBe(
      "skipped",
    );
    expect(await harness.tick("2026-10-12T12:00:00.000Z", taskId)).toBe(
      "fired",
    );
    // Phase stays on the hour: next due is 13:00, not 12:59:59.999 or later.
    expect(
      await nextDueIso(harness, taskId, "2026-10-12T12:59:59.999Z"),
    ).toBeUndefined();
    expect(await nextDueIso(harness, taskId, "2026-10-12T13:00:00.000Z")).toBe(
      "2026-10-12T13:00:00.000Z",
    );
  });

  it("resumes an interval at the first on-phase occurrence after an off-phase pause end", async () => {
    const harness = makeHarness("2026-10-12T12:30:00.000Z");
    const taskId = await scheduleFiredAtEight(harness, {
      kind: "interval",
      everyMinutes: 60,
      from: "2026-10-12T08:00:00.000Z",
    });

    expect(await harness.tick("2026-10-12T12:45:00.000Z", taskId)).toBe(
      "skipped",
    );
    // 12:00 fell inside the pause and is retired; 13:00 is next.
    expect((await harness.store.get(taskId))?.state.firedAt).toBe(
      "2026-10-12T12:00:00.000Z",
    );
    expect(
      await nextDueIso(harness, taskId, "2026-10-12T12:59:59.999Z"),
    ).toBeUndefined();
    expect(await nextDueIso(harness, taskId, "2026-10-12T13:00:00.000Z")).toBe(
      "2026-10-12T13:00:00.000Z",
    );
    expect(harness.dispatchedAt).toEqual(["2026-10-12T08:00:00.000Z"]);
  });

  it("still retires a cron occurrence inside the window and fires the one at the pause end", async () => {
    const harness = makeHarness("2026-10-12T12:00:00.000Z");
    const taskId = await scheduleFiredAtEight(harness, {
      kind: "cron",
      expression: "0 * * * *",
      tz: "UTC",
    });

    expect(await harness.tick("2026-10-12T12:30:00.000Z", taskId)).toBe(
      "skipped",
    );
    expect((await harness.store.get(taskId))?.state.firedAt).toBe(
      "2026-10-12T11:59:59.999Z",
    );
    expect(await nextDueIso(harness, taskId, "2026-10-12T12:30:00.000Z")).toBe(
      "2026-10-12T12:00:00.000Z",
    );
    expect(await harness.tick("2026-10-12T12:30:00.000Z", taskId)).toBe(
      "fired",
    );
    expect(await nextDueIso(harness, taskId, "2026-10-12T13:00:00.000Z")).toBe(
      "2026-10-12T13:00:00.000Z",
    );
  });
});
