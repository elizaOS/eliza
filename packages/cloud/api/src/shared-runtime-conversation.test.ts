/**
 * Exercises the Durable Object history boundary with real response streaming.
 *
 * Repository reads are counted to prove only cold migration touches Postgres;
 * local storage is awaited while mirror writes run under waitUntil.
 */

import { expect, mock, test } from "bun:test";
import { SharedRuntimeConversation } from "./shared-runtime-conversation";

let repositoryReads = 0;
let repositoryWrites = 0;
const repositoryHistoryLengths: number[] = [];

mock.module("@/db/client", () => ({
  runWithDbCacheAsync: async <T>(fn: () => Promise<T>) => await fn(),
}));
mock.module("@/lib/runtime/cloud-bindings", () => ({
  runWithCloudBindingsAsync: async <T>(_env: unknown, fn: () => Promise<T>) =>
    await fn(),
}));
mock.module("@/db/repositories/shared-runtime-history", () => ({
  sharedRuntimeHistoryRepository: {
    get: async () => {
      repositoryReads++;
      return [{ role: "assistant", content: "migrated" }];
    },
    upsert: async (
      _agentId: string,
      _channelId: string,
      history: unknown[],
    ) => {
      repositoryWrites++;
      repositoryHistoryLengths.push(history.length);
    },
  },
}));
mock.module("@/lib/services/shared-runtime/shared-runtime-chat", () => ({
  sharedRuntimeChatService: {
    bridge: async (
      agent: { id: string },
      rpc: { id?: string | number; params?: { roomId?: string } },
      options: {
        historyStore: {
          load(agentId: string, channelId: string): Promise<unknown[]>;
          save(
            agentId: string,
            channelId: string,
            history: unknown[],
          ): Promise<void>;
        };
      },
    ) => {
      const channelId = rpc.params?.roomId ?? agent.id;
      const history = await options.historyStore.load(agent.id, channelId);
      await options.historyStore.save(agent.id, channelId, [
        ...history,
        { role: "user", content: `turn-${rpc.id}` },
      ]);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { historyLength: history.length + 1 },
      };
    },
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: mock(() => undefined) },
}));

test("warm coordinated turns use local history and mirror asynchronously", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const state = {
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      setAlarm: async () => undefined,
    },
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  };
  const object = new SharedRuntimeConversation(state as never, {} as never);
  const agent = {
    id: "agent-1",
    organization_id: "org-1",
    user_id: "user-1",
    execution_tier: "shared",
  };
  const invoke = async (id: string) => {
    const response = await object.fetch(
      new Request("https://shared-runtime.internal/bridge", {
        method: "POST",
        body: JSON.stringify({
          operation: "bridge",
          agent,
          rpc: {
            jsonrpc: "2.0",
            id,
            method: "message.send",
            params: { text: "hi", roomId: "room-1" },
          },
        }),
      }),
    );
    return await response.json();
  };

  expect(await invoke("cold")).toMatchObject({
    code: "conversation_cache_warming",
    retryable: true,
  });
  await Promise.all(background.splice(0));
  expect(repositoryReads).toBe(1);

  expect(await invoke("one")).toMatchObject({
    result: { historyLength: 2 },
  });
  expect(repositoryReads).toBe(1);
  expect(repositoryWrites).toBe(0);

  expect(await invoke("two")).toMatchObject({
    result: { historyLength: 3 },
  });
  expect(repositoryReads).toBe(1);

  await Promise.all(background);
  expect(repositoryWrites).toBe(2);
  expect(repositoryHistoryLengths).toEqual([2, 3]);
});
