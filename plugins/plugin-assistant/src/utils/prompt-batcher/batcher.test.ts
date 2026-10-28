/**
 * Exercises PromptBatcher's recurring drain loop, concurrent message-buffer
 * accounting, minCycleMs throttling, and once-section cache reuse /
 * stale-while-revalidate against an in-memory runtime and a fake dispatcher
 * (no real model calls).
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import type {
  BatcherResult,
  ResolvedSection,
} from "../../types/prompt-batcher.ts";
import { BatcherDisposedError } from "../../types/prompt-batcher.ts";
import { PromptBatcher } from "./batcher";
import type { DispatchOutcome } from "./shared";

function makeRuntime() {
  const cache = new Map<string, unknown>();
  const tasks: Array<Record<string, unknown>> = [];
  return {
    runtime: {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: { name: "Batcher Test", bio: [], style: [], topics: [] },
      providers: [],
      initPromise: Promise.resolve(),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      reportError: () => {},
      getCache: async <T>(key: string): Promise<T | null> =>
        (cache.get(key) as T | undefined) ?? null,
      setCache: async (key: string, value: unknown): Promise<void> => {
        cache.set(key, value);
      },
      deleteCache: async (key: string): Promise<void> => {
        cache.delete(key);
      },
      // A snapshot, as a database read is: a caller must not see rows another
      // caller inserts after its own read.
      getTasksByName: async () => [...tasks],
      createTask: async (task: Record<string, unknown>) => {
        const id = `00000000-0000-0000-0000-${String(tasks.length + 1).padStart(
          12,
          "0",
        )}`;
        tasks.push({ ...task, id });
        return id;
      },
      getTask: async (id: string) =>
        (tasks.find((task) => task.id === id) as never) ?? null,
      updateTask: async (
        id: string,
        patch: { metadata?: Record<string, unknown> },
      ) => {
        const task = tasks.find((item) => item.id === id);
        if (task) {
          task.metadata = {
            ...((task.metadata as Record<string, unknown>) ?? {}),
            ...(patch.metadata ?? {}),
          };
        }
      },
      deleteTask: async (id: string) => {
        const index = tasks.findIndex((item) => item.id === id);
        if (index >= 0) tasks.splice(index, 1);
      },
    } as unknown as IAgentRuntime,
    tasks,
  };
}

function makeDispatcher() {
  const calls: ResolvedSection[][] = [];
  return {
    calls,
    dispatch: async (sections: ResolvedSection[]): Promise<DispatchOutcome> => {
      calls.push(sections);
      return {
        results: new Map(
          sections.map((section) => [
            section.section.id,
            {
              value: `generated:${section.section.id}:${section.resolvedContext}`,
            },
          ]),
        ),
        calls: [
          {
            model: "small",
            sectionIds: sections.map((section) => section.section.id),
            estimatedTokens: sections.reduce(
              (sum, section) => sum + section.estimatedTokens,
              0,
            ),
            durationMs: 1,
            success: true,
            retried: false,
            fallbackUsed: [],
          },
        ],
      };
    },
  };
}

const SETTINGS = {
  batchSize: 4,
  maxDrainIntervalMs: 60_000,
  maxSectionsPerCall: 8,
  packingDensity: 1,
  maxTokensPerCall: 8_000,
  maxParallelCalls: 1,
  modelSeparation: 1,
};

async function ready(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMessage(index: number): Memory {
  return {
    id: `00000000-0000-0000-0001-${String(index).padStart(12, "0")}` as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    roomId: "00000000-0000-0000-0000-000000000003" as UUID,
    content: { text: `message-${index}` },
  };
}

describe("PromptBatcher recurring loop and cache behavior", () => {
  test("keeps one BATCHER_DRAIN row when a section is removed and re-added in the same tick", async () => {
    const { runtime, tasks } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();
    const section = {
      minCycleMs: 0,
      contextBuilder: async () => "drain context",
      preamble: "Drain buffered messages.",
      schema: [{ field: "value", type: "string", required: true }],
      onResult: () => {},
    };
    const drainRows = () =>
      tasks.filter((task) => task.name === "BATCHER_DRAIN").length;

    batcher.think("autonomy", section);
    await wait(20);
    expect(drainRows()).toBe(1);

    // The autonomy interval change re-registers the section at once.
    batcher.removeSection("autonomy");
    batcher.think("autonomy", section);
    await wait(20);

    expect(batcher.getSectionCountForAffinity("autonomy")).toBe(1);
    expect(drainRows()).toBe(1);
  });

  test("a drain ensure queued before dispose creates no task after it", async () => {
    const { runtime, tasks } = makeRuntime();
    const dispatcher = makeDispatcher();
    const createTask = runtime.createTask;
    let createsAfterDispose = 0;
    let disposed = false;
    runtime.createTask = async (task: Record<string, unknown>) => {
      if (disposed) createsAfterDispose += 1;
      return createTask(task);
    };
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    // The ensure is queued by addSection(); dispose() lands before it runs.
    const pending = batcher.addSection({
      id: "autonomy",
      frequency: "recurring",
      affinityKey: "autonomy",
      contextBuilder: async () => "drain context",
      preamble: "Drain buffered messages.",
      schema: [{ field: "value", type: "string", required: true }],
      onResult: () => {},
    });
    disposed = true;
    batcher.dispose();
    await expect(pending).rejects.toBeInstanceOf(BatcherDisposedError);
    await wait(20);

    expect(createsAfterDispose).toBe(0);
    expect(tasks.filter((task) => task.name === "BATCHER_DRAIN")).toHaveLength(
      0,
    );
  });

  test("a drain whose start is in flight at dispose is torn down, not kept", async () => {
    const { runtime, tasks } = makeRuntime();
    const dispatcher = makeDispatcher();
    let releaseCreate: () => void = () => {};
    const createTask = runtime.createTask;
    runtime.createTask = async (task: Record<string, unknown>) => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return createTask(task);
    };
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    const pending = batcher.addSection({
      id: "autonomy",
      frequency: "recurring",
      affinityKey: "autonomy",
      contextBuilder: async () => "drain context",
      preamble: "Drain buffered messages.",
      schema: [{ field: "value", type: "string", required: true }],
      onResult: () => {},
    });
    await wait(20); // start() is now waiting on createTask
    batcher.dispose();
    await expect(pending).rejects.toBeInstanceOf(BatcherDisposedError);
    releaseCreate();
    await wait(20);

    expect(tasks.filter((task) => task.name === "BATCHER_DRAIN")).toHaveLength(
      0,
    );
  });

  test("preserves a message appended while a drain is in flight", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    let releaseFirstContext!: () => void;
    const firstContextGate = new Promise<void>((resolve) => {
      releaseFirstContext = resolve;
    });
    let signalFirstContext!: () => void;
    const firstContextEntered = new Promise<void>((resolve) => {
      signalFirstContext = resolve;
    });
    const observedMessageIds: string[][] = [];

    batcher.think("autonomy", {
      minCycleMs: 0,
      contextBuilder: async (_runtime, messages) => {
        observedMessageIds.push(messages.map((message) => String(message.id)));
        if (observedMessageIds.length === 1) {
          signalFirstContext();
          await firstContextGate;
        }
        return "drain context";
      },
      preamble: "Drain buffered messages.",
      schema: [{ field: "value", type: "string", required: true }],
    });
    await ready();

    const initial = makeMessage(1);
    const appended = makeMessage(2);
    batcher.tick(initial);
    const firstDrain = batcher.drainAffinityGroup("autonomy");
    await firstContextEntered;
    batcher.tick(appended);
    releaseFirstContext();
    await firstDrain;
    await batcher.drainAffinityGroup("autonomy");

    expect(observedMessageIds).toEqual([
      [String(initial.id)],
      [String(appended.id)],
    ]);
  });

  test("preserves rollover arrivals when an in-flight buffer remains at its cap", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    let releaseFirstContext!: () => void;
    const firstContextGate = new Promise<void>((resolve) => {
      releaseFirstContext = resolve;
    });
    let signalFirstContext!: () => void;
    const firstContextEntered = new Promise<void>((resolve) => {
      signalFirstContext = resolve;
    });
    const observedMessages: Memory[][] = [];

    batcher.think("autonomy", {
      minCycleMs: 0,
      contextBuilder: async (_runtime, messages) => {
        observedMessages.push(messages);
        if (observedMessages.length === 1) {
          signalFirstContext();
          await firstContextGate;
        }
        return "drain context";
      },
      preamble: "Drain buffered messages.",
      schema: [{ field: "value", type: "string", required: true }],
    });
    await ready();

    for (let index = 1; index <= 50; index += 1) {
      batcher.tick(makeMessage(index));
    }
    const rolloverArrival = makeMessage(51);
    const firstDrain = batcher.drainAffinityGroup("autonomy");
    await firstContextEntered;
    batcher.tick(rolloverArrival);
    releaseFirstContext();
    await firstDrain;
    await batcher.drainAffinityGroup("autonomy");

    expect(observedMessages[0]).toHaveLength(50);
    expect(observedMessages[1]).toEqual([rolloverArrival]);
  });

  test("recurring autonomy-affinity sections run on repeated drain tasks and keep context stateful", async () => {
    const { runtime, tasks } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    const delivered: Array<BatcherResult> = [];
    let loop = 0;
    batcher.think("autonomy", {
      minCycleMs: 25,
      contextBuilder: () => `loop=${++loop}`,
      preamble: "Think autonomously.",
      schema: [{ field: "value", type: "string", required: true }],
      onResult: (fields, meta) => {
        delivered.push({ fields, meta });
      },
    });
    await ready();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.metadata).toMatchObject({
      affinityKey: "autonomy",
      updateInterval: 25,
    });

    await batcher.drainAffinityGroup("autonomy");
    await wait(30);
    await batcher.drainAffinityGroup("autonomy");

    expect(dispatcher.calls).toHaveLength(2);
    expect(delivered.map((item) => item.fields.value)).toEqual([
      "generated:autonomy:Agent Name: Batcher Test\n\nloop=1",
      "generated:autonomy:Agent Name: Batcher Test\n\nloop=2",
    ]);
    expect(delivered.every((item) => item.meta.cacheHit === false)).toBe(true);
  });

  test("recurring sections are throttled by minCycleMs even when drains fire early", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    const delivered: Array<BatcherResult> = [];
    let loop = 0;
    batcher.think("autonomy", {
      minCycleMs: 60_000,
      contextBuilder: () => `loop=${++loop}`,
      preamble: "Think autonomously.",
      schema: [{ field: "value", type: "string", required: true }],
      onResult: (fields, meta) => {
        delivered.push({ fields, meta });
      },
    });
    await ready();

    await batcher.drainAffinityGroup("autonomy");
    await batcher.drainAffinityGroup("autonomy");

    expect(dispatcher.calls).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.fields.value).toBe(
      "generated:autonomy:Agent Name: Batcher Test\n\nloop=1",
    );
  });

  test("waits for failed affinity cleanup before exposing a retry", async () => {
    const { runtime, tasks } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    let signalDeleteEntered!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      signalDeleteEntered = resolve;
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteTask = runtime.deleteTask;
    runtime.deleteTask = async (id) => {
      signalDeleteEntered();
      await deleteGate;
      await deleteTask(id);
    };

    let failUpdate = true;
    const updateTask = runtime.updateTask;
    runtime.updateTask = async (id, patch) => {
      if (failUpdate) {
        failUpdate = false;
        throw new Error("late sync failure");
      }
      await updateTask(id, patch);
    };

    let intervalCalls = 0;
    vi.spyOn(batcher, "getIdealTickInterval").mockImplementation(() => {
      intervalCalls += 1;
      return intervalCalls === 1 ? SETTINGS.maxDrainIntervalMs : 25;
    });

    const section = {
      id: "late-sync-retry",
      frequency: "recurring" as const,
      affinityKey: "race",
      minCycleMs: 25,
      priority: "background" as const,
      preamble: "Retry after cleanup.",
      contextBuilder: () => "retry context",
      schema: [{ field: "value", type: "string", required: true }],
    };
    const failed = batcher.addSection(section);
    let rejectedBeforeCleanup = false;
    const observedFailure = failed.catch(() => {
      rejectedBeforeCleanup = true;
    });

    await deleteEntered;
    await wait(0);
    expect(rejectedBeforeCleanup).toBe(false);

    releaseDelete();
    await expect(failed).rejects.toThrow("late sync failure");
    await observedFailure;

    const retried = batcher.addSection(section);
    await ready();
    expect(tasks).toHaveLength(1);

    await batcher.drainAffinityGroup("race");
    await expect(retried).resolves.toMatchObject({
      fields: {
        value:
          "generated:late-sync-retry:Agent Name: Batcher Test\n\nretry context",
      },
    });
    expect(tasks).toHaveLength(1);
  });

  test("once sections reuse fresh cache without another model dispatch", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    const first = await batcher.addSection({
      id: "cached-section",
      frequency: "once",
      affinityKey: "init",
      priority: "background",
      preamble: "Cache me.",
      contextBuilder: () => "first context",
      schema: [{ field: "value", type: "string", required: true }],
      cacheTtlMs: 60_000,
    });
    const second = await batcher.addSection({
      id: "cached-section",
      frequency: "once",
      affinityKey: "init",
      priority: "background",
      preamble: "Cache me.",
      contextBuilder: () => "changed context",
      schema: [{ field: "value", type: "string", required: true }],
      cacheTtlMs: 60_000,
    });

    expect(first?.fields.value).toContain("first context");
    expect(second?.fields).toEqual(first?.fields);
    expect(dispatcher.calls).toHaveLength(1);
    expect(batcher.getStats().totalCacheHits).toBe(1);
  });

  test("stale-while-revalidate returns cached fields and refreshes in the background drain", async () => {
    const { runtime } = makeRuntime();
    const dispatcher = makeDispatcher();
    const batcher = new PromptBatcher(runtime, dispatcher as never, SETTINGS);
    await ready();

    await batcher.addSection({
      id: "stale-section",
      frequency: "once",
      affinityKey: "init",
      priority: "background",
      preamble: "Cache me.",
      contextBuilder: () => "old context",
      schema: [{ field: "value", type: "string", required: true }],
      cacheTtlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const stale = await batcher.addSection({
      id: "stale-section",
      frequency: "once",
      affinityKey: "init",
      priority: "background",
      preamble: "Cache me.",
      contextBuilder: () => "new context",
      schema: [{ field: "value", type: "string", required: true }],
      cacheTtlMs: 60_000,
      staleWhileRevalidate: true,
    });
    await ready();

    expect(stale?.fields.value).toContain("old context");
    expect(dispatcher.calls).toHaveLength(2);
    expect(batcher.getStats().totalCacheHits).toBe(1);
  });
});
