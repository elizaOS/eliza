/** Same durable scheduler row and real reminder processing, driven by a virtual
 * core clock. Notification sink records deliveries; no network/model inference. */
import { TaskService } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime as createBaseLifeOpsTestRuntime,
  getRecordedTestNotifications,
} from "../../test/helpers/runtime.js";
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  resolveLifeOpsTaskIntervalMs,
} from "./scheduler-task.js";
import { LifeOpsService } from "./service.js";

beforeEach(() => {
  const daytime = new Date();
  daytime.setDate(daytime.getDate() + 1);
  daytime.setHours(12, 0, 0, 0);
  // Freeze only Date: database I/O and timeout timers remain real. Delivery
  // admission must not depend on whether CI happens to run during sleep hours.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(daytime);
});
afterEach(() => vi.useRealTimers());

async function createLifeOpsTestRuntime() {
  const fixture = await createBaseLifeOpsTestRuntime();
  await TaskService.stop(fixture.runtime);
  // Supersede boot observations with an actual persisted owner wake signal.
  vi.setSystemTime(Date.now() + 1);
  const awake = await new LifeOpsService(fixture.runtime).captureManualOverride(
    {
      kind: "just_woke_up",
      occurredAt: new Date().toISOString(),
    },
  );
  expect(awake.circadianState).toBe("awake");
  return fixture;
}

