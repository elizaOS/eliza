/**
 * Tests for the trigger event bridge — the seam that routes runtime event-bus
 * emissions (MESSAGE_RECEIVED, etc.) to enabled event-kind triggers.
 *
 * The bridge owns three pieces of real logic this file pins down:
 *   1. the ELIZA_TRIGGERS_ENABLED kill switch,
 *   2. per-trigger rate limiting (default 1000 ms floor),
 *   3. eventKind / triggerType matching before dispatch.
 *
 * `executeTriggerTask` and `listTriggerTasks` are swapped out via the bridge's
 * injection seams (`dispatch`, `listTriggers`, `now`) so we can observe dispatch
 * decisions deterministically — but the routing, kill-switch, and rate-limit
 * code under test is the real `startTriggerEventBridge`.
 */

import {
  buildTriggerConfig,
  type NormalizedTriggerDraft,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
} from "@elizaos/agent";
import type { AgentRuntime, EventPayload, Task, UUID } from "@elizaos/core";
import {
  EventType,
  registerConnectorSourceDefinitions,
  registerConnectorSourceMetadata,
  stringToUuid,
  unregisterConnectorSourceMetadataOwner,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startTriggerEventBridge } from "./trigger-event-bridge.ts";

const AGENT_ID = stringToUuid("trigger-bridge-test-agent");

function makeDraft(
  overrides: Partial<NormalizedTriggerDraft>,
): NormalizedTriggerDraft {
  return {
    displayName: "Event Trigger",
    instructions: "Run the workflow",
    triggerType: "event",
    wakeMode: "inject_now",
    enabled: true,
    createdBy: "tester",
    eventKind: "MESSAGE_RECEIVED",
    kind: "workflow",
    workflowId: "wf-1",
    workflowName: "Test Workflow",
    ...overrides,
  };
}

let taskSeq = 0;

function makeEventTriggerTask(
  draftOverrides: Partial<NormalizedTriggerDraft>,
  options: { enabled?: boolean } = {},
): Task {
  const draft = makeDraft(draftOverrides);
  const triggerId = stringToUuid(`bridge-trigger-${taskSeq}`);
  const taskId = stringToUuid(`bridge-task-${taskSeq}`);
  taskSeq += 1;
  let trigger = buildTriggerConfig({ draft, triggerId });
  trigger = { ...trigger, enabled: options.enabled ?? true };
  return {
    id: taskId,
    name: TRIGGER_TASK_NAME,
    description: trigger.displayName,
    tags: [...TRIGGER_TASK_TAGS],
    metadata: { trigger },
  } as unknown as Task;
}

