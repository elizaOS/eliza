/**
 * A scheduler fire tells the workflow dispatcher which scheduled occurrence it
 * belongs to, so a host that runs only while powered on can record a missed
 * occurrence once instead of replaying it. Manual runs carry no occurrence.
 * Prompt automations follow the same powered-on policy in the trigger runtime.
 */
import {
  type IAgentRuntime,
  MISSED_SCHEDULED_OCCURRENCE_TEXT,
  MISSED_SCHEDULED_OCCURRENCES_SETTING,
  ServiceType,
  type Task,
  type UUID,
} from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeTriggerTask } from "../src/triggers/runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  normalizeTriggerDraft,
} from "../src/triggers/scheduling.ts";
import type { TriggerTaskMetadata } from "../src/triggers/types.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("passes the scheduled instant for scheduler fires and none for manual runs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  const tasks = new Map<string, Task>();
  const calls: Array<{ scheduledAtMs?: number; idempotencyKey?: string }> = [];
  const dispatch = {
    async execute(
      _workflowId: string,
      _payload: unknown,
      options: { scheduledAtMs?: number; idempotencyKey?: string } = {},
    ) {
      calls.push({ ...options });
      return { ok: true, executionId: `exec-${calls.length}` };
    },
  };
  const noop = () => undefined;
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000b2" as UUID,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    reportError: noop,
    getService: (name: string) =>
      name === "WORKFLOW_DISPATCH" ? dispatch : null,
    getTask: async (id: string) => structuredClone(tasks.get(id) ?? null),
    updateTask: async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, ...patch });
    },
    deleteTask: async (id: string) => void tasks.delete(id),
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
  const { draft } = normalizeTriggerDraft({
    input: {
      kind: "workflow",
      workflowId: "wf-occurrence",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    },
    fallback: {
      displayName: "Morning",
      instructions: "",
      triggerType: "cron",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: "owner",
    },
  });
  if (!draft) throw new Error("trigger draft was not created");
  const trigger = buildTriggerConfig({
    draft,
    triggerId: "00000000-0000-0000-0000-00000000c002" as UUID,
  });
  const taskId = "00000000-0000-0000-0000-0000000000d2" as UUID;
  tasks.set(taskId, {
    id: taskId,
    name: "TRIGGER_DISPATCH",
    tags: ["queue", "repeat", "trigger"],
    metadata: buildTriggerMetadata({ trigger, nowMs: Date.now() }),
  } as unknown as Task);
  const run = async (iso: string, source: "scheduler" | "manual") => {
    vi.setSystemTime(new Date(iso));
    const task = await runtime.getTask(taskId);
    if (!task) throw new Error("trigger task is missing");
    return executeTriggerTask(
      runtime,
      task,
      source === "manual" ? { source, force: true } : { source },
    );
  };

  // The phone was off at 09:00 and the runtime reached the fire hours later.
  await run("2026-10-12T13:30:00.000Z", "scheduler");
  await run("2026-10-12T14:00:00.000Z", "manual");
  await run("2026-10-13T09:00:01.000Z", "scheduler");
  expect(calls).toHaveLength(3);
  expect(calls[0].scheduledAtMs).toBe(Date.parse("2026-10-12T09:00:00.000Z"));
  expect(calls[1]).not.toHaveProperty("scheduledAtMs");
  expect(calls[1].idempotencyKey).toBeUndefined();
  expect(calls[2].scheduledAtMs).toBe(Date.parse("2026-10-13T09:00:00.000Z"));
});

type Fixture = {
  runtime: IAgentRuntime;
  tasks: Map<string, Task>;
  prompts: string[];
  workflowCalls: Array<{ scheduledAtMs?: number }>;
  notifications: Array<{ title: string; body?: string }>;
  taskId: UUID;
};

