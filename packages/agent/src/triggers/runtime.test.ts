/**
 * Unit tests for the trigger execution engine (`executeTriggerTask` and the
 * task-worker / list wiring around it).
 *
 * `executeTriggerTask` is the heart of the Automations UI: interval / cron /
 * event triggers all land here. It had zero coverage. These tests build real
 * trigger tasks via the production `buildTriggerConfig` + `buildTriggerMetadata`
 * helpers (the same path `actions/trigger.ts` uses) and drive
 * `executeTriggerTask` against a minimal in-memory runtime so the gating,
 * dispatch, deletion, and metric behavior is pinned without a real DB.
 */

import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { ServiceType, stringToUuid } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchRuntimeEventTriggers,
  executeTriggerTask,
  listTriggerTasks,
  readTriggerConfig,
  registerTriggerTaskWorker,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
} from "./runtime.ts";
import { buildTriggerConfig } from "./scheduling.ts";
import type { NormalizedTriggerDraft } from "./types.ts";

const AGENT_ID = stringToUuid("trigger-runtime-test-agent");

interface WorkflowDispatchCall {
  workflowId: string;
  payload?: Record<string, unknown>;
  options?: { idempotencyKey?: string };
}

interface PromptMessageCall {
  text: string;
  roomId: UUID;
  entityId: UUID;
}

interface MockRuntimeHandle {
  runtime: IAgentRuntime;
  dispatchCalls: WorkflowDispatchCall[];
  promptMessages: PromptMessageCall[];
  deletedTaskIds: UUID[];
  updatedTasks: Array<{ id: UUID; patch: Partial<Task> }>;
  warnings: unknown[][];
  notifyCalls: Array<Record<string, unknown>>;
  reportedErrors: Array<{
    scope: string;
    error: unknown;
    context?: Record<string, unknown>;
  }>;
  setTasks: (tasks: Task[]) => void;
  setDispatchResult: (
    result:
      | { ok: true; executionId?: string; dedup?: boolean }
      | { ok: false; error: string; code?: string },
  ) => void;
  setWorkflowServicePresent: (present: boolean) => void;
  setNotifyError: (error: Error | null) => void;
  setRuntimeSetting: (name: string, value: unknown) => void;
}

