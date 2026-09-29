import {
  AgentEventService,
  createCharacter,
  type IAgentRuntime,
  ModelType,
  Service,
  ServiceType,
} from "@elizaos/core";
import {
  createSchedulingRecordStores,
  getSchedulingRecordStore,
  registerScheduledTaskRunnerDeps,
  schedulingPlugin,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { createSQLiteTestRuntime } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../../../plugins/plugin-personal-assistant/src/lifeops/channels/index.ts";
import { createProductionScheduledTaskDispatcher } from "../../../plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runtime-wiring.ts";

it("persists quiet observations without model or owner delivery, respecting threshold", async () => {
  const notify = vi.fn().mockRejectedValue(Error("No notification allowed"));
  class WatcherNotifications extends Service {
    static serviceType = ServiceType.NOTIFICATION;
    capabilityDescription = "Test notification boundary";
    notify = notify;
    static async start(runtime: IAgentRuntime) {
      return new WatcherNotifications(runtime);
    }
    async stop() {}
  }
  const runtime = createSQLiteTestRuntime({
    plugins: [
      { ...schedulingPlugin, schema: undefined, dependencies: [] },
      {
        name: "watcher-events",
        description: "Real event bus with notification boundary",
        services: [AgentEventService, WatcherNotifications],
      },
    ],
    character: createCharacter({ name: "QuietWatcher" }),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  registerScheduledTaskRunnerDeps(runtime, (rt, agentId) => {
    const store = getSchedulingRecordStore(rt);
    if (!store) throw Error("Missing store");
    const stores = createSchedulingRecordStores(store, agentId);
    return {
      store: stores.store,
      logStore: stores.logStore,
      dispatcher: createProductionScheduledTaskDispatcher({ runtime: rt }),
      ownerFacts: () => ({ timezone: "UTC" }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
    };
  });
  const model = vi
    .spyOn(runtime, "useModel")
    .mockRejectedValue(Error("No model allowed"));
  const assistantEvents: unknown[] = [];
  let unsubscribeEvents: (() => void) | undefined;
  const send = vi
    .spyOn(runtime, "sendMessageToTarget")
    .mockRejectedValue(Error("No delivery allowed"));
  try {
    await runtime.initialize();
    const eventService = runtime.getService<AgentEventService>(
      AgentEventService.serviceType,
    );
    if (!eventService) throw Error("Missing agent event service");
    unsubscribeEvents = eventService.subscribe((event) => {
      if (event.stream === "assistant") assistantEvents.push(event);
    });
    const now = Date.now();
    await runtime.setCache(
      "eliza:lifeops:scheduled-task-log:v1",
      [0, 1].map((i) => ({
        taskId: `check-${i}`,
        kind: "checkin",
        outcome: "expired",
        recordedAt: new Date(now - i * 86400000).toISOString(),
      })),
    );
    const runner = (await waitForScheduledTaskRunnerService(runtime)).getRunner(
      { agentId: runtime.agentId },
    );
    for (const threshold of [2, 3, undefined]) {
      if (threshold === undefined) {
        await runtime.setCache("eliza:lifeops:scheduled-task-log:v1", []);
      }
      const task = await runner.schedule({
        kind: "watcher",
        promptInstructions: "Observe quietly",
        trigger: { kind: "manual" },
        priority: "low",
        respectsGlobalPause: true,
        source: "default_pack",
        createdBy: "quiet-user-watcher",
        ownerVisible: false,
        metadata: {
          packKey: "quiet-user-watcher",
          recordKey: "quiet-user-watcher",
          quietThresholdDays: threshold,
        },
      });
      expect(
        (await runner.fireWithResult(task.taskId, { cause: "automatic" })).kind,
      ).toBe("fired");
      const saved = (await runner.list()).find((t) => t.taskId === task.taskId);
      const result = saved?.metadata?.lastDispatchResult as {
        metadata: { observations: Array<{ kind: string }> };
      };
      expect(result).toMatchObject({
        ok: true,
        metadata: { internalOnly: true },
      });
      expect(
        result.metadata.observations.some((o) => o.kind === "quiet_for_days"),
      ).toBe(threshold === 2);
      if (threshold === undefined)
        expect(result.metadata.observations).toEqual([]);
    }
    const failed = await runner.schedule({
      kind: "watcher",
      promptInstructions: "Observe quietly",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "quiet-user-watcher",
      ownerVisible: false,
      metadata: {
        packKey: "quiet-user-watcher",
        recordKey: "quiet-user-watcher",
      },
    });
    const getCache = runtime.getCache.bind(runtime);
    const cache = vi
      .spyOn(runtime, "getCache")
      .mockImplementation(async (key) => {
        if (key === "eliza:lifeops:scheduled-task-log:v1")
          throw Error("observation store unavailable");
        return getCache(key);
      });
    try {
      expect(
        (await runner.fireWithResult(failed.taskId, { cause: "automatic" }))
          .kind,
      ).not.toBe("fired");
    } finally {
      cache.mockRestore();
    }
    const savedFailure = (await runner.list()).find(
      (t) => t.taskId === failed.taskId,
    );
    expect(savedFailure?.metadata?.lastDispatchResult).toMatchObject({
      ok: false,
      reason: "transport_error",
    });
    expect(model).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(assistantEvents).toEqual([]);
  } finally {
    unsubscribeEvents?.();
    model.mockRestore();
    send.mockRestore();
    await runtime.stop();
    await runtime.close();
  }
}, 120000);
it("keeps unrelated hidden watchers on their existing dispatch path and reports observation errors", async () => {
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "QuietFailures" }),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  try {
    await runtime.initialize();
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const record = {
      taskId: "watch",
      kind: "watcher" as const,
      ownerVisible: false,
      channelKey: "unregistered-test",
      firedAtIso: new Date().toISOString(),
      promptInstructions: "Observe",
      contextRequest: undefined,
      metadata: { packKey: "another-pack", recordKey: "quiet-user-watcher" },
    };
    expect(await dispatcher.dispatch(record)).toMatchObject({
      ok: false,
      reason: "disconnected",
    });
    const cache = vi
      .spyOn(runtime, "getCache")
      .mockRejectedValue(Error("storage unavailable"));
    expect(
      await dispatcher.dispatch({
        ...record,
        metadata: {
          packKey: "quiet-user-watcher",
          recordKey: "quiet-user-watcher",
        },
      }),
    ).toMatchObject({ ok: false, reason: "transport_error" });
    cache.mockRestore();
    expect(
      await dispatcher.dispatch({
        ...record,
        metadata: {
          packKey: "quiet-user-watcher",
          recordKey: "quiet-user-watcher",
          quietThresholdDays: 0,
        },
      }),
    ).toMatchObject({ ok: false, reason: "transport_error" });
    const channelSend = vi
      .fn()
      .mockResolvedValue({ ok: true, messageId: "existing-channel-receipt" });
    const registry = createChannelRegistry();
    registry.register({
      kind: "registered-test",
      describe: { label: "Existing watcher channel" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      send: channelSend,
    });
    registerChannelRegistry(runtime, registry);
    runtime.registerModel(
      ModelType.TEXT_SMALL,
      async () => "Existing watcher result",
      "quiet-watcher-test",
    );
    const model = vi
      .spyOn(runtime, "useModel")
      .mockResolvedValue("Existing watcher result");
    try {
      for (const variant of [
        {
          ...record,
          channelKey: "registered-test",
          output: { destination: "channel" as const, target: "test-owner" },
        },
        {
          ...record,
          channelKey: "registered-test",
          output: { destination: "channel" as const, target: "test-owner" },
          ownerVisible: undefined,
          metadata: {
            packKey: "quiet-user-watcher",
            recordKey: "quiet-user-watcher",
          },
        },
      ]) {
        expect(await dispatcher.dispatch(variant)).toMatchObject({
          ok: true,
          messageId: "existing-channel-receipt",
        });
      }
      expect(channelSend).toHaveBeenCalledTimes(2);
    } finally {
      model.mockRestore();
    }
  } finally {
    await runtime.stop();
    await runtime.close();
  }
}, 120000);
