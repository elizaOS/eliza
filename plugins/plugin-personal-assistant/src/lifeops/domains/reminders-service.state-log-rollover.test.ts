/**
 * State-log rollover wiring (#10723 / #10721 audit item 25).
 *
 * `rolloverStateLog` (the documented "nightly rollup pass", 90-day default
 * retention) had NO production caller, so `life_scheduled_task_log` grew
 * unbounded — worst for recurring tasks writing `fire_attempt` rows every
 * tick. It now rides the once-per-UTC-day telemetry-maintenance gate inside
 * `processScheduledWork`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type ProcessDueScheduledTasksResult,
  processDueScheduledTasks,
} from "../scheduled-task/scheduler.js";
import { getScheduledTaskRunner } from "../scheduled-task/service.js";
import { type RemindersDeps, RemindersDomain } from "./reminders-service.js";

vi.mock("../scheduled-task/scheduler.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scheduled-task/scheduler.js")>();
  return {
    ...actual,
    processDueScheduledTasks: vi.fn(actual.processDueScheduledTasks),
  };
});

vi.mock("../scheduled-task/service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scheduled-task/service.js")>();
  return {
    ...actual,
    getScheduledTaskRunner: vi.fn(actual.getScheduledTaskRunner),
  };
});

const NOW = "2026-07-01T12:00:00.000Z";

const emptyScheduledTaskResult: ProcessDueScheduledTasksResult = {
  completions: [],
  fires: [],
  completionTimeouts: [],
  pendingPrompts: [],
  errors: [],
};

function makeDomain() {
  const rolloverStateLog = vi.fn(async () => ({ rolledUp: 2, deletedRaw: 40 }));
  vi.mocked(getScheduledTaskRunner).mockReturnValue({
    rolloverStateLog,
  } as unknown as ReturnType<typeof getScheduledTaskRunner>);

  const deps = {
    runDueWorkflows: vi.fn(async () => []),
    runDueEventWorkflows: vi.fn(async () => []),
    snoozeOccurrence: vi.fn(),
    checkinSource: {},
  };
  const ctx = {
    runtime: { emitEvent: vi.fn(async () => undefined) },
    repository: {
      upsertTelemetryDailyRollup: vi.fn(async () => undefined),
      pruneTelemetryEvents: vi.fn(async () => ({ deleted: 0 })),
    },
    agentId: () => "00000000-0000-0000-0000-0000000000ee",
    logLifeOpsWarn: vi.fn(),
    logLifeOpsError: vi.fn(),
  };
  const domain = new RemindersDomain(
    ctx as unknown as LifeOpsContext,
    deps as unknown as RemindersDeps,
  );
  // Stub every OTHER subsystem so the maintenance leg runs for real
  // (TS `private` is compile-time only).
  Object.assign(domain as unknown as Record<string, unknown>, {
    syncWebsiteAccessState: vi.fn(async () => undefined),
    readEffectiveScheduleState: vi.fn(async () => null),
    refreshEffectiveScheduleState: vi.fn(async () => null),
    processReminders: vi.fn(async () => ({ now: NOW, attempts: [] })),
    processSleepCycleCheckins: vi.fn(async () => undefined),
  });
  return { domain, ctx, rolloverStateLog };
}

describe("RemindersDomain daily maintenance rolls over the scheduled-task state log", () => {
  beforeEach(() => {
    vi.mocked(processDueScheduledTasks).mockReset();
    vi.mocked(processDueScheduledTasks).mockResolvedValue(
      emptyScheduledTaskResult,
    );
    vi.mocked(getScheduledTaskRunner).mockReset();
  });

  it("runs rolloverStateLog once on the first tick of a UTC day, not on the next tick", async () => {
    const { domain, rolloverStateLog } = makeDomain();

    await domain.processScheduledWork({ now: NOW });
    expect(rolloverStateLog).toHaveBeenCalledTimes(1);

    // Second tick, same UTC day — gate holds.
    await domain.processScheduledWork({ now: "2026-07-01T12:01:00.000Z" });
    expect(rolloverStateLog).toHaveBeenCalledTimes(1);

    // First tick of the next UTC day — runs again.
    await domain.processScheduledWork({ now: "2026-07-02T00:00:30.000Z" });
    expect(rolloverStateLog).toHaveBeenCalledTimes(2);
  });

  it("a rollover failure is contained by the maintenance guard and retried next tick", async () => {
    const { domain, ctx, rolloverStateLog } = makeDomain();
    rolloverStateLog.mockRejectedValueOnce(new Error("log store down"));

    const result = await domain.processScheduledWork({ now: NOW });
    // Maintenance failures warn + retry next tick; they never fail the tick.
    expect(result.now).toBe(NOW);
    expect(ctx.logLifeOpsWarn).toHaveBeenCalledWith(
      "telemetry_maintenance",
      expect.stringContaining("log store down"),
    );

    // Gate was NOT latched on failure — the next tick retries.
    await domain.processScheduledWork({ now: "2026-07-01T12:01:00.000Z" });
    expect(rolloverStateLog).toHaveBeenCalledTimes(2);
  });
});