function makeRuntime(agentId: UUID = AGENT_ID): MockRuntimeHandle {
  const dispatchCalls: WorkflowDispatchCall[] = [];
  const promptMessages: PromptMessageCall[] = [];
  const deletedTaskIds: UUID[] = [];
  const updatedTasks: Array<{ id: UUID; patch: Partial<Task> }> = [];
  const warnings: unknown[][] = [];
  const notifyCalls: Array<Record<string, unknown>> = [];
  const reportedErrors: MockRuntimeHandle["reportedErrors"] = [];
  let notifyError: Error | null = null;
  const runtimeSettings = new Map<string, unknown>();
  const taskWorkers = new Map<string, unknown>();
  const eventHandlers = new Map<
    string,
    Array<(params: Record<string, unknown>) => Promise<void>>
  >();
  let tasks: Task[] = [];

  const messageService = {
    async handleMessage(
      _runtime: IAgentRuntime,
      message: {
        content: { text: string };
        roomId: UUID;
        entityId: UUID;
      },
    ) {
      promptMessages.push({
        text: message.content.text,
        roomId: message.roomId,
        entityId: message.entityId,
      });
      return {};
    },
  };

  const notificationService = {
    async notify(input: Record<string, unknown>) {
      notifyCalls.push(input);
      if (notifyError) throw notifyError;
    },
  };
  let dispatchResult: {
    ok: boolean;
    executionId?: string;
    dedup?: boolean;
    error?: string;
    code?: string;
  } = { ok: true, executionId: "exec-1" };
  let workflowServicePresent = true;

  const workflowService = {
    async execute(
      workflowId: string,
      payload?: Record<string, unknown>,
      options?: { idempotencyKey?: string },
    ) {
      dispatchCalls.push({ workflowId, payload, options });
      return dispatchResult;
    },
  };

  const runtime = {
    agentId,
    character: { name: "trigger-test" },
    messageService,
    logger: {
      info: vi.fn(),
      warn: vi.fn((...args: unknown[]) => {
        warnings.push(args);
      }),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getService: (name: string) => {
      if (name === "WORKFLOW_DISPATCH")
        return workflowServicePresent ? workflowService : null;
      if (name === ServiceType.NOTIFICATION) return notificationService;
      return null;
    },
    getSetting: (name: string) => runtimeSettings.get(name),
    getTaskWorker: (name: string) => taskWorkers.get(name),
    registerTaskWorker: (worker: { name: string }) => {
      taskWorkers.set(worker.name, worker);
    },
    registerEvent: (
      eventKind: string,
      handler: (params: Record<string, unknown>) => Promise<void>,
    ) => {
      eventHandlers.set(eventKind, [
        ...(eventHandlers.get(eventKind) ?? []),
        handler,
      ]);
    },
    getEvent: (eventKind: string) => eventHandlers.get(eventKind),
    emitEvent: async (eventKind: string, params: Record<string, unknown>) => {
      await Promise.all(
        (eventHandlers.get(eventKind) ?? []).map((handler) =>
          handler({ ...params, runtime }),
        ),
      );
    },
    getTasks: vi.fn(async () => tasks),
    getTask: vi.fn(
      async (id: UUID) => tasks.find((task) => task.id === id) ?? null,
    ),
    deleteTask: vi.fn(async (id: UUID) => {
      deletedTaskIds.push(id);
      tasks = tasks.filter((task) => task.id !== id);
    }),
    updateTask: vi.fn(async (id: UUID, patch: Partial<Task>) => {
      updatedTasks.push({ id, patch });
      tasks = tasks.map((task) =>
        task.id === id ? ({ ...task, ...patch } as Task) : task,
      );
    }),
    ensureConnection: vi.fn(async () => {}),
    getRoom: vi.fn(async () => null),
    reportError: vi.fn(
      (scope: string, error: unknown, context?: Record<string, unknown>) => {
        reportedErrors.push({ scope, error, context });
      },
    ),
  } as unknown as IAgentRuntime;

  return {
    runtime,
    dispatchCalls,
    promptMessages,
    deletedTaskIds,
    updatedTasks,
    warnings,
    notifyCalls,
    reportedErrors,
    setTasks: (nextTasks) => {
      tasks = nextTasks;
    },
    setDispatchResult: (result) => {
      dispatchResult = result;
    },
    setWorkflowServicePresent: (present) => {
      workflowServicePresent = present;
    },
    setNotifyError: (error) => {
      notifyError = error;
    },
    setRuntimeSetting: (name, value) => runtimeSettings.set(name, value),
  };
}

function makeDraft(
  overrides: Partial<NormalizedTriggerDraft>,
): NormalizedTriggerDraft {
  return {
    displayName: "Test Trigger",
    instructions: "Run the workflow",
    triggerType: "interval",
    wakeMode: "inject_now",
    enabled: true,
    createdBy: "tester",
    intervalMs: 60_000,
    kind: "workflow",
    workflowId: "wf-1",
    workflowName: "Test Workflow",
    ...overrides,
  };
}

let taskSeq = 0;

function makeTriggerTask(
  draftOverrides: Partial<NormalizedTriggerDraft>,
  options: {
    enabled?: boolean;
    runCount?: number;
    maxRuns?: number;
    kindOverride?: "workflow" | "prompt";
  } = {},
): Task {
  const draft = makeDraft(draftOverrides);
  const triggerId = stringToUuid(`trigger-${taskSeq}`);
  const taskId = stringToUuid(`task-${taskSeq}`);
  taskSeq += 1;
  let trigger = buildTriggerConfig({ draft, triggerId });
  trigger = {
    ...trigger,
    enabled: options.enabled ?? true,
    runCount: options.runCount ?? 0,
    maxRuns: options.maxRuns ?? trigger.maxRuns,
    nextRunAtMs: Date.now() + 60_000,
  };
  return {
    id: taskId,
    name: TRIGGER_TASK_NAME,
    description: trigger.displayName,
    tags: [...TRIGGER_TASK_TAGS],
    metadata: {
      updatedAt: Date.now(),
      updateInterval: 60_000,
      trigger,
    },
  } as unknown as Task;
}

describe("executeTriggerTask", () => {
  let handle: MockRuntimeHandle;

  beforeEach(() => {
    handle = makeRuntime();
    taskSeq = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a workflow-kind interval trigger from the scheduler", async () => {
    const task = makeTriggerTask({ triggerType: "interval" });
    const before = readTriggerConfig(task);
    expect(before?.runCount).toBe(0);

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(result.taskDeleted).toBe(false);
    expect(result.executionId).toBe("exec-1");
    expect(handle.dispatchCalls).toHaveLength(1);
    expect(handle.dispatchCalls[0]?.workflowId).toBe("wf-1");

    // runCount incremented on the persisted metadata.
    expect(handle.updatedTasks).toHaveLength(1);
    const persisted = readTriggerConfig({
      ...task,
      metadata: handle.updatedTasks[0]?.patch.metadata,
    } as Task);
    expect(persisted?.runCount).toBe(1);
    expect(persisted?.lastStatus).toBe("success");
  });

  it("does not emit the success notification for legacy or system triggers without explicit provenance", async () => {
    const task = makeTriggerTask({
      triggerType: "interval",
      displayName: "User-sounding internal health check",
      createdBy: String(stringToUuid("internal-scheduler")),
      notifyOnOutcome: false,
    });
    await executeTriggerTask(handle.runtime, task, { source: "scheduler" });
    expect(handle.notifyCalls).toHaveLength(0);
  });

  it("does not notify on failure for a legacy trigger without explicit provenance", async () => {
    handle.setDispatchResult({ ok: false, error: "workflow blew up" });
    const task = makeTriggerTask({
      triggerType: "interval",
      displayName: "Legacy nightly backup",
    });
    // A trigger persisted before `notifyOnOutcome` existed carries no such key.
    const persistedTrigger = readTriggerConfig(task);
    if (!persistedTrigger) throw new Error("trigger config missing");
    delete (persistedTrigger as { notifyOnOutcome?: boolean }).notifyOnOutcome;
    expect(persistedTrigger.notifyOnOutcome).toBeUndefined();

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(handle.notifyCalls).toHaveLength(0);
  });

  it("allows an explicit per-runtime diagnostic override", async () => {
    handle.setRuntimeSetting("ELIZA_DEBUG_TRIGGER_NOTIFICATIONS", "1");
    const task = makeTriggerTask({
      triggerType: "interval",
      notifyOnOutcome: false,
    });
    await executeTriggerTask(handle.runtime, task, { source: "scheduler" });
    expect(handle.notifyCalls).toHaveLength(1);
  });

  it("emits a low-priority completion notification on a successful run (#10697)", async () => {
    const task = makeTriggerTask({
      triggerType: "interval",
      displayName: "Nightly backup",
      notifyOnOutcome: true,
    });

    await executeTriggerTask(handle.runtime, task, { source: "scheduler" });

    expect(handle.notifyCalls).toHaveLength(1);
    const notif = handle.notifyCalls[0];
    expect(notif.title).toBe('Automation "Nightly backup" completed');
    expect(notif.category).toBe("workflow");
    expect(notif.priority).toBe("low");
    expect(notif.source).toBe("trigger");
    // Grouped per trigger so a frequently scheduled automation updates one
    // rail entry instead of spamming a fresh notification every run.
    expect(notif.groupKey).toBe(`trigger:${task.id}`);
  });

  it("emits a high-priority failure notification when the dispatch errors", async () => {
    handle.setDispatchResult({ ok: false, error: "workflow blew up" });
    const task = makeTriggerTask({
      triggerType: "interval",
      displayName: "Nightly backup",
      notifyOnOutcome: true,
    });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(handle.notifyCalls).toHaveLength(1);
    const notif = handle.notifyCalls[0];
    expect(notif.title).toBe('Automation "Nightly backup" failed');
    expect(notif.category).toBe("workflow");
    expect(notif.priority).toBe("high");
    expect(notif.groupKey).toBe(`trigger:${task.id}`);
  });

  it("reports notification failures without changing trigger success", async () => {
    const notifyError = new Error("notification store unavailable");
    handle.setNotifyError(notifyError);
    const task = makeTriggerTask({
      triggerType: "interval",
      notifyOnOutcome: true,
    });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    await vi.waitFor(() => expect(handle.reportedErrors).toHaveLength(1));
    expect(handle.reportedErrors[0]).toMatchObject({
      scope: "TriggerRuntime.notifySuccess",
      error: notifyError,
      context: { taskId: task.id },
    });
  });

  it("dispatches a workflow-kind cron trigger and recomputes the next schedule", async () => {
    const task = makeTriggerTask({
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
    });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(result.taskDeleted).toBe(false);
    expect(handle.dispatchCalls).toHaveLength(1);
    const persisted = readTriggerConfig({
      ...task,
      metadata: handle.updatedTasks[0]?.patch.metadata,
    } as Task);
    expect(persisted?.runCount).toBe(1);
    expect(typeof persisted?.nextRunAtMs).toBe("number");
  });

  it("surfaces the re-armed updateInterval in the result so the worker hands it back as nextInterval (#12030)", async () => {
    // A cron trigger re-arms with a per-fire interval (ms until the next fire),
    // which varies. executeTriggerTask persists it — and must ALSO return it, so
    // the task worker can pass it to the scheduler as `nextInterval`. Without
    // this the worker returned undefined and the scheduler's success path
    // clobbered the cadence with a frozen `baseInterval`, drifting to wrong days.
    const task = makeTriggerTask({
      triggerType: "cron",
      cronExpression: "0 9 * * 1-5",
    });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.taskDeleted).toBe(false);
    const persistedInterval = (
      handle.updatedTasks[0]?.patch.metadata as { updateInterval?: number }
    )?.updateInterval;
    expect(typeof persistedInterval).toBe("number");
    // The result carries the SAME interval that was persisted (not undefined).
    expect(result.updateInterval).toBe(persistedInterval);
  });

  it("dispatches an event trigger when the event-source eventKind matches", async () => {
    const task = makeTriggerTask({
      triggerType: "event",
      eventKind: "MESSAGE_RECEIVED",
    });
    handle.setTasks([task]);

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "event",
      event: { kind: "MESSAGE_RECEIVED", payload: { text: "hi" } },
    });

    expect(result.status).toBe("success");
    expect(handle.dispatchCalls).toHaveLength(1);
    // Event payload is forwarded to the workflow dispatch.
    expect(handle.dispatchCalls[0]?.payload).toMatchObject({
      eventKind: "MESSAGE_RECEIVED",
      eventPayload: { text: "hi" },
    });
  });

  it("skips an event trigger when the event-source eventKind does not match", async () => {
    const task = makeTriggerTask({
      triggerType: "event",
      eventKind: "MESSAGE_RECEIVED",
    });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "event",
      event: { kind: "REACTION_RECEIVED", payload: {} },
    });

    expect(result.status).toBe("skipped");
    expect(result.taskDeleted).toBe(false);
    expect(handle.dispatchCalls).toHaveLength(0);
    expect(handle.updatedTasks).toHaveLength(0);
  });

  it("dispatches only when a nested event filter matches the Smithers event", async () => {
    const task = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
      eventFilter: {
        event: {
          type: "NodeFinished",
          workflowId: "source-workflow",
          nodeId: "collect",
        },
      },
    });
    handle.setTasks([task]);

    const matching = await executeTriggerTask(handle.runtime, task, {
      source: "event",
      event: {
        kind: "workflow_run_event",
        payload: {
          event: {
            type: "NodeFinished",
            workflowId: "source-workflow",
            nodeId: "collect",
            output: { count: 3 },
          },
        },
      },
    });

    expect(matching.status).toBe("success");
    expect(handle.dispatchCalls).toHaveLength(1);

    const nonMatching = await executeTriggerTask(handle.runtime, task, {
      source: "event",
      event: {
        kind: "workflow_run_event",
        payload: {
          event: {
            type: "NodeFinished",
            workflowId: "source-workflow",
            nodeId: "publish",
          },
        },
      },
    });

    expect(nonMatching.status).toBe("skipped");
    expect(handle.dispatchCalls).toHaveLength(1);

    const nullFilter = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
      eventFilter: { event: { output: null } },
    });
    const nonNullPayload = await executeTriggerTask(
      handle.runtime,
      nullFilter,
      {
        source: "event",
        event: {
          kind: "workflow_run_event",
          payload: { event: { output: "not-null" } },
        },
      },
    );

    expect(nonNullPayload.status).toBe("skipped");
    expect(handle.dispatchCalls).toHaveLength(1);
  });

  it("skips a non-event trigger fired from an event source", async () => {
    const task = makeTriggerTask({ triggerType: "interval" });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "event",
      event: { kind: "MESSAGE_RECEIVED", payload: {} },
    });

    expect(result.status).toBe("skipped");
    expect(handle.dispatchCalls).toHaveLength(0);
  });

  it("skips a disabled trigger unless force is set", async () => {
    const task = makeTriggerTask(
      { triggerType: "interval" },
      { enabled: false },
    );

    const skipped = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });
    expect(skipped.status).toBe("skipped");
    expect(handle.dispatchCalls).toHaveLength(0);

    const forced = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
      force: true,
    });
    expect(forced.status).toBe("success");
    expect(handle.dispatchCalls).toHaveLength(1);
    expect(handle.updatedTasks.at(-1)?.patch.metadata).toMatchObject({
      trigger: {
        enabled: false,
        lastStatus: "success",
      },
    });
    expect(
      (
        handle.updatedTasks.at(-1)?.patch.metadata as
          | { trigger?: { lastError?: string } }
          | undefined
      )?.trigger?.lastError,
    ).toBeUndefined();
  });

  it("warns and skips a trigger whose kind is neither workflow nor prompt", async () => {
    const task = makeTriggerTask({ triggerType: "interval" });
    // Force an unknown kind onto the persisted trigger config to exercise the
    // guard (the public schema only allows "workflow" | "prompt").
    const meta = task.metadata as Record<string, unknown>;
    const trigger = meta.trigger as Record<string, unknown>;
    trigger.kind = "text";

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("skipped");
    expect(result.taskDeleted).toBe(false);
    expect(handle.dispatchCalls).toHaveLength(0);
    expect(handle.promptMessages).toHaveLength(0);
    const warned = handle.warnings.some((args) =>
      JSON.stringify(args).includes("not workflow or prompt"),
    );
    expect(warned).toBe(true);
  });

  it("dispatches a prompt-kind trigger via the message service", async () => {
    const task = makeTriggerTask(
      {
        triggerType: "interval",
        kind: "prompt",
        instructions: "Summarize today's calendar",
        // A prompt trigger carries no workflow target.
        workflowId: undefined,
        workflowName: undefined,
      },
      { kindOverride: "prompt" },
    );

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(result.taskDeleted).toBe(false);
    // No workflow dispatch — the prompt path runs instead.
    expect(handle.dispatchCalls).toHaveLength(0);
    expect(handle.promptMessages).toHaveLength(1);
    // The injected turn carries provenance framing so the model knows this is
    // a fired trigger to act on, not ambient chatter to interpret.
    expect(handle.promptMessages[0]?.text).toBe(
      'Scheduled trigger "Test Trigger" fired. Do this now: Summarize today\'s calendar',
    );
    expect(handle.runtime.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        worldId: stringToUuid(`trigger-world:${AGENT_ID}`),
      }),
    );

    // A TriggerRunRecord is appended and runCount incremented, same as workflow.
    const persisted = readTriggerConfig({
      ...task,
      metadata: handle.updatedTasks[0]?.patch.metadata,
    } as Task);
    expect(persisted?.runCount).toBe(1);
    expect(persisted?.kind).toBe("prompt");
  });

  it("deletes the task when maxRuns is already reached (before dispatch)", async () => {
    const task = makeTriggerTask(
      { triggerType: "interval" },
      { runCount: 3, maxRuns: 3 },
    );

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("skipped");
    expect(result.taskDeleted).toBe(true);
    expect(handle.deletedTaskIds).toContain(task.id);
    // No dispatch happens once the run budget is exhausted.
    expect(handle.dispatchCalls).toHaveLength(0);
  });

  it("deletes the task after the run that reaches maxRuns", async () => {
    const task = makeTriggerTask(
      { triggerType: "interval" },
      { runCount: 1, maxRuns: 2 },
    );

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(result.taskDeleted).toBe(true);
    expect(handle.dispatchCalls).toHaveLength(1);
    expect(handle.deletedTaskIds).toContain(task.id);
  });

  it("deletes a once trigger after a single fire", async () => {
    const task = makeTriggerTask({
      triggerType: "once",
      scheduledAtIso: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(result.taskDeleted).toBe(true);
    expect(handle.deletedTaskIds).toContain(task.id);
  });

  it("reports an error when workflow dispatch fails", async () => {
    handle.setDispatchResult({ ok: false, error: "boom" });
    const task = makeTriggerTask({ triggerType: "interval" });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("boom");
    // The run still records and persists (error is observable, not swallowed).
    expect(handle.updatedTasks).toHaveLength(1);
  });

  it("disables the trigger with one final notification when the workflow no longer exists", async () => {
    handle.setDispatchResult({
      ok: false,
      error: "Workflow not found: wf-gone",
      code: "workflow_not_found",
    });
    const task = makeTriggerTask({
      triggerType: "interval",
      displayName: "Device health check",
      notifyOnOutcome: true,
    });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(result.taskDeleted).toBe(true);
    expect(handle.runtime.deleteTask).toHaveBeenCalledWith(task.id);
    expect(handle.notifyCalls).toHaveLength(1);
    const notif = handle.notifyCalls[0];
    expect(notif.title).toBe('Automation "Device health check" disabled');
    expect(notif.body).toContain("no longer exists");
  });

  it("keeps retrying an uncoded transient dispatch failure (task stays)", async () => {
    handle.setDispatchResult({ ok: false, error: "engine busy" });
    const task = makeTriggerTask({ triggerType: "interval" });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(result.taskDeleted).toBe(false);
    expect(handle.runtime.deleteTask).not.toHaveBeenCalled();
  });

  it("reports an error when the WORKFLOW_DISPATCH service never registers (bounded wait)", async () => {
    // The dispatcher lookup waits out the deferred-boot window before giving
    // up, so the absent-service verdict only lands after the bounded wait.
    vi.useFakeTimers();
    try {
      handle.setWorkflowServicePresent(false);
      const task = makeTriggerTask({ triggerType: "interval" });

      const pending = executeTriggerTask(handle.runtime, task, {
        source: "scheduler",
      });
      await vi.advanceTimersByTimeAsync(16_000);
      const result = await pending;

      expect(result.status).toBe("error");
      expect(result.error).toContain("workflow subsystem unavailable");
      expect(handle.dispatchCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a dispatcher that registers during the deferred-boot window (no spurious failure)", async () => {
    // plugin-workflow loads in the deferred boot phase; a trigger firing
    // before its init must wait for the registration instead of emitting an
    // 'Automation failed' notification for a race that resolves itself.
    vi.useFakeTimers();
    try {
      handle.setWorkflowServicePresent(false);
      const task = makeTriggerTask({ triggerType: "interval" });

      const pending = executeTriggerTask(handle.runtime, task, {
        source: "scheduler",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      handle.setWorkflowServicePresent(true);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.status).toBe("success");
      expect(handle.dispatchCalls).toHaveLength(1);
      expect(
        handle.notifyCalls.filter((n) =>
          String(n.title ?? "").includes("failed"),
        ),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a task with no trigger config", async () => {
    const task = {
      id: stringToUuid("no-trigger"),
      name: TRIGGER_TASK_NAME,
      tags: [...TRIGGER_TASK_TAGS],
      metadata: {},
    } as unknown as Task;

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });
    expect(result.status).toBe("skipped");
    expect(handle.dispatchCalls).toHaveLength(0);
  });
});

describe("runtime event trigger bridge", () => {
  let handle: MockRuntimeHandle;

  beforeEach(() => {
    handle = makeRuntime();
    taskSeq = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches only an exact Smithers step match through runtime.emitEvent", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
      eventFilter: {
        event: {
          type: "NodeFinished",
          workflowId: "source-workflow",
          nodeId: "collect",
        },
      },
    });
    handle.setTasks([target]);

    registerTriggerTaskWorker(handle.runtime);
    registerTriggerTaskWorker(handle.runtime);
    expect(handle.runtime.getEvent("workflow_run_event")).toHaveLength(1);
    expect(handle.runtime.getEvent("MESSAGE_RECEIVED")).toBeUndefined();

    await handle.runtime.emitEvent("workflow_run_event", {
      runtime: handle.runtime,
      source: "runtime",
      onComplete: () => undefined,
      anotherCallback: () => undefined,
      event: {
        id: "smithers-non-match",
        type: "NodeFinished",
        workflowId: "source-workflow",
        nodeId: "publish",
      },
    } as never);
    expect(handle.dispatchCalls).toHaveLength(0);

    await handle.runtime.emitEvent("workflow_run_event", {
      runtime: handle.runtime,
      event: {
        id: "smithers-match",
        type: "NodeFinished",
        workflowId: "source-workflow",
        nodeId: "collect",
        output: { count: 3 },
      },
    } as never);

    await vi.waitFor(() => expect(handle.dispatchCalls).toHaveLength(1));
    expect(handle.dispatchCalls[0]).toMatchObject({
      workflowId: "wf-1",
      payload: {
        eventKind: "workflow_run_event",
        eventPayload: {
          event: {
            type: "NodeFinished",
            workflowId: "source-workflow",
            nodeId: "collect",
          },
        },
      },
      options: {
        idempotencyKey: expect.stringMatching(
          new RegExp(
            `^event:${readTriggerConfig(target)?.triggerId}:[a-f0-9]{64}$`,
          ),
        ),
      },
    });
    const eventPayload = handle.dispatchCalls[0]?.payload?.eventPayload;
    expect(eventPayload).toBeDefined();
    expect((eventPayload as Record<string, unknown>).runtime).toBeUndefined();
    expect((eventPayload as Record<string, unknown>).source).toBeUndefined();
    expect(
      (eventPayload as Record<string, unknown>).onComplete,
    ).toBeUndefined();
    expect(
      (eventPayload as Record<string, unknown>).anotherCallback,
    ).toBeUndefined();
    expect(handle.reportedErrors).toHaveLength(0);
  });

  it("reports trigger-list failures without rejecting the source event", async () => {
    const failure = new Error("trigger store offline");
    handle.runtime.getTasks = vi.fn(async () => {
      throw failure;
    });
    registerTriggerTaskWorker(handle.runtime);

    await expect(
      handle.runtime.emitEvent("workflow_run_event", {
        runtime: handle.runtime,
        event: { type: "NodeFinished" },
      } as never),
    ).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(handle.reportedErrors).toContainEqual({
        scope: "TriggerRuntime.eventBridge",
        error: failure,
        context: { eventKind: "workflow_run_event" },
      }),
    );
  });

  it("does not block the source event while a workflow trigger is running", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    handle.setTasks([target]);
    let releaseDispatch: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseDispatch = () => resolve({ status: "finished" });
        }),
    );
    const workflowService = handle.runtime.getService(
      "WORKFLOW_DISPATCH",
    ) as unknown as { execute: typeof execute };
    workflowService.execute = execute;
    registerTriggerTaskWorker(handle.runtime);

    await expect(
      handle.runtime.emitEvent("workflow_run_event", {
        runtime: handle.runtime,
        event: { type: "NodeFinished" },
      } as never),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(releaseDispatch).toBeTypeOf("function"));

    releaseDispatch?.();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  });

  it("isolates a failing trigger from sibling event dispatches", async () => {
    const first = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    const second = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    handle.setTasks([first, second]);
    const failure = new Error("first trigger write failed");
    handle.runtime.updateTask = vi.fn(async (id: UUID) => {
      if (id === first.id) throw failure;
    });

    await expect(
      dispatchRuntimeEventTriggers(handle.runtime, "workflow_run_event", {}),
    ).resolves.toBeUndefined();
    expect(handle.dispatchCalls).toHaveLength(2);
    expect(handle.reportedErrors).toContainEqual({
      scope: "TriggerRuntime.eventDispatch",
      error: failure,
      context: {
        eventKind: "workflow_run_event",
        taskId: first.id,
      },
    });
  });

  it("serializes concurrent events per trigger and refreshes persisted state", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
      maxRuns: 1,
    });
    handle.setTasks([target]);
    let releaseFirst: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<{ ok: true; executionId: string }>((resolve) => {
          releaseFirst = () => resolve({ ok: true, executionId: "first" });
        }),
    );
    const workflowService = handle.runtime.getService(
      "WORKFLOW_DISPATCH",
    ) as unknown as { execute: typeof execute };
    workflowService.execute = execute;
    registerTriggerTaskWorker(handle.runtime);

    await Promise.all([
      handle.runtime.emitEvent("workflow_run_event", {
        runtime: handle.runtime,
        event: { id: "event-1", type: "NodeFinished" },
      } as never),
      handle.runtime.emitEvent("workflow_run_event", {
        runtime: handle.runtime,
        event: { id: "event-2", type: "NodeFinished" },
      } as never),
    ]);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    releaseFirst?.();
    await vi.waitFor(() => expect(handle.deletedTaskIds).toEqual([target.id]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The queued second event refreshes the task after the first reaches
    // maxRuns and therefore cannot dispatch a deleted stale snapshot.
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves a disable saved while an event run is in flight", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    handle.setTasks([target]);
    let releaseFirst: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<{ ok: true; executionId: string }>((resolve) => {
          releaseFirst = () => resolve({ ok: true, executionId: "first" });
        }),
    );
    const workflowService = handle.runtime.getService(
      "WORKFLOW_DISPATCH",
    ) as unknown as { execute: typeof execute };
    workflowService.execute = execute;
    registerTriggerTaskWorker(handle.runtime);

    await handle.runtime.emitEvent("workflow_run_event", {
      runtime: handle.runtime,
      event: { id: "event-1", type: "NodeFinished" },
    } as never);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await handle.runtime.emitEvent("workflow_run_event", {
      runtime: handle.runtime,
      event: { id: "event-2", type: "NodeFinished" },
    } as never);
    await vi.waitFor(() =>
      expect(handle.runtime.getTasks).toHaveBeenCalledTimes(2),
    );

    const metadata = target.metadata as unknown as {
      trigger: Record<string, unknown>;
    };
    handle.setTasks([
      {
        ...target,
        metadata: {
          ...metadata,
          trigger: { ...metadata.trigger, enabled: false },
        },
      } as Task,
    ]);
    releaseFirst?.();

    await vi.waitFor(() => expect(handle.updatedTasks).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).toHaveBeenCalledOnce();
    expect(
      readTriggerConfig({
        ...target,
        metadata: handle.updatedTasks[0]?.patch.metadata,
      } as Task),
    ).toMatchObject({ enabled: false, runCount: 1 });
  });

  it("shares one discovery query per turn and re-queries for a newly saved trigger", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    handle.setTasks([target]);
    registerTriggerTaskWorker(handle.runtime);

    await Promise.all([
      handle.runtime.emitEvent("workflow_run_event", {
        runtime: handle.runtime,
        event: { id: "event-1", type: "NodeFinished" },
      } as never),
      handle.runtime.emitEvent("workflow_run_event", {
        runtime: handle.runtime,
        event: { id: "event-2", type: "NodeFinished" },
      } as never),
    ]);
    await vi.waitFor(() => expect(handle.dispatchCalls).toHaveLength(2));
    // Both events were observed before the batched query was issued, so they
    // share it: two events cost one task-store read, not one read each.
    expect(handle.runtime.getTasks).toHaveBeenCalledTimes(1);

    const newlySaved = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    handle.setTasks([target, newlySaved]);
    await handle.runtime.emitEvent("workflow_run_event", {
      runtime: handle.runtime,
      event: { id: "event-3", type: "NodeFinished" },
    } as never);
    await vi.waitFor(() => expect(handle.dispatchCalls).toHaveLength(4));
    // A later turn never reuses the earlier snapshot, so the trigger saved in
    // between is visible to the third event.
    expect(handle.runtime.getTasks).toHaveBeenCalledTimes(2);
  });

  it("sees create and enable writes while an older discovery is still in flight", async () => {
    async function expectMutationVisible(
      initialTasks: Task[],
      currentTask: Task,
      eventPrefix: string,
    ): Promise<void> {
      const lane = makeRuntime(stringToUuid(`owner-${eventPrefix}`));
      lane.setTasks(initialTasks);
      let releaseInitialLookup: (() => void) | undefined;
      const initialLookup = new Promise<void>((resolve) => {
        releaseInitialLookup = resolve;
      });
      const getTasks = vi.fn(async () => {
        const callNumber = getTasks.mock.calls.length;
        if (callNumber <= 1) {
          await initialLookup;
          return initialTasks;
        }
        return [currentTask];
      });
      lane.runtime.getTasks = getTasks;
      registerTriggerTaskWorker(lane.runtime);

      await lane.runtime.emitEvent("workflow_run_event", {
        event: { id: `${eventPrefix}-before`, type: "NodeFinished" },
      } as never);
      await vi.waitFor(() => expect(getTasks).toHaveBeenCalledTimes(1));

      lane.setTasks([currentTask]);
      await lane.runtime.emitEvent("workflow_run_event", {
        event: { id: `${eventPrefix}-after`, type: "NodeFinished" },
      } as never);
      try {
        await vi.waitFor(() => expect(getTasks).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(lane.dispatchCalls).toHaveLength(1));
      } finally {
        releaseInitialLookup?.();
      }
      expect(
        (
          lane.dispatchCalls[0]?.payload?.eventPayload as {
            event?: { id?: string };
          }
        )?.event?.id,
      ).toBe(`${eventPrefix}-after`);
    }

    const created = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    await expectMutationVisible([], created, "create");

    const disabled = makeTriggerTask(
      {
        triggerType: "event",
        eventKind: "workflow_run_event",
      },
      { enabled: false },
    );
    const disabledTrigger = readTriggerConfig(disabled);
    if (!disabledTrigger) throw new Error("disabled trigger config missing");
    const enabled = {
      ...disabled,
      metadata: {
        ...(disabled.metadata as Record<string, unknown>),
        trigger: { ...disabledTrigger, enabled: true },
      },
    } as Task;
    await expectMutationVisible([disabled], enabled, "enable");
  });

  it("keeps event discovery and dispatch isolated by runtime owner", async () => {
    const ownerA = makeRuntime(stringToUuid("workflow-event-owner-a"));
    const ownerB = makeRuntime(stringToUuid("workflow-event-owner-b"));
    ownerA.setTasks([
      makeTriggerTask({
        triggerType: "event",
        eventKind: "workflow_run_event",
        workflowId: "target-owner-a",
      }),
    ]);
    ownerB.setTasks([
      makeTriggerTask({
        triggerType: "event",
        eventKind: "workflow_run_event",
        workflowId: "target-owner-b",
      }),
    ]);
    registerTriggerTaskWorker(ownerA.runtime);
    registerTriggerTaskWorker(ownerB.runtime);

    await ownerA.runtime.emitEvent("workflow_run_event", {
      event: { id: "owner-a-event", type: "NodeFinished" },
    } as never);
    await vi.waitFor(() => expect(ownerA.dispatchCalls).toHaveLength(1));
    expect(ownerA.dispatchCalls[0]?.workflowId).toBe("target-owner-a");
    expect(ownerB.dispatchCalls).toHaveLength(0);
  });

  it("rechecks disabled and deleted tasks from a stale discovery snapshot", async () => {
    const stale = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    const staleTrigger = readTriggerConfig(stale);
    if (!staleTrigger) throw new Error("trigger config missing");
    const disabled = {
      ...stale,
      metadata: {
        ...(stale.metadata as Record<string, unknown>),
        trigger: { ...staleTrigger, enabled: false },
      },
    } as Task;
    handle.runtime.getTasks = vi.fn(async () => [stale]);

    handle.setTasks([disabled]);
    await dispatchRuntimeEventTriggers(handle.runtime, "workflow_run_event", {
      event: { id: "after-disable", type: "NodeFinished" },
    });
    expect(handle.dispatchCalls).toHaveLength(0);

    handle.setTasks([]);
    await dispatchRuntimeEventTriggers(handle.runtime, "workflow_run_event", {
      event: { id: "after-delete", type: "NodeFinished" },
    });
    expect(handle.dispatchCalls).toHaveLength(0);
    expect(handle.runtime.getTask).toHaveBeenCalledTimes(2);
  });

  it("dispatches every distinct rapid event for the same trigger", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    handle.setTasks([target]);

    await Promise.all([
      dispatchRuntimeEventTriggers(handle.runtime, "workflow_run_event", {
        event: { id: "distinct-event-a", type: "NodeFinished" },
      }),
      dispatchRuntimeEventTriggers(handle.runtime, "workflow_run_event", {
        event: { id: "distinct-event-b", type: "NodeFinished" },
      }),
    ]);

    expect(handle.dispatchCalls).toHaveLength(2);
    expect(
      handle.dispatchCalls
        .map(
          (call) =>
            (call.payload?.eventPayload as { event?: { id?: string } })?.event
              ?.id,
        )
        .sort(),
    ).toEqual(["distinct-event-a", "distinct-event-b"]);
    expect(handle.dispatchCalls[0]?.options?.idempotencyKey).not.toBe(
      handle.dispatchCalls[1]?.options?.idempotencyKey,
    );
  });

  it("derives the same durable dispatch key when a Smithers event is replayed", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
    });
    handle.setTasks([target]);
    registerTriggerTaskWorker(handle.runtime);
    const emitted = {
      runtime: handle.runtime,
      event: { id: "smithers-event-42", type: "NodeFinished" },
    } as never;

    await handle.runtime.emitEvent("workflow_run_event", emitted);
    await vi.waitFor(() => expect(handle.dispatchCalls).toHaveLength(1));
    await handle.runtime.emitEvent("workflow_run_event", emitted);
    await vi.waitFor(() => expect(handle.dispatchCalls).toHaveLength(2));

    expect(handle.dispatchCalls[0]?.options?.idempotencyKey).toBe(
      handle.dispatchCalls[1]?.options?.idempotencyKey,
    );
  });

  it("does not count an idempotently deduplicated Smithers replay as a new run", async () => {
    const target = makeTriggerTask({
      triggerType: "event",
      eventKind: "workflow_run_event",
      maxRuns: 2,
    });
    handle.setTasks([target]);
    handle.setDispatchResult({
      ok: true,
      executionId: "existing-execution",
      dedup: true,
    });

    const result = await executeTriggerTask(handle.runtime, target, {
      source: "event",
      event: {
        kind: "workflow_run_event",
        payload: {
          event: { id: "smithers-event-42", type: "NodeFinished" },
        },
      },
    });

    expect(result).toMatchObject({
      status: "skipped",
      taskDeleted: false,
      executionId: "existing-execution",
    });
    expect(handle.runtime.updateTask).not.toHaveBeenCalled();
    expect(handle.runtime.deleteTask).not.toHaveBeenCalled();
    expect(readTriggerConfig(target)?.runCount).toBe(0);
  });

  it("never restarts the workflow that emitted the event", async () => {
    const selfTrigger = makeTriggerTask(
      {
        triggerType: "event",
        eventKind: "workflow_run_event",
        workflowId: "wf-self",
      },
      { maxRuns: 0 },
    );
    handle.setTasks([selfTrigger]);
    registerTriggerTaskWorker(handle.runtime);

    await handle.runtime.emitEvent("workflow_run_event", {
      event: {
        id: "run-self:1",
        runId: "run-self",
        workflowId: "wf-self",
        type: "NodeFinished",
      },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handle.dispatchCalls).toHaveLength(0);
    expect(
      handle.warnings.some((entry) =>
        String(entry[1]).includes("skipping self-trigger"),
      ),
    ).toBe(true);
  });

  it("quiesces a mutually referential trigger chain instead of running forever", async () => {
    // wf-a's events start wf-b and wf-b's events start wf-a. Each dispatched
    // run emits its own event under a fresh run id, so nothing about durable
    // event identity can collapse the cycle; only ancestry can stop it.
    const aToB = makeTriggerTask(
      {
        triggerType: "event",
        eventKind: "workflow_run_event",
        workflowId: "wf-b",
      },
      { maxRuns: 0 },
    );
    const bToA = makeTriggerTask(
      {
        triggerType: "event",
        eventKind: "workflow_run_event",
        workflowId: "wf-a",
      },
      { maxRuns: 0 },
    );
    handle.setTasks([aToB, bToA]);

    // Production ordering: WORKFLOW_DISPATCH awaits executeWorkflow, and a run
    // emits every one of its events BEFORE that promise resolves. Deferring the
    // emit to a later round (the previous shape here) inverts that, and made
    // this test pass against a chain guard that never fired in production.
    let runSeq = 0;
    const execute = vi.fn(
      async (
        workflowId: string,
        _triggerData: Record<string, unknown>,
        options?: { triggerChainDepth?: number },
      ) => {
        runSeq += 1;
        const runId = `run-${runSeq}`;
        // Bound the harness itself so a genuinely unbounded chain fails the
        // assertion below instead of hanging the suite.
        if (runSeq <= 30) {
          await handle.runtime.emitEvent("workflow_run_event", {
            event: {
              id: `${runId}:1`,
              runId,
              workflowId,
              type: "NodeFinished",
            },
            triggerChainDepth: options?.triggerChainDepth,
          } as never);
        }
        return { ok: true as const, executionId: runId };
      },
    );
    (
      handle.runtime.getService("WORKFLOW_DISPATCH") as unknown as {
        execute: typeof execute;
      }
    ).execute = execute;
    registerTriggerTaskWorker(handle.runtime);

    await handle.runtime.emitEvent("workflow_run_event", {
      event: {
        id: "seed:1",
        runId: "run-seed",
        workflowId: "wf-a",
        type: "NodeFinished",
      },
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 20));

    // The chain must quiesce on its own, well inside the harness cutoff. If
    // ancestry is not actually bounding it, runSeq runs away to 30.
    expect(execute.mock.calls.length).toBeLessThanOrEqual(
      5, // MAX_EVENT_TRIGGER_CHAIN_DEPTH (4) + the seed hop
    );
    expect(execute.mock.calls.length).toBeGreaterThan(0);

    // An ancestry limit belongs to one execution chain, not the workflow id.
    // A later external event for the same workflow must still be eligible.
    const priorCalls = execute.mock.calls.length;
    handle.setTasks([aToB]);
    await handle.runtime.emitEvent("workflow_run_event", {
      event: {
        id: "later:1",
        runId: "run-later",
        workflowId: "wf-a",
        type: "NodeFinished",
      },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute.mock.calls.length).toBe(priorCalls + 1);
  });

  it("dispatches more than sixty distinct valid events without loss", async () => {
    const target = makeTriggerTask(
      {
        triggerType: "event",
        eventKind: "workflow_run_event",
        workflowId: "wf-target",
      },
      { maxRuns: 0 },
    );
    handle.setTasks([target]);
    registerTriggerTaskWorker(handle.runtime);

    for (let index = 0; index < 65; index += 1) {
      await handle.runtime.emitEvent("workflow_run_event", {
        event: {
          id: `flood-${index}`,
          runId: `run-flood-${index}`,
          workflowId: "wf-source",
          type: "NodeFinished",
        },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(handle.dispatchCalls).toHaveLength(65);
    expect(
      handle.reportedErrors.filter(
        (entry) =>
          (entry.error as { code?: string }).code ===
          "TRIGGER_EVENT_DISPATCH_RATE_EXCEEDED",
      ),
    ).toHaveLength(0);
  });

  it("reads the task store once per event instead of once per tag set", async () => {
    handle.setTasks([makeTriggerTask({ triggerType: "interval" })]);
    registerTriggerTaskWorker(handle.runtime);

    for (let index = 0; index < 5; index += 1) {
      await handle.runtime.emitEvent("workflow_run_event", {
        event: {
          id: `quiet-${index}`,
          runId: `run-quiet-${index}`,
          workflowId: "wf-source",
          type: "NodeFinished",
        },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(handle.dispatchCalls).toHaveLength(0);
    expect(handle.runtime.getTasks).toHaveBeenCalledTimes(5);
  });

  it("keeps the source run alive when an event payload accessor throws", async () => {
    const target = makeTriggerTask(
      {
        triggerType: "event",
        eventKind: "workflow_run_event",
        workflowId: "wf-target",
      },
      { maxRuns: 0 },
    );
    handle.setTasks([target]);
    registerTriggerTaskWorker(handle.runtime);

    const handlers = (
      handle.runtime as unknown as {
        getEvent: (
          kind: string,
        ) => Array<(params: Record<string, unknown>) => Promise<void>>;
      }
    ).getEvent("workflow_run_event");
    const handler = handlers?.[0];
    if (!handler) throw new Error("bridge handler was not registered");

    // A hostile accessor and an own `__proto__` key: the emitting Smithers run
    // awaits this handler inside `recordEvent`, so neither may reach it.
    const params: Record<string, unknown> = {
      runtime: handle.runtime,
      event: {
        id: "hostile:1",
        runId: "run-hostile",
        workflowId: "wf-source",
        type: "NodeFinished",
      },
    };
    Object.defineProperty(params, "hostile", {
      enumerable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    Object.defineProperty(params, "__proto__", {
      enumerable: true,
      configurable: true,
      value: { polluted: true },
    });

    await expect(handler(params)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(handle.dispatchCalls).toHaveLength(1));

    const eventPayload = handle.dispatchCalls[0]?.payload?.eventPayload as
      | Record<string, unknown>
      | undefined;
    if (!eventPayload) throw new Error("bridged payload missing");
    expect(eventPayload).not.toHaveProperty("hostile");
    expect((eventPayload.event as { id?: string }).id).toBe("hostile:1");
    expect(Object.getPrototypeOf(eventPayload)).toBe(Object.prototype);
    expect((eventPayload as { polluted?: boolean }).polluted).toBeUndefined();
    expect(
      handle.reportedErrors.some(
        (entry) => entry.scope === "TriggerRuntime.eventPayload",
      ),
    ).toBe(true);
  });
});

describe("listTriggerTasks", () => {
  it("returns trigger tasks when the feature is enabled and dedupes by id", async () => {
    const triggerTask = makeTriggerTask({ triggerType: "interval" });
    const heartbeatTask = {
      id: stringToUuid("heartbeat-1"),
      name: "IMESSAGE_HEARTBEAT",
      tags: ["queue", "repeat", "heartbeat"],
      metadata: {},
    } as unknown as Task;

    const getTasks = vi.fn(
      async ({ tags }: { tags: string[] }): Promise<Task[]> => {
        if (tags.includes("trigger")) return [triggerTask];
        if (tags.includes("heartbeat")) return [heartbeatTask];
        return [];
      },
    );

    const runtime = {
      agentId: AGENT_ID,
      getSetting: () => undefined,
      getTasks,
    } as unknown as IAgentRuntime;

    const tasks = await listTriggerTasks(runtime);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(triggerTask.id);
    expect(ids).toContain(heartbeatTask.id);
    // queries both tag sets
    expect(getTasks).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list when triggers are disabled via runtime setting", async () => {
    const runtime = {
      agentId: AGENT_ID,
      getSetting: (key: string) =>
        key === "ELIZA_TRIGGERS_ENABLED" ? "0" : undefined,
      getTasks: vi.fn(async () => []),
    } as unknown as IAgentRuntime;

    const tasks = await listTriggerTasks(runtime);
    expect(tasks).toEqual([]);
  });
});
