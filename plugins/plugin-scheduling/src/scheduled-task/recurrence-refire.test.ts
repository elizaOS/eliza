/** Exercises recurrence claims, due boundaries and next-fire persistence using the real in-memory runner. */
import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  type ScheduledTaskStore,
  type ScheduledTaskUpsertOptions,
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
import {
  createInMemoryScheduledTaskLogStore,
  type ScheduledTaskLogStore,
} from "./state-log.js";
import type { ScheduledTask } from "./types.js";

interface Harness {
  runner: ScheduledTaskRunnerHandle;
  store: ScheduledTaskStore;
  logStore: ScheduledTaskLogStore;
  upserts: Array<{ taskId: string; nextFireAtIso: string | null }>;
  setNow(iso: string): void;
}

function makeHarness(initialIso = "2026-05-09T09:00:00.000Z"): Harness {
  let nowIso = initialIso;
  const upserts: Array<{ taskId: string; nextFireAtIso: string | null }> = [];

  const inner = createInMemoryScheduledTaskStore();
  const store: ScheduledTaskStore = {
    ...inner,
    async upsert(task: ScheduledTask, options?: ScheduledTaskUpsertOptions) {
      upserts.push({
        taskId: task.taskId,
        nextFireAtIso: options?.nextFireAtIso ?? null,
      });
      return inner.upsert(task, options);
    },
  };
  const logStore = createInMemoryScheduledTaskLogStore();
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: "test-agent-refire",
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({
      timezone: "UTC",
      morningWindow: { start: "07:00", end: "10:00" },
    }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `refire_task_${counter}`;
    },
    now: () => new Date(nowIso),
  });

  return {
    runner,
    store,
    logStore,
    upserts,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

const dailyCronInput = (
  overrides: Partial<Omit<ScheduledTask, "taskId" | "state">> = {},
): Omit<ScheduledTask, "taskId" | "state"> => ({
  kind: "checkin",
  promptInstructions: "daily check-in",
  trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
  priority: "medium",
  respectsGlobalPause: false,
  source: "default_pack",
  createdBy: "tester",
  ownerVisible: true,
  ...overrides,
});

async function firedLogCount(h: Harness, taskId: string): Promise<number> {
  const rows = await h.logStore.list({
    agentId: "test-agent-refire",
    taskId,
  });
  return rows.filter((r) => r.transition === "fired").length;
}

function lastUpsertFor(h: Harness, taskId: string): string | null {
  const rows = h.upserts.filter((u) => u.taskId === taskId);
  const last = rows[rows.length - 1];
  if (!last) throw new Error(`no upsert captured for ${taskId}`);
  return last.nextFireAtIso;
}

describe("recurrence refire — fireWithResult({ allowTerminalRefire })", () => {
  it.each([
    ["completed", "complete"],
    ["fired", undefined],
    ["acknowledged", "acknowledge"],
    ["skipped", "skip"],
  ] as const)(
    "refires a %s daily task at its indexed next occurrence",
    async (status, verb) => {
      const h = makeHarness();
      const task = await h.runner.schedule(dailyCronInput());
      expect((await h.runner.fireWithResult(task.taskId)).kind).toBe("fired");
      h.setNow("2026-05-09T10:00:00.000Z");
      if (verb) await h.runner.apply(task.taskId, verb);
      const settled = await h.store.get(task.taskId);
      expect(settled?.state.status).toBe(status);
      if (verb === "complete") expect(settled?.state.completedAt).toBeDefined();
      if (verb === "acknowledge")
        expect(settled?.state.acknowledgedAt).toBeDefined();
      expect(lastUpsertFor(h, task.taskId)).toBe("2026-05-10T09:00:00.000Z");

      h.setNow("2026-05-10T09:00:30.000Z");
      const refire = await h.runner.fireWithResult(task.taskId, {
        allowTerminalRefire: true,
      });
      expect(refire).toMatchObject({
        kind: "fired",
        task: {
          state: {
            status: "fired",
            firedAt: "2026-05-10T09:00:30.000Z",
          },
        },
      });
      const reloaded = await h.store.get(task.taskId);
      expect(reloaded?.state.completedAt).toBeUndefined();
      expect(reloaded?.state.acknowledgedAt).toBeUndefined();
      expect(await firedLogCount(h, task.taskId)).toBe(2);
    },
  );

  it("interval task fires across three consecutive intervals via zombie refire", async () => {
    const h = makeHarness("2026-05-09T12:00:00.000Z");
    const task = await h.runner.schedule(
      dailyCronInput({ trigger: { kind: "interval", everyMinutes: 60 } }),
    );
    const first = await h.runner.fireWithResult(task.taskId);
    expect(first.kind).toBe("fired");

    h.setNow("2026-05-09T13:01:00.000Z");
    const second = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(second.kind).toBe("fired");

    h.setNow("2026-05-09T14:02:00.000Z");
    const third = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(third.kind).toBe("fired");
    expect(await firedLogCount(h, task.taskId)).toBe(3);
  });

  it("during_window task refires on the NEXT day but never twice inside one window", async () => {
    const h = makeHarness("2026-05-09T08:00:00.000Z");
    const task = await h.runner.schedule(
      dailyCronInput({
        trigger: { kind: "during_window", windowKey: "morning" },
      }),
    );
    const day1 = await h.runner.fireWithResult(task.taskId);
    expect(day1.kind).toBe("fired");

    // Same window, later instant: the fresh-row due re-check sees
    // `firedAt` inside today's active window and bails as raced.
    h.setNow("2026-05-09T08:30:00.000Z");
    const sameWindow = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(sameWindow.kind).toBe("raced");

    // Next day, window active again → refire.
    h.setNow("2026-05-10T08:30:00.000Z");
    const day2 = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(day2.kind).toBe("fired");
    expect(await firedLogCount(h, task.taskId)).toBe(2);
  });

  it("a refire attempt whose next occurrence is NOT yet due races out (sequential double-fire guard)", async () => {
    const h = makeHarness("2026-05-09T09:00:00.000Z");
    const task = await h.runner.schedule(dailyCronInput());
    await h.runner.fireWithResult(task.taskId);
    await h.runner.apply(task.taskId, "complete");

    h.setNow("2026-05-10T09:00:00.000Z");
    const winner = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(winner.kind).toBe("fired");

    // Same tick instant, second attempt (models tick B re-reading AFTER
    // tick A fully persisted): the fresh row's next occurrence is tomorrow,
    // so the attempt must NOT double-fire today's occurrence.
    const loser = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(loser.kind).toBe("raced");
    expect(await firedLogCount(h, task.taskId)).toBe(2);
  });

  it("clock jump over 3 missed days: cron catches up with exactly ONE fire", async () => {
    const h = makeHarness("2026-05-09T09:00:00.000Z");
    const task = await h.runner.schedule(dailyCronInput());
    await h.runner.fireWithResult(task.taskId);
    await h.runner.apply(task.taskId, "complete");

    // Offline across 2026-05-10/11/12 occurrences; back at 05-12 10:30.
    h.setNow("2026-05-12T10:30:00.000Z");
    const catchUp = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(catchUp.kind).toBe("fired");
    // No storm: the next attempt is not due until 05-13 09:00.
    const again = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(again.kind).toBe("raced");
    expect(await firedLogCount(h, task.taskId)).toBe(2);
  });

  it("DISMISSED recurring tasks never refire", async () => {
    const h = makeHarness("2026-05-09T09:00:00.000Z");
    const task = await h.runner.schedule(dailyCronInput());
    await h.runner.fireWithResult(task.taskId);
    await h.runner.apply(task.taskId, "dismiss");
    expect(lastUpsertFor(h, task.taskId)).toBeNull();

    h.setNow("2026-05-10T09:00:00.000Z");
    const attempt = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(attempt.kind).toBe("skipped");
    if (attempt.kind !== "skipped") throw new Error("unreachable");
    expect(attempt.reason).toBe("terminal:dismissed");
    expect(await firedLogCount(h, task.taskId)).toBe(1);
  });

  it("completed ONCE tasks never refire, even with allowTerminalRefire", async () => {
    const h = makeHarness("2026-05-09T09:00:00.000Z");
    const task = await h.runner.schedule(
      dailyCronInput({
        trigger: { kind: "once", atIso: "2026-05-09T09:00:00.000Z" },
      }),
    );
    await h.runner.fireWithResult(task.taskId);
    await h.runner.apply(task.taskId, "complete");
    expect(lastUpsertFor(h, task.taskId)).toBeNull();

    h.setNow("2026-05-10T09:00:00.000Z");
    const attempt = await h.runner.fireWithResult(task.taskId, {
      allowTerminalRefire: true,
    });
    expect(attempt.kind).toBe("skipped");
    if (attempt.kind !== "skipped") throw new Error("unreachable");
    expect(attempt.reason).toBe("terminal:completed");
    expect(await firedLogCount(h, task.taskId)).toBe(1);
  });
});

describe("recurrence refire — claimForFire CAS (in-memory reference store)", () => {
  it("claims once on a matching (status, firedAt) pair; the rewritten firedAt invalidates the loser", async () => {
    const store = createInMemoryScheduledTaskStore();
    const task: ScheduledTask = {
      taskId: "cas_task",
      kind: "checkin",
      promptInstructions: "cas",
      trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "default_pack",
      createdBy: "tester",
      ownerVisible: true,
      state: {
        status: "completed",
        followupCount: 0,
        firedAt: "2026-05-09T09:00:00.000Z",
        completedAt: "2026-05-09T09:05:00.000Z",
      },
    };
    await store.upsert(task);

    const expected = {
      status: "completed" as const,
      firedAtIso: "2026-05-09T09:00:00.000Z",
    };
    const winner = await store.claimForFire({
      taskId: "cas_task",
      firedAtIso: "2026-05-10T09:00:00.000Z",
      expected,
    });
    expect(winner.kind).toBe("fired");
    if (winner.kind !== "fired") throw new Error("unreachable");
    expect(winner.task.state.status).toBe("fired");
    expect(winner.task.state.firedAt).toBe("2026-05-10T09:00:00.000Z");

    // Loser presents the SAME observed pair — the winner's claim rewrote
    // both status and firedAt, so the CAS no longer matches.
    const loser = await store.claimForFire({
      taskId: "cas_task",
      firedAtIso: "2026-05-10T09:00:00.000Z",
      expected,
    });
    expect(loser.kind).toBe("raced");
  });

  it("without `expected`, the claim still matches status='scheduled' only", async () => {
    const store = createInMemoryScheduledTaskStore();
    const task: ScheduledTask = {
      taskId: "fresh_task",
      kind: "reminder",
      promptInstructions: "fresh",
      trigger: { kind: "once", atIso: "2026-05-09T09:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: "tester",
      ownerVisible: true,
      state: { status: "fired", followupCount: 0 },
    };
    await store.upsert(task);
    const claim = await store.claimForFire({
      taskId: "fresh_task",
      firedAtIso: "2026-05-09T09:01:00.000Z",
    });
    expect(claim.kind).toBe("raced");
  });
});

it("clears next_fire_at on an ACKNOWLEDGED once task", async () => {
  const h = makeHarness("2026-05-09T09:00:00.000Z");
  const task = await h.runner.schedule(
    dailyCronInput({
      trigger: { kind: "once", atIso: "2026-05-09T09:00:00.000Z" },
    }),
  );
  await h.runner.fireWithResult(task.taskId);
  await h.runner.apply(task.taskId, "acknowledge");
  expect(lastUpsertFor(h, task.taskId)).toBeNull();
});
