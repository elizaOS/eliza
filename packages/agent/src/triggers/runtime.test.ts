import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executeTriggerTask } from "./runtime.js";
import type { TriggerConfig } from "./types.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const TASK_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const TRIGGER_ID = "00000000-0000-0000-0000-000000000003" as UUID;

function makeTrigger(overrides: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    version: 1,
    triggerId: TRIGGER_ID,
    displayName: "Test Trigger",
    instructions: "do a thing",
    triggerType: "interval",
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "test",
    intervalMs: 60_000,
    runCount: 0,
    ...overrides,
  };
}

function makeTask(trigger: TriggerConfig): Task {
  return {
    id: TASK_ID,
    name: "TRIGGER_DISPATCH",
    description: trigger.displayName,
    tags: ["queue", "repeat", "trigger"],
    metadata: {
      blocking: true,
      updatedAt: Date.now(),
      updateInterval: trigger.intervalMs ?? 60_000,
      trigger,
    },
  } as unknown as Task;
}

interface RuntimeOverrides {
  services?: Record<string, unknown>;
  logger?: IAgentRuntime["logger"];
  createMemory?: IAgentRuntime["createMemory"];
  updateTask?: IAgentRuntime["updateTask"];
  deleteTask?: IAgentRuntime["deleteTask"];
  getTask?: IAgentRuntime["getTask"];
}

function makeRuntime(overrides: RuntimeOverrides = {}): IAgentRuntime {
  const services = overrides.services ?? {};
  const logger = overrides.logger ?? {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    agentId: AGENT_ID,
    logger,
    getService: vi.fn((name: string) => services[name] ?? null),
    createMemory:
      overrides.createMemory ?? (vi.fn().mockResolvedValue(undefined) as never),
    updateTask:
      overrides.updateTask ?? (vi.fn().mockResolvedValue(undefined) as never),
    deleteTask:
      overrides.deleteTask ?? (vi.fn().mockResolvedValue(undefined) as never),
    getTask: overrides.getTask ?? (vi.fn().mockResolvedValue(null) as never),
  } as unknown as IAgentRuntime;
}

