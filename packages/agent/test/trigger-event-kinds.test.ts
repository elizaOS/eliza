/**
 * An event automation saved from the Automations form stores a preset kind
 * such as "message.received", while the runtime bus emits "MESSAGE_RECEIVED".
 * The bridge and the executor must match the preset to the bus event, and the
 * connector presets must narrow by the payload's source; a custom kind is
 * still matched as typed.
 */
import type { AgentRuntime, IAgentRuntime, Task, UUID } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { expect, it } from "vitest";
import { startTriggerEventBridge } from "../src/triggers/event-bridge.ts";
import { triggerEventMatches } from "../src/triggers/event-kinds.ts";
import type { executeTriggerTask } from "../src/triggers/runtime.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;

function eventTrigger(index: number, eventKind: string): Task {
  return {
    id: `00000000-0000-0000-0000-0000000000c${index}` as UUID,
    name: "TRIGGER",
    agentId: AGENT_ID,
    roomId: AGENT_ID,
    tags: ["queue", "repeat", "trigger"],
    metadata: {
      trigger: {
        triggerId: `trigger-${index}`,
        name: `automation ${index}`,
        enabled: true,
        triggerType: "event",
        eventKind,
        kind: "prompt",
        instructions: "Summarize the message.",
      },
    },
  } as unknown as Task;
}

function bridgeRuntime() {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const noop = () => undefined;
  const runtime = {
    agentId: AGENT_ID,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    reportError: noop,
    getSetting: () => undefined,
    registerEvent: (
      kind: string,
      handler: (payload: unknown) => Promise<void>,
    ) => {
      handlers.set(kind, handler);
    },
    unregisterEvent: (kind: string) => {
      handlers.delete(kind);
    },
  } as unknown as AgentRuntime;
  return { runtime, handlers };
}

it("matches the form presets to the bus kinds they stand for", () => {
  const received = {
    kind: EventType.MESSAGE_RECEIVED,
    payload: { message: { content: { source: "discord" } } },
  };
  expect(triggerEventMatches("message.received", received)).toBe(true);
  expect(triggerEventMatches("discord.message.received", received)).toBe(true);
  expect(triggerEventMatches("telegram.message.received", received)).toBe(
    false,
  );
  expect(triggerEventMatches("MESSAGE_RECEIVED", received)).toBe(true);
  expect(triggerEventMatches("MESSAGE_SENT", received)).toBe(false);
  expect(
    triggerEventMatches("message.received", { kind: EventType.MESSAGE_SENT }),
  ).toBe(false);
  // The manual fire route may name the preset itself.
  expect(
    triggerEventMatches("discord.message.received", {
      kind: "discord.message.received",
    }),
  ).toBe(true);
  expect(triggerEventMatches(undefined, received)).toBe(false);
});

it("the bridge fires a preset-kind automation on the matching bus event", async () => {
  const { runtime, handlers } = bridgeRuntime();
  const dispatched: string[] = [];
  const triggers = [
    eventTrigger(1, "message.received"),
    eventTrigger(2, "telegram.message.received"),
    eventTrigger(3, "MESSAGE_SENT"),
  ];
  const handle = startTriggerEventBridge(runtime, {
    minIntervalMs: 0,
    listTriggers: async () => triggers,
    dispatch: (async (_runtime: IAgentRuntime, task: Task) => {
      dispatched.push(String(task.id));
      return { status: "executed", taskDeleted: false };
    }) as unknown as typeof executeTriggerTask,
  });
  try {
    const onMessage = handlers.get(EventType.MESSAGE_RECEIVED);
    if (!onMessage)
      throw new Error("bridge did not subscribe to MESSAGE_RECEIVED");

    await onMessage({
      message: { content: { text: "hi", source: "discord" } },
    });
    expect(dispatched).toEqual([String(triggers[0].id)]);

    await onMessage({
      message: { content: { text: "hi", source: "telegram" } },
    });
    expect(dispatched).toEqual([
      String(triggers[0].id),
      String(triggers[0].id),
      String(triggers[1].id),
    ]);
  } finally {
    await handle.stop();
  }
});