interface BridgeRuntimeHandle {
  runtime: AgentRuntime;
  emit: (
    eventType: EventType,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  registeredEventTypes: () => EventType[];
  setSetting: (key: string, value: unknown) => void;
}

function makeRuntime(): BridgeRuntimeHandle {
  const handlers = new Map<
    string,
    Set<(payload: EventPayload) => Promise<void>>
  >();
  const settings = new Map<string, unknown>();

  const runtime = {
    agentId: AGENT_ID,
    character: { name: "bridge-test" },
    getSetting: (key: string) => settings.get(key),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerEvent: (
      event: string,
      handler: (payload: EventPayload) => Promise<void>,
    ) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    unregisterEvent: (
      event: string,
      handler: (payload: EventPayload) => Promise<void>,
    ) => {
      handlers.get(event)?.delete(handler);
    },
  } as unknown as AgentRuntime;

  return {
    runtime,
    emit: async (eventType, payload = {}) => {
      const set = handlers.get(eventType);
      if (!set) return;
      // Mirror runtime.emitEvent: inject runtime + a non-passive source so the
      // passive-connector short-circuit does not eat the event.
      const enriched = {
        ...payload,
        runtime,
        source: typeof payload.source === "string" ? payload.source : "runtime",
      } as unknown as EventPayload;
      for (const handler of set) {
        await handler(enriched);
      }
    },
    registeredEventTypes: () =>
      [...handlers.entries()]
        .filter(([, set]) => set.size > 0)
        .map(([event]) => event as EventType),
    setSetting: (key, value) => settings.set(key, value),
  };
}

describe("startTriggerEventBridge", () => {
  let handle: BridgeRuntimeHandle;
  let dispatch: ReturnType<typeof vi.fn>;
  let clock: { value: number };

  beforeEach(() => {
    taskSeq = 0;
    handle = makeRuntime();
    dispatch = vi.fn(async () => ({ status: "success", taskDeleted: false }));
    clock = { value: 1_000_000 };
    registerConnectorSourceDefinitions(
      [
        {
          source: "discord",
          aliases: ["discord", "discord-local"],
          sourceKind: "passive",
          isPassive: true,
        },
        {
          source: "x",
          aliases: ["x", "x_dm"],
          sourceKind: "passive",
          isPassive: true,
        },
      ],
      "trigger-event-bridge-test",
    );
    delete process.env.ELIZA_TRIGGERS_ENABLED;
  });

  afterEach(() => {
    unregisterConnectorSourceMetadataOwner("trigger-event-bridge-test");
    unregisterConnectorSourceMetadataOwner("manual");
    delete process.env.ELIZA_TRIGGERS_ENABLED;
    vi.restoreAllMocks();
  });

  function dispatchedTriggerIds(): UUID[] {
    return dispatch.mock.calls.map((call) => {
      const task = call[1] as Task;
      const trigger = (task.metadata as { trigger?: { triggerId: UUID } })
        .trigger;
      return trigger?.triggerId as UUID;
    });
  }

  it("registers a handler for every exposed event type and unregisters on stop", () => {
    const bridge = startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    const registered = handle.registeredEventTypes();
    expect(registered).toContain(EventType.MESSAGE_RECEIVED);
    expect(registered).toContain(EventType.MESSAGE_SENT);
    expect(registered).toContain(EventType.REACTION_RECEIVED);
    expect(registered).toContain(EventType.ENTITY_JOINED);

    bridge.stop();
    expect(handle.registeredEventTypes()).toHaveLength(0);
  });

  it("dispatches an enabled event trigger whose eventKind matches the event", async () => {
    const task = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, { text: "hello" });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const dispatchArgs = dispatch.mock.calls[0];
    expect(dispatchArgs?.[2]).toMatchObject({
      source: "event",
      event: { kind: EventType.MESSAGE_RECEIVED },
    });
    // The runtime/source fields are stripped from the forwarded payload.
    const forwarded = (dispatchArgs?.[2] as { event: { payload: unknown } })
      .event.payload as Record<string, unknown>;
    expect(forwarded).toMatchObject({ text: "hello" });
    expect(forwarded).not.toHaveProperty("runtime");
    expect(forwarded).not.toHaveProperty("source");
  });

  it("suppresses passive connector events using connector source metadata aliases", async () => {
    const task = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, { source: "discord-local" });
    await handle.emit(EventType.MESSAGE_RECEIVED, { source: "x_dm" });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches passive connector events when passive connector mode is disabled", async () => {
    handle.setSetting("ELIZA_LIFEOPS_PASSIVE_CONNECTORS", "false");
    const task = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, { source: "discord-local" });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("suppresses custom connector events registered as passive metadata", async () => {
    registerConnectorSourceMetadata("custom-passive", {
      aliases: ["custom-passive-alias"],
      isPassive: true,
    });
    const task = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, {
      source: "custom-passive-alias",
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch a trigger whose eventKind does not match the event", async () => {
    const task = makeEventTriggerTask({ eventKind: "REACTION_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, {});

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch a disabled event trigger", async () => {
    const task = makeEventTriggerTask(
      { eventKind: "MESSAGE_RECEIVED" },
      { enabled: false },
    );
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("only dispatches the matching trigger when multiple triggers are registered", async () => {
    const matching = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    const other = makeEventTriggerTask({ eventKind: "REACTION_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [matching, other],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, {});

    expect(dispatch).toHaveBeenCalledTimes(1);
    const matchingTrigger = (
      matching.metadata as { trigger: { triggerId: UUID } }
    ).trigger;
    expect(dispatchedTriggerIds()).toEqual([matchingTrigger.triggerId]);
  });

  it("suppresses all dispatch when ELIZA_TRIGGERS_ENABLED=0 (kill switch)", async () => {
    process.env.ELIZA_TRIGGERS_ENABLED = "0";
    const task = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops a second rapid event for the same trigger inside the rate-limit window", async () => {
    const task = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    startTriggerEventBridge(handle.runtime, {
      minIntervalMs: 1_000,
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, {});
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Within the 1s floor: dropped.
    clock.value += 500;
    await handle.emit(EventType.MESSAGE_RECEIVED, {});
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Past the floor: dispatches again.
    clock.value += 600;
    await handle.emit(EventType.MESSAGE_RECEIVED, {});
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("isolates a throwing dispatch so sibling triggers still fire", async () => {
    const first = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    const second = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    dispatch.mockImplementationOnce(async () => {
      throw new Error("dispatch boom");
    });
    startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [first, second],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    await handle.emit(EventType.MESSAGE_RECEIVED, {});

    // Both triggers were attempted even though the first threw.
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch after stop() unregisters the handlers", async () => {
    const task = makeEventTriggerTask({ eventKind: "MESSAGE_RECEIVED" });
    const bridge = startTriggerEventBridge(handle.runtime, {
      listTriggers: async () => [task],
      dispatch: dispatch as never,
      now: () => clock.value,
    });

    bridge.stop();
    await handle.emit(EventType.MESSAGE_RECEIVED, {});
    expect(dispatch).not.toHaveBeenCalled();
  });
});
