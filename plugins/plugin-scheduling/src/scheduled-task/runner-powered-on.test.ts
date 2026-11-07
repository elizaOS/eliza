/**
 * Powered-on scheduling for scheduled tasks.
 *
 * A phone-resident agent runs only while the device is on. An occurrence of a
 * recurring task that came due while the agent was not running is recorded
 * once as missed and never dispatched late; the next occurrence the agent is
 * running for still fires. A delay while the agent was running still fires.
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
  MISSED_OCCURRENCE_DECISION,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { ScheduledTaskTrigger } from "./types.js";

function makeHarness(opts: { poweredOn: boolean }) {
  let nowIso = "2026-10-12T08:00:00.000Z";
  let startedIso = "2026-10-12T07:00:00.000Z";
  const dispatchedAt: string[] = [];
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();
  const runner = createScheduledTaskRunner({
    agentId: "test-agent",
    store,
    logStore,
    gates: createTaskGateRegistry(),
    completionChecks: createCompletionCheckRegistry(),
    ladders: createEscalationLadderRegistry(),
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: {
      dispatch: async () => {
        dispatchedAt.push(nowIso);
      },
    },
    ...(opts.poweredOn
      ? {
          poweredOnScheduling: {
            agentStartedAtMs: () => Date.parse(startedIso),
          },
        }
      : {}),
    now: () => new Date(nowIso),
  });

  return {
    runner,
    store,
    logStore,
    dispatchedAt,
    setNow(iso: string) {
      nowIso = iso;
    },
    /** The agent process restarts at this instant (device powered back on). */
    restart(iso: string) {
      startedIso = iso;
      nowIso = iso;
    },
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

const HOURLY: ScheduledTaskTrigger = {
  kind: "interval",
  everyMinutes: 60,
  from: "2026-10-12T08:00:00.000Z",
};

describe("powered-on scheduled tasks", () => {
  it("records a power-off backlog once and fires the next occurrence on time", async () => {
    const harness = makeHarness({ poweredOn: true });
    const taskId = await scheduleFiredAtEight(harness, HOURLY);

    // Powered off from 08:30 to 12:30; 09:00..12:00 passed while stopped.
    harness.restart("2026-10-12T12:30:00.000Z");
    expect(await harness.tick("2026-10-12T12:30:00.000Z", taskId)).toBe(
      "skipped",
    );
    const task = await harness.store.get(taskId);
    expect(task?.state.lastDecisionLog).toBe(MISSED_OCCURRENCE_DECISION);
    expect(task?.state.firedAt).toBe("2026-10-12T12:00:00.000Z");
    // No backlog: the following tick has nothing due until 13:00.
    expect(await harness.tick("2026-10-12T12:31:00.000Z", taskId)).toBe(
      "not_due",
    );
    expect(await harness.tick("2026-10-12T13:00:30.000Z", taskId)).toBe(
      "fired",
    );
    expect(harness.dispatchedAt).toEqual([
      "2026-10-12T08:00:00.000Z",
      "2026-10-12T13:00:30.000Z",
    ]);
    const skips = (
      await harness.logStore.list({ agentId: "test-agent", taskId })
    ).filter((row) => row.transition === "skipped");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.reason).toBe(MISSED_OCCURRENCE_DECISION);
  });

  it("still fires an occurrence delayed while the agent was running", async () => {
    const harness = makeHarness({ poweredOn: true });
    const taskId = await scheduleFiredAtEight(harness, HOURLY);
    // Running since 07:00; the 09:00 tick is reached 10 minutes late (doze).
    expect(await harness.tick("2026-10-12T09:10:00.000Z", taskId)).toBe(
      "fired",
    );
    expect(harness.dispatchedAt).toHaveLength(2);
  });

  it("fires an occurrence reached inside the window right after a restart", async () => {
    const harness = makeHarness({ poweredOn: true });
    const taskId = await scheduleFiredAtEight(harness, HOURLY);
    harness.restart("2026-10-12T09:00:30.000Z");
    expect(await harness.tick("2026-10-12T09:01:00.000Z", taskId)).toBe(
      "fired",
    );
  });

  it("keeps the owner's manual run available for a missed occurrence", async () => {
    const harness = makeHarness({ poweredOn: true });
    const taskId = await scheduleFiredAtEight(harness, HOURLY);
    harness.restart("2026-10-12T12:30:00.000Z");
    const manual = await harness.runner.fireWithResult(taskId, {
      cause: "manual",
      allowTerminalRefire: true,
    });
    expect(manual.kind).toBe("fired");
    expect(harness.dispatchedAt).toEqual([
      "2026-10-12T08:00:00.000Z",
      "2026-10-12T12:30:00.000Z",
    ]);
  });

  it("records a missed cron occurrence and arms the next one", async () => {
    const harness = makeHarness({ poweredOn: true });
    const taskId = await scheduleFiredAtEight(harness, {
      kind: "cron",
      expression: "0 * * * *",
      tz: "UTC",
    });
    harness.restart("2026-10-12T12:30:00.000Z");
    expect(await harness.tick("2026-10-12T12:30:00.000Z", taskId)).toBe(
      "skipped",
    );
    expect(await harness.tick("2026-10-12T12:45:00.000Z", taskId)).toBe(
      "not_due",
    );
    expect(await harness.tick("2026-10-12T13:00:10.000Z", taskId)).toBe(
      "fired",
    );
    expect(harness.dispatchedAt).toEqual([
      "2026-10-12T08:00:00.000Z",
      "2026-10-12T13:00:10.000Z",
    ]);
  });

  it("runs late occurrences on hosts without powered-on scheduling", async () => {
    const harness = makeHarness({ poweredOn: false });
    const taskId = await scheduleFiredAtEight(harness, HOURLY);
    harness.restart("2026-10-12T12:30:00.000Z");
    expect(await harness.tick("2026-10-12T12:30:00.000Z", taskId)).toBe(
      "fired",
    );
  });
});
