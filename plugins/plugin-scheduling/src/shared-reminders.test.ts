/** Exercise Shared reminder argument admission against the real in-memory runner. */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./scheduled-task/completion-check-registry.ts";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./scheduled-task/consolidation-policy.ts";
import { isScheduledTaskDue } from "./scheduled-task/due.ts";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./scheduled-task/escalation.ts";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./scheduled-task/gate-registry.ts";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  TestNoopScheduledTaskDispatcher,
} from "./scheduled-task/runner.ts";
import { ScheduledTaskRunnerService } from "./scheduled-task/runner-service.ts";
import { createInMemoryScheduledTaskLogStore } from "./scheduled-task/state-log.ts";
import type { GlobalPauseView, ScheduledTask } from "./scheduled-task/types.ts";
import { createSharedRemindersEdgeAction } from "./shared-reminders.ts";

it("refuses invalid recurrence before writes and retains the stored timezone on update", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const runtime = {
    agentId,
    getService: () => null,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
  const service = await ScheduledTaskRunnerService.start(runtime);
  const now = () => new Date("2026-10-11T12:00:00Z");
  const runner = service.getRunner({ agentId, now });
  const action = createSharedRemindersEdgeAction({
    runner,
    agentId,
    now,
    delivery: {
      platform: "telegram",
      project: "test",
      connectorAccountId: "owner",
      chatId: "123456",
    },
  });
  const run = (parameters: HandlerOptions["parameters"]) =>
    action.handler(
      runtime,
      {
        id: crypto.randomUUID(),
        entityId: agentId,
        agentId,
        roomId: agentId,
        content: { text: "Set my reminder", source: "test" },
      } as Memory,
      undefined,
      { parameters },
    );
  try {
    const invalidTimings: Record<string, string | number>[] = [
      { everyMinutes: 1.5 },
      { cronExpression: "not a cron", timezone: "Asia/Tokyo" },
      { cronExpression: "0 9 30 2 *", timezone: "Asia/Tokyo" },
    ];
    for (const timing of invalidTimings) {
      const result = await run({
        operation: "create",
        reminderText: "Take a walk",
        ...timing,
      });
      expect(result?.success, JSON.stringify(result)).toBe(false);
      expect(await runner.list()).toHaveLength(0);
    }
    const created = await run({
      operation: "create",
      reminderText: "Take a walk",
      cronExpression: "0 9 * * *",
      timezone: "Asia/Tokyo",
    });
    expect(created?.success, JSON.stringify(created)).toBe(true);
    const task = created?.data?.task as ScheduledTask;
    const updated = await run({
      operation: "update",
      taskId: task.taskId,
      cronExpression: "0 10 * * *",
    });
    expect(updated?.success, JSON.stringify(updated)).toBe(true);
    const replacement = updated?.data?.task as ScheduledTask;
    const stored = (await runner.list()).find(
      (entry) => entry.taskId === replacement.taskId,
    );
    expect(stored?.trigger).toMatchObject({
      kind: "cron",
      expression: "0 10 * * *",
      tz: "Asia/Tokyo",
    });
  } finally {
    await service.stop();
  }
});

