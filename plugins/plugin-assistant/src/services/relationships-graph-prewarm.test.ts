/**
 * #17932: boot-time graph prewarm so cold rolodex turns hit the
 * stale-while-revalidate cache instead of awaiting a first build that adds
 * avoidable latency to provider composition.
 */
import { describe, expect, test } from "vitest";
import type { IAgentRuntime } from "../../../../packages/core/src/types/index.ts";
import {
  createNativeRelationshipsGraphService,
  drainRelationshipsGraphBuilds,
} from "./relationships-graph-builder";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockRuntime(options: {
  onWorlds: () => void | Promise<void>;
}): IAgentRuntime {
  let worldsCalls = 0;
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    async getAllWorlds() {
      worldsCalls += 1;
      await options.onWorlds();
      // Simulate a non-trivial first build without needing a real store.
      await sleep(30);
      return [];
    },
    async getRoomsByWorlds() {
      return [];
    },
    async getEntitiesForRoom() {
      return [];
    },
    async getRelationships() {
      return [];
    },
    async getEntityById() {
      return null;
    },
    getService() {
      return null;
    },
    _worldsCalls: () => worldsCalls,
  } as unknown as IAgentRuntime & { _worldsCalls: () => number };
}

describe("relationships graph prewarm (#17932)", () => {
  test("prewarmGraphModel starts a single-flight build shared with getGraphSnapshot", async () => {
    let worldsCalls = 0;
    const runtime = mockRuntime({
      onWorlds: () => {
        worldsCalls += 1;
      },
    });
    const service = createNativeRelationshipsGraphService(runtime, {
      async searchContacts() {
        return [];
      },
      async getCandidateMerges() {
        return [];
      },
    });

    // Kick background prewarm — must not throw and must not await.
    expect(() => service.prewarmGraphModel()).not.toThrow();
    // Second prewarm is a no-op while the build (or cache) is live.
    service.prewarmGraphModel();

    // Concurrent snapshot must share the single-flight build, not start a second.
    const snapshot = await service.getGraphSnapshot({ limit: 10 });
    expect(snapshot.people).toEqual([]);
    expect(worldsCalls).toBe(1);

    // Warm hit: no additional build.
    await service.getGraphSnapshot({ limit: 10 });
    expect(worldsCalls).toBe(1);
  });

  test("prewarm is a no-op once the model cache is populated", async () => {
    let worldsCalls = 0;
    const runtime = mockRuntime({
      onWorlds: () => {
        worldsCalls += 1;
      },
    });
    const service = createNativeRelationshipsGraphService(runtime, {
      async searchContacts() {
        return [];
      },
      async getCandidateMerges() {
        return [];
      },
    });

    await service.getGraphSnapshot({ limit: 5 });
    expect(worldsCalls).toBe(1);
    service.prewarmGraphModel();
    service.prewarmGraphModel();
    await sleep(10);
    expect(worldsCalls).toBe(1);
  });
});

test("shutdown drains builds from replaced graph instances", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = mockRuntime({ onWorlds: () => gate });
  const contacts = {
    async searchContacts() {
      return [];
    },
    async getCandidateMerges() {
      return [];
    },
  };
  const first = createNativeRelationshipsGraphService(runtime, contacts);
  const replacement = createNativeRelationshipsGraphService(runtime, contacts);
  first.prewarmGraphModel();
  replacement.prewarmGraphModel();
  let drained = false;
  const stopping = drainRelationshipsGraphBuilds(runtime).then(() => {
    drained = true;
  });
  await sleep(0);
  expect(drained).toBe(false);
  release();
  await stopping;
  expect(drained).toBe(true);
  await expect(first.getGraphSnapshot()).resolves.toMatchObject({ people: [] });
  await expect(replacement.getGraphSnapshot()).resolves.toMatchObject({
    people: [],
  });
});

test("shutdown observes a failed prewarm and waits for other owned builds", async () => {
  let rejectFirst!: (error: Error) => void;
  let releaseSecond!: () => void;
  const failed = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const successful = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let calls = 0;
  const runtime = mockRuntime({
    onWorlds: () => (++calls === 1 ? failed : successful),
  });
  const contacts = {
    async searchContacts() {
      return [];
    },
    async getCandidateMerges() {
      return [];
    },
  };
  createNativeRelationshipsGraphService(runtime, contacts).prewarmGraphModel();
  createNativeRelationshipsGraphService(runtime, contacts).prewarmGraphModel();
  let settled = false;
  const stopping = drainRelationshipsGraphBuilds(runtime).then(
    () => {
      settled = true;
      return null;
    },
    (error: Error) => {
      settled = true;
      return error;
    },
  );
  rejectFirst(new Error("database read failed"));
  await sleep(0);
  expect(settled).toBe(false);
  releaseSecond();
  const failure = await stopping;
  expect(failure).toMatchObject({
    code: "RELATIONSHIPS_GRAPH_SHUTDOWN_FAILED",
    cause: expect.objectContaining({
      errors: [new Error("database read failed")],
    }),
    context: { failedBuilds: 1 },
  });
});