describe("executeTriggerTask — workflow-kind branch", () => {
  it("dispatches to N8N_DISPATCH and returns success + executionId", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      executionId: "exec-123",
    });
    const trigger = makeTrigger({
      kind: "workflow",
      workflowId: "wf-42",
      workflowName: "Daily Report",
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: { N8N_DISPATCH: { execute } },
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "scheduler",
    });

    expect(execute).toHaveBeenCalledWith("wf-42");
    expect(result.status).toBe("success");
    expect(result.error).toBeUndefined();
    expect(result.executionId).toBe("exec-123");
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("returns error when N8N_DISPATCH reports failure", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: false,
      error: "n8n offline",
    });
    const trigger = makeTrigger({
      kind: "workflow",
      workflowId: "wf-42",
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: { N8N_DISPATCH: { execute } },
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "scheduler",
    });

    expect(execute).toHaveBeenCalledWith("wf-42");
    expect(result.status).toBe("error");
    expect(result.error).toBe("n8n offline");
  });

  it("returns error and logs warn when N8N_DISPATCH service is not registered", async () => {
    const warn = vi.fn();
    const trigger = makeTrigger({
      kind: "workflow",
      workflowId: "wf-42",
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: {},
      logger: {
        info: vi.fn(),
        warn,
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as IAgentRuntime["logger"],
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("N8N_DISPATCH service not registered");
    expect(warn).toHaveBeenCalled();
  });

  it("returns error when workflowId is missing", async () => {
    const execute = vi.fn();
    const trigger = makeTrigger({
      kind: "workflow",
      workflowId: undefined,
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: { N8N_DISPATCH: { execute } },
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("workflow trigger missing workflowId");
    expect(execute).not.toHaveBeenCalled();
  });

  it("skips the autonomy-availability check for workflow-kind triggers", async () => {
    // No AUTONOMY service registered; a text-kind trigger would be
    // skipped here, but workflow-kind must still dispatch.
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const trigger = makeTrigger({
      kind: "workflow",
      workflowId: "wf-42",
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: { N8N_DISPATCH: { execute } },
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(execute).toHaveBeenCalled();
  });
});

describe("executeTriggerTask — text-kind regression", () => {
  it("dispatches a text-kind trigger via the autonomy room (default path)", async () => {
    const roomId = "00000000-0000-0000-0000-0000000000aa" as UUID;
    const createMemory = vi.fn().mockResolvedValue(undefined);
    const trigger = makeTrigger({
      // kind undefined → treat as text
      kind: undefined,
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: {
        AUTONOMY: {
          getAutonomousRoomId: () => roomId,
        },
      },
      createMemory: createMemory as unknown as IAgentRuntime["createMemory"],
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(createMemory).toHaveBeenCalledTimes(1);
    const [memory] = createMemory.mock.calls[0] ?? [];
    expect((memory as { roomId?: UUID }).roomId).toBe(roomId);
  });

  it("still dispatches when kind is explicitly 'text'", async () => {
    const roomId = "00000000-0000-0000-0000-0000000000bb" as UUID;
    const createMemory = vi.fn().mockResolvedValue(undefined);
    const trigger = makeTrigger({ kind: "text" });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: {
        AUTONOMY: {
          getAutonomousRoomId: () => roomId,
        },
      },
      createMemory: createMemory as unknown as IAgentRuntime["createMemory"],
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "scheduler",
    });

    expect(result.status).toBe("success");
    expect(createMemory).toHaveBeenCalledTimes(1);
  });
});

describe("executeTriggerTask — event triggers", () => {
  it("passes event payload to workflow dispatch", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      executionId: "event-exec",
    });
    const trigger = makeTrigger({
      triggerType: "event",
      eventKind: "message.received",
      kind: "workflow",
      workflowId: "wf-event",
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: { N8N_DISPATCH: { execute } },
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "event",
      event: {
        kind: "message.received",
        payload: { text: "hello", channel: "discord" },
      },
    });

    expect(execute).toHaveBeenCalledWith("wf-event", {
      eventKind: "message.received",
      eventPayload: { text: "hello", channel: "discord" },
    });
    expect(result.status).toBe("success");
    expect(result.executionId).toBe("event-exec");
    expect(result.runRecord?.source).toBe("event");
    expect(result.runRecord?.eventKind).toBe("message.received");
  });

  it("injects event payload into text trigger instructions", async () => {
    const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;
    const createMemory = vi.fn().mockResolvedValue(undefined);
    const trigger = makeTrigger({
      triggerType: "event",
      eventKind: "message.received",
      instructions: "Summarize the event.",
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: {
        AUTONOMY: {
          getAutonomousRoomId: () => roomId,
        },
      },
      createMemory: createMemory as unknown as IAgentRuntime["createMemory"],
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "event",
      event: {
        kind: "message.received",
        payload: { text: "hello" },
      },
    });

    expect(result.status).toBe("success");
    const [memory] = createMemory.mock.calls[0] ?? [];
    const text = (memory as { content?: { text?: string } }).content?.text;
    expect(text).toContain("Event: message.received");
    expect(text).toContain('"text":"hello"');
  });

  it("skips nonmatching event kinds", async () => {
    const execute = vi.fn();
    const trigger = makeTrigger({
      triggerType: "event",
      eventKind: "gmail.message.received",
      kind: "workflow",
      workflowId: "wf-event",
    });
    const task = makeTask(trigger);
    const runtime = makeRuntime({
      services: { N8N_DISPATCH: { execute } },
    });

    const result = await executeTriggerTask(runtime, task, {
      source: "event",
      event: { kind: "message.received", payload: {} },
    });

    expect(result.status).toBe("skipped");
    expect(execute).not.toHaveBeenCalled();
  });
});
