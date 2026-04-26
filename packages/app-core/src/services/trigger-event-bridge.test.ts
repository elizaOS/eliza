import type {
  AgentRuntime,
  EventPayload,
  IAgentRuntime,
  MessagePayload,
  Task,
  UUID,
} from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startTriggerEventBridge } from "./trigger-event-bridge";

interface TriggerShape {
  version: number;
  triggerId: UUID;
  displayName: string;
  instructions: string;
  triggerType: "interval" | "cron" | "scheduledAt" | "event" | "once";
  eventKind?: string;
  enabled: boolean;
  wakeMode: "inject_now" | "next_autonomy_cycle";
  createdBy: string;
  runCount: number;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function makeTrigger(overrides: Partial<TriggerShape> = {}): TriggerShape {
  return {
    version: 1,
    triggerId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    displayName: "Test Event Trigger",
    instructions: "do a thing when the event fires",
    triggerType: "event",
    eventKind: EventType.MESSAGE_RECEIVED,
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "test",
    runCount: 0,
    ...overrides,
  };
}

function makeTask(trigger: TriggerShape, taskIdSuffix = "bb"): Task {
  return {
    id: `00000000-0000-0000-0000-0000000000${taskIdSuffix}` as UUID,
    name: "TRIGGER_DISPATCH",
    description: trigger.displayName,
    tags: ["queue", "repeat", "trigger"],
    metadata: {
      blocking: true,
      updatedAt: Date.now(),
      updateInterval: 60_000,
      trigger,
    },
  } as unknown as Task;
}

interface RegisteredHandlers {
  [event: string]: Array<(payload: EventPayload) => Promise<void>>;
}

function makeRuntime(): AgentRuntime {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const handlers: RegisteredHandlers = {};
  const registerEvent = vi.fn(
    (event: string, handler: (payload: EventPayload) => Promise<void>) => {
      const list = handlers[event] ?? [];
      list.push(handler);
      handlers[event] = list;
    },
  );
  const unregisterEvent = vi.fn(
    (event: string, handler: (payload: EventPayload) => Promise<void>) => {
      const list = handlers[event];
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) delete handlers[event];
    },
  );
  return {
    agentId: AGENT_ID,
    logger,
    registerEvent,
    unregisterEvent,
    // Expose the internal map so tests can invoke the captured handlers
    // directly (no need to route through runtime.emitEvent).
    __handlers: handlers,
    getSetting: vi.fn(() => undefined),
  } as unknown as AgentRuntime;
}

function invokeHandler(
  runtime: AgentRuntime,
  event: EventType,
  payload: Partial<MessagePayload> = {},
): Promise<void> {
  const handlers = (runtime as unknown as { __handlers: RegisteredHandlers })
    .__handlers[event];
  expect(handlers).toBeDefined();
  expect(handlers?.length).toBe(1);
  const handler = handlers?.[0];
  if (!handler) throw new Error(`no handler registered for ${event}`);
  return handler({
    runtime: runtime as unknown as IAgentRuntime,
    source: "test",
    ...(payload as Record<string, unknown>),
  } as unknown as EventPayload);
}

