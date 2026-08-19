/**
 * Real-runner regressions for pre-mutation snooze and gate-defer projections.
 * The in-memory store proves hostile offsets reject without persisting partial
 * lifecycle state, including the terminal recurrence-refire path.
 */

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
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import { MAX_DATE_MS } from "./time-range.js";
import type { GateDecision, ScheduledTask } from "./types.js";

const TEST_GATE_KIND = "test_minute_projection";
const OVERFLOW_MINUTES = 1_000_000_000_000;

interface Harness {
  runner: ScheduledTaskRunnerHandle;
  store: ScheduledTaskStore;
  setGateDecision(decision: GateDecision): void;
  setNow(iso: string): void;
}

function makeHarness(initialIso = "2026-05-11T12:00:00.000Z"): Harness {
  let nowIso = initialIso;
  let gateDecision: GateDecision = { kind: "allow" };
  const store = createInMemoryScheduledTaskStore();
  const gates = createTaskGateRegistry();
  gates.register({
    kind: TEST_GATE_KIND,
    evaluate: () => gateDecision,
  });
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  const runner = createScheduledTaskRunner({
    agentId: "agent-minute-projection",
    store,
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    now: () => new Date(nowIso),
  });

  return {
    runner,
    store,
    setGateDecision(decision) {
      gateDecision = decision;
    },
    setNow(iso) {
      nowIso = iso;
    },
  };
}

function input(
  overrides: Partial<Omit<ScheduledTask, "taskId" | "state">> = {},
): Omit<ScheduledTask, "taskId" | "state"> {
  return {
    kind: "reminder",
    promptInstructions: "validate bounded minute projection",
    trigger: { kind: "manual" },
    priority: "low",
    respectsGlobalPause: false,
    ownerVisible: true,
    source: "user_chat",
    createdBy: "agent-minute-projection",
    ...overrides,
  };
}

async function expectPersistedUnchanged(
  store: ScheduledTaskStore,
  before: ScheduledTask,
): Promise<void> {
  expect(await store.get(before.taskId)).toEqual(before);
}

describe("pre-mutation minute projection validation (#22170)", () => {
  it("rejects hostile snooze minutes without mutating or persisting the task", async () => {
    for (const minutes of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      OVERFLOW_MINUTES,
    ]) {
      const h = makeHarness();
      const task = await h.runner.schedule(input());
      const before = structuredClone(task);

      await expect(
        h.runner.apply(task.taskId, "snooze", { minutes }),
      ).rejects.toThrow(/snooze:/);
      await expectPersistedUnchanged(h.store, before);
    }
  });

  it("allows snooze to land exactly on the positive Date bound", async () => {
    const baseMs = MAX_DATE_MS - 60_000;
    const h = makeHarness(new Date(baseMs).toISOString());
    const task = await h.runner.schedule(input());

    const snoozed = await h.runner.apply(task.taskId, "snooze", { minutes: 1 });
    expect(snoozed.state.firedAt).toBe(new Date(MAX_DATE_MS).toISOString());
  });

  it("does not consume an idempotency receipt when snooze projection rejects", async () => {
    const h = makeHarness();
    const task = await h.runner.schedule(input());
    const before = structuredClone(task);
    const options = { idempotencyKey: "retry-after-invalid-projection" };

    await expect(
      h.runner.applyWithResult(
        task.taskId,
        "snooze",
        { minutes: OVERFLOW_MINUTES },
        options,
      ),
    ).rejects.toThrow(/snooze:/);
    await expectPersistedUnchanged(h.store, before);

    const recovered = await h.runner.applyWithResult(
      task.taskId,
      "snooze",
      { minutes: 5 },
      options,
    );
    expect(recovered.replayed).toBe(false);
    expect(recovered.task.state.firedAt).toBe("2026-05-11T12:05:00.000Z");
  });

  it("rejects hostile gate offsets without mutating or persisting a scheduled task", async () => {
    for (const offsetMinutes of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      OVERFLOW_MINUTES,
    ]) {
      const h = makeHarness();
      h.setGateDecision({
        kind: "defer",
        until: { offsetMinutes },
        reason: "hostile test contribution",
      });
      const task = await h.runner.schedule(
        input({ shouldFire: { gates: [{ kind: TEST_GATE_KIND }] } }),
      );
      const before = structuredClone(task);

      await expect(h.runner.fireWithResult(task.taskId)).rejects.toThrow(
        /gate defer: offset/,
      );
      await expectPersistedUnchanged(h.store, before);
    }
  });

  it("rejects a malformed absolute gate defer instant before persistence", async () => {
    const h = makeHarness();
    h.setGateDecision({
      kind: "defer",
      until: { atIso: "not-an-instant" },
      reason: "malformed test contribution",
    });
    const task = await h.runner.schedule(
      input({ shouldFire: { gates: [{ kind: TEST_GATE_KIND }] } }),
    );
    const before = structuredClone(task);

    await expect(h.runner.fireWithResult(task.taskId)).rejects.toThrow(
      /gate defer: offset/,
    );
    await expectPersistedUnchanged(h.store, before);
  });

  it("preserves zero gate delay and both exact Date boundaries", async () => {
    for (const baseMs of [-MAX_DATE_MS, MAX_DATE_MS - 60_000]) {
      const offsetMinutes = baseMs < 0 ? 0 : 1;
      const h = makeHarness(new Date(baseMs).toISOString());
      h.setGateDecision({
        kind: "defer",
        until: { offsetMinutes },
        reason: "exact boundary",
      });
      const task = await h.runner.schedule(
        input({ shouldFire: { gates: [{ kind: TEST_GATE_KIND }] } }),
      );

      const result = await h.runner.fireWithResult(task.taskId);
      expect(result.kind).toBe("skipped");
      const expectedMs = baseMs + offsetMinutes * 60_000;
      expect((await h.store.get(task.taskId))?.state.firedAt).toBe(
        new Date(expectedMs).toISOString(),
      );
    }
  });

  it("keeps a terminal recurrence row unchanged when gate projection rejects", async () => {
    const h = makeHarness("2026-05-09T09:00:00.000Z");
    const task = await h.runner.schedule(
      input({
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
        shouldFire: { gates: [{ kind: TEST_GATE_KIND }] },
      }),
    );
    await h.runner.fireWithResult(task.taskId);
    await h.runner.apply(task.taskId, "complete");
    h.setNow("2026-05-10T09:00:30.000Z");
    h.setGateDecision({
      kind: "defer",
      until: { offsetMinutes: OVERFLOW_MINUTES },
      reason: "hostile refire contribution",
    });
    const before = await h.store.get(task.taskId);
    if (!before) throw new Error("expected persisted task");

    await expect(
      h.runner.fireWithResult(task.taskId, { allowTerminalRefire: true }),
    ).rejects.toThrow(/gate defer: offset/);
    await expectPersistedUnchanged(h.store, before);
  });
});