it("keeps an interval reminder's next time when only its text changes", async () => {
  const agentId = "22222222-2222-4222-8222-222222222222";
  const runtime = {
    agentId,
    getService: () => null,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
  let clock = new Date("2026-10-11T10:00:00Z");
  const now = () => clock;
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const runner = createScheduledTaskRunner({
    agentId,
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({}),
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    now,
  });
  const action = createSharedRemindersEdgeAction({
    runner,
    agentId,
    now,
    delivery: {
      platform: "telegram",
      project: "test",
      connectorAccountId: "owner",
      chatId: "123456",
    },
  });
  const run = (parameters: HandlerOptions["parameters"]) =>
    action.handler(
      runtime,
      {
        id: crypto.randomUUID(),
        entityId: agentId,
        agentId,
        roomId: agentId,
        content: { text: "Change my water reminder", source: "test" },
      } as Memory,
      undefined,
      { parameters },
    );
  const created = await run({
    operation: "create",
    reminderText: "Drink water",
    everyMinutes: 120,
  });
  expect(created?.success, JSON.stringify(created)).toBe(true);
  const task = created?.data?.task as ScheduledTask;
  expect((await runner.fire(task.taskId)).state).toMatchObject({
    status: "fired",
    firedAt: "2026-10-11T10:00:00.000Z",
  });

  clock = new Date("2026-10-11T10:30:00Z");
  const updated = await run({
    operation: "update",
    taskId: task.taskId,
    newReminderText: "Drink a full glass of water",
  });
  expect(updated?.success, JSON.stringify(updated)).toBe(true);
  const updatedTask = updated?.data?.task as ScheduledTask;
  const replacement = (await runner.list()).find(
    (entry) => entry.taskId === updatedTask.taskId,
  ) as ScheduledTask;

  const dueAt = (iso: string) =>
    isScheduledTaskDue(replacement, { now: new Date(iso) });
  expect((await dueAt("2026-10-11T10:30:00Z")).due).toBe(false);
  expect((await dueAt("2026-10-11T11:59:00Z")).due).toBe(false);
  expect(await dueAt("2026-10-11T12:00:00Z")).toMatchObject({
    due: true,
    occurrenceAtIso: "2026-10-11T12:00:00.000Z",
  });
});

function createOneOffReminderHarness() {
  const agentId = "33333333-3333-4333-8333-333333333333";
  const runtime = {
    agentId,
    getService: () => null,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
  const clock = { now: new Date("2026-10-11T10:00:00Z") };
  const now = () => clock.now;
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const runner = createScheduledTaskRunner({
    agentId,
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({}),
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    now,
  });
  const action = createSharedRemindersEdgeAction({
    runner,
    agentId,
    now,
    delivery: {
      platform: "telegram",
      project: "test",
      connectorAccountId: "owner",
      chatId: "123456",
    },
  });
  const run = (parameters: HandlerOptions["parameters"]) =>
    action.handler(
      runtime,
      {
        id: crypto.randomUUID(),
        entityId: agentId,
        agentId,
        roomId: agentId,
        content: {
          text: "Change my call mom reminder to say call dad",
          source: "test",
        },
      } as Memory,
      undefined,
      { parameters },
    );
  const createAt3pm = async () => {
    const created = await run({
      operation: "create",
      reminderText: "Call mom",
      atIso: "2026-10-11T15:00:00Z",
    });
    expect(created?.success, JSON.stringify(created)).toBe(true);
    return created?.data?.task as ScheduledTask;
  };
  const editText = (taskId: string) =>
    run({ operation: "update", taskId, newReminderText: "Call dad" });
  const dueTasksAt = async (iso: string) => {
    const due: ScheduledTask[] = [];
    for (const entry of await runner.list()) {
      if ((await isScheduledTaskDue(entry, { now: new Date(iso) })).due) {
        due.push(entry);
      }
    }
    return due;
  };
  return { clock, runner, createAt3pm, editText, dueTasksAt };
}

it("does not send a one-off reminder again when only its text changes after it went off", async () => {
  const h = createOneOffReminderHarness();
  const task = await h.createAt3pm();
  h.clock.now = new Date("2026-10-11T15:00:30Z");
  expect((await h.runner.fire(task.taskId)).state.status).toBe("fired");

  h.clock.now = new Date("2026-10-11T15:10:00Z");
  const updated = await h.editText(task.taskId);
  expect(updated?.success, JSON.stringify(updated)).toBe(false);
  expect(updated?.text).toContain("already went off");

  const tasks = await h.runner.list();
  expect(tasks.map((entry) => entry.taskId)).toEqual([task.taskId]);
  expect(tasks[0]?.state.status).toBe("fired");
  expect(await h.dueTasksAt("2026-10-11T15:10:00Z")).toEqual([]);
});

it("keeps a snoozed one-off reminder's snoozed time when only its text changes", async () => {
  const h = createOneOffReminderHarness();
  const task = await h.createAt3pm();
  h.clock.now = new Date("2026-10-11T10:05:00Z");
  await h.runner.apply(task.taskId, "snooze", {
    untilIso: "2026-10-11T15:30:00Z",
  });

  h.clock.now = new Date("2026-10-11T10:10:00Z");
  const updated = await h.editText(task.taskId);
  expect(updated?.success, JSON.stringify(updated)).toBe(true);
  const replacement = updated?.data?.task as ScheduledTask;
  expect(replacement.promptInstructions).toBe("Call dad");

  expect(await h.dueTasksAt("2026-10-11T15:00:00Z")).toEqual([]);
  expect(
    (await h.dueTasksAt("2026-10-11T15:30:00Z")).map((entry) => entry.taskId),
  ).toEqual([replacement.taskId]);
});

it("sends a snoozed one-off reminder at its snoozed time, not at once, when only its text changes", async () => {
  const h = createOneOffReminderHarness();
  const task = await h.createAt3pm();
  h.clock.now = new Date("2026-10-11T15:00:30Z");
  await h.runner.fire(task.taskId);
  await h.runner.apply(task.taskId, "snooze", { minutes: 30 });

  h.clock.now = new Date("2026-10-11T15:10:00Z");
  const updated = await h.editText(task.taskId);
  expect(updated?.success, JSON.stringify(updated)).toBe(true);
  const replacement = updated?.data?.task as ScheduledTask;

  expect(await h.dueTasksAt("2026-10-11T15:10:00Z")).toEqual([]);
  expect(
    (await h.dueTasksAt("2026-10-11T15:31:00Z")).map((entry) => entry.taskId),
  ).toEqual([replacement.taskId]);
});