/** A fake resident with the powered-on policy, a prompt pipeline and a notifier. */
function fixture(
  input: Record<string, unknown>,
  options: { policy?: string; workflowMissed?: boolean } = {},
): Fixture {
  const tasks = new Map<string, Task>();
  const prompts: string[] = [];
  const workflowCalls: Array<{ scheduledAtMs?: number }> = [];
  const notifications: Array<{ title: string; body?: string }> = [];
  const noop = () => undefined;
  const dispatch = {
    async execute(
      _workflowId: string,
      _payload: unknown,
      callOptions: { scheduledAtMs?: number } = {},
    ) {
      workflowCalls.push({ ...callOptions });
      return {
        ok: true,
        executionId: `exec-${workflowCalls.length}`,
        ...(options.workflowMissed ? { missed: true } : {}),
      };
    },
  };
  const notifier = {
    async notify(notification: { title: string; body?: string }) {
      notifications.push(notification);
    },
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000b3" as UUID,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    reportError: noop,
    getService: (name: string) =>
      name === "WORKFLOW_DISPATCH"
        ? dispatch
        : name === ServiceType.NOTIFICATION
          ? notifier
          : null,
    getTask: async (id: string) => structuredClone(tasks.get(id) ?? null),
    updateTask: async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, ...patch });
    },
    deleteTask: async (id: string) => void tasks.delete(id),
    getSetting: (key: string) =>
      key === MISSED_SCHEDULED_OCCURRENCES_SETTING ? options.policy : undefined,
    getRoom: async () => null,
    ensureConnection: async () => undefined,
    getEntityById: async () => null,
    updateEntity: async () => undefined,
    messageService: {
      async handleMessage(
        _runtime: unknown,
        message: { content: { text: string } },
      ) {
        prompts.push(message.content.text);
      },
    },
  } as unknown as IAgentRuntime;
  const { draft } = normalizeTriggerDraft({
    input: { timezone: "UTC", notifyOnOutcome: true, ...input },
    fallback: {
      displayName: "Morning",
      instructions: "Summarize my morning",
      triggerType: "cron",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: "owner",
    },
  });
  if (!draft) throw new Error("trigger draft was not created");
  const trigger = buildTriggerConfig({
    draft,
    triggerId: "00000000-0000-0000-0000-00000000c003" as UUID,
  });
  const taskId = "00000000-0000-0000-0000-0000000000d3" as UUID;
  tasks.set(taskId, {
    id: taskId,
    name: "TRIGGER_DISPATCH",
    tags: ["queue", "repeat", "trigger"],
    metadata: buildTriggerMetadata({ trigger, nowMs: Date.now() }),
  } as unknown as Task);
  return { runtime, tasks, prompts, workflowCalls, notifications, taskId };
}

async function fire(f: Fixture, iso: string, source: "scheduler" | "manual") {
  vi.setSystemTime(new Date(iso));
  const task = await f.runtime.getTask(f.taskId);
  if (!task) throw new Error("trigger task is missing");
  return executeTriggerTask(
    f.runtime,
    task,
    source === "manual" ? { source, force: true } : { source },
  );
}

function stored(f: Fixture): TriggerTaskMetadata | undefined {
  return f.tasks.get(f.taskId)?.metadata as TriggerTaskMetadata | undefined;
}

it("records a prompt occurrence that passed while the agent was not running once and runs nothing", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  const f = fixture(
    { kind: "prompt", triggerType: "cron", cronExpression: "0 9 * * *" },
    { policy: "record" },
  );
  // The phone was off at 09:00; the agent process started seconds before this fire.
  const result = await fire(f, "2026-10-12T13:30:00.000Z", "scheduler");
  expect(f.prompts).toEqual([]);
  expect(result).toMatchObject({
    status: "skipped",
    error: MISSED_SCHEDULED_OCCURRENCE_TEXT,
    taskDeleted: false,
    runRecord: { status: "skipped", source: "scheduler" },
  });
  const metadata = stored(f);
  expect(metadata?.trigger).toMatchObject({
    enabled: true,
    runCount: 0,
    lastStatus: "skipped",
    lastError: MISSED_SCHEDULED_OCCURRENCE_TEXT,
    nextRunAtMs: Date.parse("2026-10-13T09:00:00.000Z"),
  });
  expect(metadata?.trigger?.lastRunAtIso).toBeUndefined();
  expect(metadata?.triggerRuns).toHaveLength(1);
  await vi.waitFor(() => expect(f.notifications).toHaveLength(1));
  expect(f.notifications[0]).toMatchObject({
    title: 'Automation "Morning" did not run',
    body: MISSED_SCHEDULED_OCCURRENCE_TEXT,
  });
  expect(f.notifications[0]?.title).not.toContain("completed");
  // The next occurrence, reached on time, runs; an explicit Run now always runs.
  await fire(f, "2026-10-13T09:00:01.000Z", "scheduler");
  await fire(f, "2026-10-13T10:00:00.000Z", "manual");
  expect(f.prompts).toHaveLength(2);
  expect(stored(f)?.trigger?.runCount).toBe(2);
});