it("committed create and snooze reconcile the same task, then deliver once at its due tick without idle full polling", async () => {
  const f = await createLifeOpsTestRuntime();
  const runtime = f.runtime;
  const model = vi
    .spyOn(runtime, "useModel")
    .mockRejectedValue(Error("No inference"));
  let now = Date.now();
  const base = resolveLifeOpsTaskIntervalMs(runtime.agentId);
  let passes = 0,
    ticks = 0;
  const patches = vi.spyOn(runtime, "patchTaskMetadata");
  const passTimes: number[] = [];
  try {
    const service = new LifeOpsService(runtime);
    const taskId = await ensureLifeOpsSchedulerTask(runtime);
    runtime.registerTaskWorker({
      name: LIFEOPS_TASK_NAME,
      execute: async () => {
        passes++;
        passTimes.push(now);
        const result = await service.processReminders({
          now: new Date(now).toISOString(),
          scope: "definitions",
        });
        return { nextInterval: base, nextWakeAt: result.nextWakeAt };
      },
    });
    const due = now + 90000;
    const record = await service.createDefinition({
      title: "Exact wake proof",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
      },
    });
    const initial = await runtime.getTask(taskId);
    expect(initial?.metadata?.wakeAt).toBeDefined();
    const restoredId = await ensureLifeOpsSchedulerTask(runtime);
    expect(restoredId).toBe(taskId);
    const booted = await runtime.getTask(taskId);
    expect(Number(booted?.metadata?.wakeRevision)).toBeGreaterThan(
      Number(initial?.metadata?.wakeRevision),
    );
    expect(Number(booted?.metadata?.wakeAt)).toBeLessThanOrEqual(
      Number(initial?.metadata?.wakeAt),
    );
    const clock = {
      now: () => now,
      setInterval: () => {
        throw Error("No second timer");
      },
      clearInterval: () => {},
    };
    let scheduler = new TaskService(runtime, clock);
    const tick = async () => {
      ticks++;
      const row = await runtime.getTask(taskId);
      if (row) await scheduler.runTick([row]);
    };
    now = Date.now() + 1;
    await tick();
    expect(passes).toBe(1);
    expect((await runtime.getTask(taskId))?.metadata?.wakeAt).toBe(due);
    expect(getRecordedTestNotifications(runtime)).toHaveLength(0);
    const occurrences = await service.repository.listOccurrencesForDefinition(
      runtime.agentId,
      record.definition.id,
    );
    const snoozed = await service.snoozeOccurrence(
      occurrences[0].id,
      { minutes: 3 },
      new Date(now),
    );
    if (!snoozed.snoozedUntil)
      throw Error("Snooze did not persist its deadline");
    const newDue = Date.parse(snoozed.snoozedUntil);
    expect(newDue).toBeGreaterThan(due);
    now = Math.max(now, Date.now() + 1);
    await tick();
    expect(passes).toBe(2);
    expect((await runtime.getTask(taskId))?.metadata?.wakeAt).toBe(newDue);
    scheduler = new TaskService(runtime, clock);
    for (now += 1000; now < newDue; now += 1000) await tick();
    expect(getRecordedTestNotifications(runtime)).toHaveLength(0);
    await tick();
    expect(
      getRecordedTestNotifications(runtime),
      JSON.stringify(
        await service.repository.listReminderAttempts(runtime.agentId),
      ),
    ).toHaveLength(1);
    expect(getRecordedTestNotifications(runtime)[0].body).toContain(
      "Exact wake proof",
    );
    const afterDuePasses = passes;
    for (let i = 0; i < 60; i++) {
      now += 1000;
      await tick();
    }
    expect(getRecordedTestNotifications(runtime)).toHaveLength(1);
    expect(passes - afterDuePasses).toBeLessThanOrEqual(1);
    expect(passes).toBeLessThan(10);
    expect(model).not.toHaveBeenCalled();
    const attempts = await service.repository.listReminderAttempts(
      runtime.agentId,
    );
    const delivered = attempts.filter(
      (a) => a.ownerId === snoozed.id && a.outcome.startsWith("delivered"),
    );
    expect(delivered).toHaveLength(1);
    const virtualDispatchLatenessMs =
      Date.parse(delivered[0].attemptedAt) -
      Date.parse(delivered[0].scheduledFor);
    expect(virtualDispatchLatenessMs).toBeGreaterThanOrEqual(0);
    expect(virtualDispatchLatenessMs).toBeLessThan(1000);
    const wakeWrites = patches.mock.calls.filter(
      (call) => call[1].wake !== undefined,
    ).length;
    expect(wakeWrites).toBeLessThan(12);
    process.stdout.write(
      "WAKE_COST_EVIDENCE " +
        JSON.stringify({
          coreTicks: ticks,
          reminderProcessingPasses: passes,
          atomicWakeWrites: wakeWrites,
          notifications: getRecordedTestNotifications(runtime).length,
          modelCalls: model.mock.calls.length,
          baseIntervalMs: base,
          virtualDispatchLatenessMs,
          processingPassTimes: passTimes,
        }) +
        "\n",
    );
  } finally {
    patches.mockRestore();
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);

it("concurrent callers retain their own pass deadline and do not hide a later undelivered step", async () => {
  const f = await createLifeOpsTestRuntime();
  const model = vi
    .spyOn(f.runtime, "useModel")
    .mockRejectedValue(Error("No inference"));
  try {
    const service = new LifeOpsService(f.runtime);
    await ensureLifeOpsSchedulerTask(f.runtime);
    const now = Date.now(),
      due = now + 90000;
    await service.createDefinition({
      title: "Two-step retained deadline",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [
          { channel: "in_app", offsetMinutes: 0, label: "First" },
          { channel: "in_app", offsetMinutes: 2, label: "Second" },
        ],
      },
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstReady!: () => void;
    const ready = new Promise<void>((r) => (firstReady = r));
    const first = service
      .processReminders({
        now: new Date(now).toISOString(),
        scope: "definitions",
      })
      .then(async (result) => {
        firstReady();
        await held;
        return result;
      });
    await ready;
    const second = await service.processReminders({
      now: new Date(due + 1).toISOString(),
      scope: "definitions",
    });
    release();
    const original = await first;
    expect(original.nextWakeAt).toBe(due);
    expect(second.nextWakeAt).toBe(due + 120000);
    expect(
      second.attempts.filter((a) => a.outcome.startsWith("delivered")),
      JSON.stringify(second.attempts),
    ).toHaveLength(1);
    expect(model).not.toHaveBeenCalled();
  } finally {
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);

it("quiet-blocked due work consumes its wake without a one-second retry loop", async () => {
  const f = await createLifeOpsTestRuntime();
  const model = vi
    .spyOn(f.runtime, "useModel")
    .mockRejectedValue(Error("No inference"));
  let now = Date.now(),
    passes = 0;
  try {
    const service = new LifeOpsService(f.runtime);
    const taskId = await ensureLifeOpsSchedulerTask(f.runtime);
    const due = now + 90000;
    const minute =
      new Date(due).getUTCHours() * 60 + new Date(due).getUTCMinutes();
    await service.createDefinition({
      title: "Quiet proof",
      kind: "habit",
      cadence: {
        kind: "once",
        dueAt: new Date(due).toISOString(),
        visibilityLeadMinutes: 0,
      },
      timezone: "UTC",
      metadata: {
        ownerSurface: "OWNER_REMINDERS",
        nativeProjection: "in_app_only",
      },
      reminderPlan: {
        steps: [{ channel: "sms", offsetMinutes: 0, label: "Quiet" }],
        quietHours: {
          timezone: "UTC",
          startMinute: (minute + 1439) % 1440,
          endMinute: (minute + 2) % 1440,
          channels: ["sms"],
        },
      },
    });
    f.runtime.registerTaskWorker({
      name: LIFEOPS_TASK_NAME,
      execute: async () => {
        passes++;
        const result = await service.processReminders({
          now: new Date(now).toISOString(),
          scope: "definitions",
        });
        return { nextInterval: 62033, nextWakeAt: result.nextWakeAt };
      },
    });
    const scheduler = new TaskService(f.runtime, {
      now: () => now,
      setInterval: () => {
        throw Error("No new clock");
      },
      clearInterval: () => {},
    });
    const tick = async () => {
      const row = await f.runtime.getTask(taskId);
      if (row) await scheduler.runTick([row]);
    };
    now = due;
    await tick();
    expect(getRecordedTestNotifications(f.runtime)).toHaveLength(0);
    expect(
      (await service.repository.listReminderAttempts(f.runtime.agentId)).some(
        (a) => a.outcome === "blocked_quiet_hours",
      ),
    ).toBe(true);
    expect((await f.runtime.getTask(taskId))?.metadata?.wakeAt).toBeUndefined();
    for (let i = 0; i < 30; i++) {
      now += 1000;
      await tick();
    }
    expect(passes).toBe(1);
    expect(model).not.toHaveBeenCalled();
  } finally {
    model.mockRestore();
    await f.cleanup();
  }
}, 120000);