describe("startTriggerEventBridge", () => {
  beforeEach(() => {
    delete process.env.ELIZA_TRIGGERS_ENABLED;
  });

  afterEach(() => {
    delete process.env.ELIZA_TRIGGERS_ENABLED;
  });

  it("dispatches a matching event-kind trigger exactly once", async () => {
    const runtime = makeRuntime();
    const trigger = makeTrigger();
    const task = makeTask(trigger);
    const dispatch = vi
      .fn()
      .mockResolvedValue({ status: "success", taskDeleted: false });
    const listTriggers = vi.fn().mockResolvedValue([task]);

    startTriggerEventBridge(runtime, {
      events: [EventType.MESSAGE_RECEIVED],
      dispatch,
      listTriggers,
    });

    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED, {
      message: { id: "m1" } as unknown as MessagePayload["message"],
    });

    expect(listTriggers).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [, dispatchedTask, options] = dispatch.mock.calls[0] ?? [];
    expect(dispatchedTask).toBe(task);
    expect(options).toEqual({
      source: "event",
      event: {
        kind: EventType.MESSAGE_RECEIVED,
        payload: { message: { id: "m1" } },
      },
    });
  });

  it("ignores triggers whose eventKind does not match the emitted event", async () => {
    const runtime = makeRuntime();
    const trigger = makeTrigger({ eventKind: EventType.REACTION_RECEIVED });
    const task = makeTask(trigger);
    const dispatch = vi.fn();
    const listTriggers = vi.fn().mockResolvedValue([task]);

    startTriggerEventBridge(runtime, {
      events: [EventType.MESSAGE_RECEIVED],
      dispatch,
      listTriggers,
    });

    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("skips disabled triggers", async () => {
    const runtime = makeRuntime();
    const trigger = makeTrigger({ enabled: false });
    const task = makeTask(trigger);
    const dispatch = vi.fn();
    const listTriggers = vi.fn().mockResolvedValue([task]);

    startTriggerEventBridge(runtime, {
      events: [EventType.MESSAGE_RECEIVED],
      dispatch,
      listTriggers,
    });

    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rate-limits repeated events against the same trigger", async () => {
    const runtime = makeRuntime();
    const trigger = makeTrigger();
    const task = makeTask(trigger);
    const dispatch = vi
      .fn()
      .mockResolvedValue({ status: "success", taskDeleted: false });
    const listTriggers = vi.fn().mockResolvedValue([task]);
    let currentTime = 1_000_000;

    startTriggerEventBridge(runtime, {
      events: [EventType.MESSAGE_RECEIVED],
      dispatch,
      listTriggers,
      minIntervalMs: 500,
      now: () => currentTime,
    });

    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Second emit inside the floor — must be skipped.
    currentTime += 100;
    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Advance past the floor — now it dispatches again.
    currentTime += 500;
    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("honours the ELIZA_TRIGGERS_ENABLED=0 kill switch", async () => {
    process.env.ELIZA_TRIGGERS_ENABLED = "0";
    const runtime = makeRuntime();
    const dispatch = vi.fn();
    const listTriggers = vi.fn();

    startTriggerEventBridge(runtime, {
      events: [EventType.MESSAGE_RECEIVED],
      dispatch,
      listTriggers,
    });

    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED);

    expect(listTriggers).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stop() unregisters every handler", async () => {
    const runtime = makeRuntime();
    const dispatch = vi.fn();
    const listTriggers = vi.fn().mockResolvedValue([]);

    const handle = startTriggerEventBridge(runtime, {
      events: [EventType.MESSAGE_RECEIVED, EventType.REACTION_RECEIVED],
      dispatch,
      listTriggers,
    });

    expect(runtime.registerEvent).toHaveBeenCalledTimes(2);

    handle.stop();

    expect(runtime.unregisterEvent).toHaveBeenCalledTimes(2);
    const handlers = (runtime as unknown as { __handlers: RegisteredHandlers })
      .__handlers;
    expect(handlers[EventType.MESSAGE_RECEIVED]).toBeUndefined();
    expect(handlers[EventType.REACTION_RECEIVED]).toBeUndefined();
  });

  it("isolates failures — one bad trigger does not stop sibling dispatches", async () => {
    const runtime = makeRuntime();
    const badTrigger = makeTrigger({
      triggerId: "00000000-0000-0000-0000-0000000000ee" as UUID,
      displayName: "Bad Trigger",
    });
    const goodTrigger = makeTrigger({
      triggerId: "00000000-0000-0000-0000-0000000000ff" as UUID,
      displayName: "Good Trigger",
    });
    const badTask = makeTask(badTrigger, "01");
    const goodTask = makeTask(goodTrigger, "02");
    const listTriggers = vi.fn().mockResolvedValue([badTask, goodTask]);
    const dispatch = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("dispatch exploded");
      })
      .mockImplementationOnce(async () => ({
        status: "success",
        taskDeleted: false,
      }));

    startTriggerEventBridge(runtime, {
      events: [EventType.MESSAGE_RECEIVED],
      dispatch,
      listTriggers,
    });

    await invokeHandler(runtime, EventType.MESSAGE_RECEIVED);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(runtime.logger.error).toHaveBeenCalled();
  });
});