it("keeps a missed one-time prompt listed and disabled so the owner can still run it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  const f = fixture(
    {
      kind: "prompt",
      triggerType: "once",
      scheduledAtIso: "2026-10-12T09:00:00.000Z",
    },
    { policy: "record" },
  );
  const result = await fire(f, "2026-10-12T13:30:00.000Z", "scheduler");
  expect(result).toMatchObject({ status: "skipped", taskDeleted: false });
  expect(f.prompts).toEqual([]);
  expect(stored(f)?.trigger).toMatchObject({
    enabled: false,
    runCount: 0,
    lastStatus: "skipped",
  });
  expect(stored(f)?.triggerRuns).toHaveLength(1);
  // A disabled trigger never fires on its own; Run now still runs it once.
  expect(await fire(f, "2026-10-12T14:00:00.000Z", "scheduler")).toMatchObject({
    status: "skipped",
  });
  expect(f.prompts).toEqual([]);
  await fire(f, "2026-10-12T14:05:00.000Z", "manual");
  expect(f.prompts).toHaveLength(1);
  expect(f.tasks.has(f.taskId)).toBe(true);
});

it("runs a late prompt when the agent was running, or when the host keeps late runs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  // Delayed by device doze or a busy scheduler: the agent started before 09:00.
  const dozing = fixture(
    { kind: "prompt", triggerType: "cron", cronExpression: "0 9 * * *" },
    { policy: "record" },
  );
  vi.spyOn(process, "uptime").mockReturnValue(6 * 60 * 60);
  expect(
    await fire(dozing, "2026-10-12T09:20:00.000Z", "scheduler"),
  ).toMatchObject({ status: "success" });
  expect(dozing.prompts).toHaveLength(1);
  vi.restoreAllMocks();
  // Hosts that run continuously do not select the powered-on policy.
  const desktop = fixture(
    { kind: "prompt", triggerType: "cron", cronExpression: "0 9 * * *" },
    {},
  );
  const previous = process.env[MISSED_SCHEDULED_OCCURRENCES_SETTING];
  delete process.env[MISSED_SCHEDULED_OCCURRENCES_SETTING];
  try {
    expect(
      await fire(desktop, "2026-10-12T13:30:00.000Z", "scheduler"),
    ).toMatchObject({ status: "success" });
  } finally {
    if (previous !== undefined)
      process.env[MISSED_SCHEDULED_OCCURRENCES_SETTING] = previous;
  }
  expect(desktop.prompts).toHaveLength(1);
});

it("reports a workflow occurrence the workflow service recorded as missed without calling it completed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
  const f = fixture(
    {
      kind: "workflow",
      workflowId: "wf-missed",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
    },
    { policy: "record", workflowMissed: true },
  );
  const result = await fire(f, "2026-10-12T13:30:00.000Z", "scheduler");
  expect(f.workflowCalls).toEqual([
    expect.objectContaining({
      scheduledAtMs: Date.parse("2026-10-12T09:00:00.000Z"),
    }),
  ]);
  expect(result).toMatchObject({
    status: "skipped",
    error: MISSED_SCHEDULED_OCCURRENCE_TEXT,
    executionId: "exec-1",
    taskDeleted: false,
  });
  expect(stored(f)?.trigger).toMatchObject({
    runCount: 0,
    lastStatus: "skipped",
    nextRunAtMs: Date.parse("2026-10-13T09:00:00.000Z"),
  });
  await vi.waitFor(() => expect(f.notifications).toHaveLength(1));
  expect(f.notifications[0]?.title).toBe('Automation "Morning" did not run');
});
