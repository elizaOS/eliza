import {
  type AgentRuntime,
  type EventPayload,
  EventType,
  type Task,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { startTriggerEventBridge } from "./trigger-event-bridge";

it("unregisters duplicate event inputs and stops dispatch after an in-flight lookup", async () => {
  let resolveTasks!: (tasks: Task[]) => void;
  const tasks = new Promise<Task[]>((resolve) => {
    resolveTasks = resolve;
  });
  const handlers = new Map<
    EventType,
    (payload: EventPayload) => Promise<void>
  >();
  const runtime = {
    getSetting: () => undefined,
    registerEvent: vi.fn(
      (event: EventType, handler: (payload: EventPayload) => Promise<void>) =>
        handlers.set(event, handler),
    ),
    unregisterEvent: vi.fn((event: EventType) => handlers.delete(event)),
    logger: { error: vi.fn(), debug: vi.fn() },
    reportError: vi.fn(),
  };
  const dispatch = vi.fn();
  const bridge = startTriggerEventBridge(runtime as unknown as AgentRuntime, {
    events: [EventType.MESSAGE_RECEIVED, EventType.MESSAGE_RECEIVED],
    listTriggers: () => tasks,
    dispatch,
  });
  const handler = handlers.get(EventType.MESSAGE_RECEIVED);
  expect(handler).toBeDefined();
  const delivery = handler?.({ source: "test" } as EventPayload);
  bridge.stop();
  resolveTasks([
    {
      metadata: {
        trigger: {
          triggerId: "test",
          enabled: true,
          triggerType: "event",
          eventKind: EventType.MESSAGE_RECEIVED,
        },
      },
    } as unknown as Task,
  ]);
  await delivery;
  expect(runtime.registerEvent).toHaveBeenCalledTimes(1);
  expect(runtime.unregisterEvent).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
});
