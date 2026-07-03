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
  executeTriggerTask,
  listTriggerTasks,
  readTriggerConfig,
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
  setDispatchResult: (
    result: { ok: true; executionId?: string } | { ok: false; error: string },
  ) => void;
  setWorkflowServicePresent: (present: boolean) => void;
}

function makeRuntime(): MockRuntimeHandle {
  const dispatchCalls: WorkflowDispatchCall[] = [];
  const promptMessages: PromptMessageCall[] = [];
  const deletedTaskIds: UUID[] = [];
  const updatedTasks: Array<{ id: UUID; patch: Partial<Task> }> = [];
  const warnings: unknown[][] = [];
  const notifyCalls: Array<Record<string, unknown>> = [];

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
    },
  };
  let dispatchResult: {
    ok: boolean;
    executionId?: string;
    error?: string;
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
    agentId: AGENT_ID,
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
    deleteTask: vi.fn(async (id: UUID) => {
      deletedTaskIds.push(id);
    }),
    updateTask: vi.fn(async (id: UUID, patch: Partial<Task>) => {
      updatedTasks.push({ id, patch });
    }),
  } as unknown as IAgentRuntime;

  return {
    runtime,
    dispatchCalls,
    promptMessages,
    deletedTaskIds,
    updatedTasks,
    warnings,
    notifyCalls,
    setDispatchResult: (result) => {
      dispatchResult = result;
    },
    setWorkflowServicePresent: (present) => {
      workflowServicePresent = present;
    },
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

  it("emits a low-priority completion notification on a successful run (#10697)", async () => {
    const task = makeTriggerTask({
      triggerType: "interval",
      displayName: "Nightly backup",
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
    expect(handle.promptMessages[0]?.text).toBe("Summarize today's calendar");

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

  it("reports an error when the WORKFLOW_DISPATCH service is absent", async () => {
    handle.setWorkflowServicePresent(false);
    const task = makeTriggerTask({ triggerType: "interval" });

    const result = await executeTriggerTask(handle.runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("WORKFLOW_DISPATCH");
    expect(handle.dispatchCalls).toHaveLength(0);
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
