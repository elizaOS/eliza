import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type ProcessDueScheduledTasksResult,
  processDueScheduledTasks,
} from "../scheduled-task/scheduler.js";
import { type RemindersDeps, RemindersDomain } from "./reminders-service.js";

vi.mock("../scheduled-task/scheduler.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scheduled-task/scheduler.js")>();
  return {
    ...actual,
    processDueScheduledTasks: vi.fn(actual.processDueScheduledTasks),
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

type SubsystemOverrides = {
  syncWebsiteAccessState: ReturnType<typeof vi.fn>;
  readEffectiveScheduleState: ReturnType<typeof vi.fn>;
  refreshEffectiveScheduleState: ReturnType<typeof vi.fn>;
  processReminders: ReturnType<typeof vi.fn>;
  processSleepCycleCheckins: ReturnType<typeof vi.fn>;
  runTelemetryMaintenanceIfDue: ReturnType<typeof vi.fn>;
};

/**
 * Build a RemindersDomain whose subsystem entry points are all instance-level
 * mocks (TS `private` is compile-time only), so processScheduledWork's guard
 * behavior can be tested without a live repository/LLM.
 */
function makeDomain() {
  const deps = {
    runDueWorkflows: vi.fn(async () => []),
    runDueEventWorkflows: vi.fn(async () => []),
    snoozeOccurrence: vi.fn(),
    checkinSource: {},
  };
  const ctx = {
    runtime: { emitEvent: vi.fn(async () => undefined) },
    repository: {},
    agentId: () => "00000000-0000-0000-0000-0000000000dd",
    logLifeOpsWarn: vi.fn(),
    logLifeOpsError: vi.fn(),
  };
  const domain = new RemindersDomain(
    ctx as unknown as LifeOpsContext,
    deps as unknown as RemindersDeps,
  );
  const overrides: SubsystemOverrides = {
    syncWebsiteAccessState: vi.fn(async () => undefined),
    readEffectiveScheduleState: vi.fn(async () => null),
    refreshEffectiveScheduleState: vi.fn(async () => null),
    processReminders: vi.fn(async () => ({ now: NOW, attempts: [] })),
    processSleepCycleCheckins: vi.fn(async () => undefined),
    runTelemetryMaintenanceIfDue: vi.fn(async () => undefined),
  };
  Object.assign(domain as unknown as Record<string, unknown>, overrides);
  return { domain, deps, overrides };
}

describe("RemindersDomain.processScheduledWork subsystem isolation", () => {
  beforeEach(() => {
    vi.mocked(processDueScheduledTasks).mockReset();
    vi.mocked(processDueScheduledTasks).mockResolvedValue(
      emptyScheduledTaskResult,
    );
  });

  it("returns an empty subsystemFailures list when every subsystem succeeds", async () => {
    const { domain } = makeDomain();
    const result = await domain.processScheduledWork({ now: NOW });
    expect(result.subsystemFailures).toEqual([]);
    expect(result.now).toBe(NOW);
  });

  it("continues past a website-access sync failure and still processes reminders + workflows", async () => {
    const { domain, deps, overrides } = makeDomain();
    overrides.syncWebsiteAccessState.mockRejectedValue(
      new Error("sync exploded"),
    );

    const result = await domain.processScheduledWork({ now: NOW });

    expect(overrides.processReminders).toHaveBeenCalledTimes(1);
    expect(deps.runDueWorkflows).toHaveBeenCalledTimes(1);
    expect(deps.runDueEventWorkflows).toHaveBeenCalledTimes(1);
    expect(processDueScheduledTasks).toHaveBeenCalledTimes(1);
    expect(overrides.processSleepCycleCheckins).toHaveBeenCalledTimes(1);
    expect(result.subsystemFailures).toEqual([
      { subsystem: "website_access_sync", error: "sync exploded" },
    ]);
  });

  it("continues past a reminders failure and still runs workflows + scheduled tasks", async () => {
    const { domain, deps, overrides } = makeDomain();
    overrides.processReminders.mockRejectedValue(new Error("reminders down"));

    const result = await domain.processScheduledWork({ now: NOW });

    expect(deps.runDueWorkflows).toHaveBeenCalledTimes(1);
    expect(processDueScheduledTasks).toHaveBeenCalledTimes(1);
    expect(result.reminderAttempts).toEqual([]);
    expect(result.subsystemFailures).toEqual([
      { subsystem: "reminders", error: "reminders down" },
    ]);
  });

  it("collects failures from multiple subsystems in one tick", async () => {
    const { domain, overrides } = makeDomain();
    overrides.refreshEffectiveScheduleState.mockRejectedValue(
      new Error("circadian down"),
    );
    vi.mocked(processDueScheduledTasks).mockRejectedValue(
      new Error("scheduled tasks down"),
    );

    const result = await domain.processScheduledWork({ now: NOW });

    expect(result.scheduledTaskFires).toEqual([]);
    expect(result.scheduledTaskCompletionTimeouts).toEqual([]);
    expect(result.subsystemFailures).toEqual([
      { subsystem: "circadian_state", error: "circadian down" },
      { subsystem: "scheduled_tasks", error: "scheduled tasks down" },
    ]);
    // Sleep check-ins still ran even after two earlier subsystems failed.
    expect(overrides.processSleepCycleCheckins).toHaveBeenCalledTimes(1);
  });

  it("still surfaces successful subsystem results alongside failures", async () => {
    const { domain, overrides } = makeDomain();
    overrides.syncWebsiteAccessState.mockRejectedValue(new Error("boom"));
    vi.mocked(processDueScheduledTasks).mockResolvedValue({
      completions: [],
      fires: [
        {
          taskId: "st-1",
          status: "fired",
          reason: "due",
        },
      ],
      completionTimeouts: [],
      pendingPrompts: [],
      errors: [],
    });

    const result = await domain.processScheduledWork({ now: NOW });

    expect(result.scheduledTaskFires).toEqual([
      { taskId: "st-1", status: "fired", reason: "due" },
    ]);
    expect(result.subsystemFailures).toHaveLength(1);
  });

  it("rethrows missing-relation errors so the task worker can rerun migrations", async () => {
    const { domain, overrides } = makeDomain();
    overrides.processReminders.mockRejectedValue(
      new Error('relation "app_lifeops.lifeops_occurrences" does not exist'),
    );

    await expect(domain.processScheduledWork({ now: NOW })).rejects.toThrow(
      "app_lifeops.lifeops_occurrences",
    );
  });
});
