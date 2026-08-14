/**
 * Exercises the Durable Object history boundary with real response streaming.
 *
 * Repository reads are counted to prove the response path never touches
 * Postgres — cold migration and the merge-read of the asynchronous mirror both
 * run only under waitUntil; local storage is awaited on the turn.
 */

import { beforeEach, expect, mock, test } from "bun:test";

class RateLimitError extends Error {
  retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

class InsufficientCreditsError extends Error {}

mock.module("@/lib/api/errors", () => ({
  RateLimitError,
  InsufficientCreditsError,
}));

let repositoryReads = 0;
let repositoryWrites = 0;
let repositoryRow: unknown[] = [];
const repositoryHistoryLengths: number[] = [];
const repositoryHistories: unknown[][] = [];
let streamMergeGate: Promise<void> | null = null;
let resolveStreamMergeGate = () => {};
let rehydrateCalls = 0;
let bridgeFunding: unknown;

function testMessageIdentity(value: unknown): string {
  const message = value as {
    id?: unknown;
    role?: unknown;
    createdAt?: unknown;
    content?: unknown;
  };
  return typeof message.id === "string"
    ? message.id
    : `${message.role ?? ""}\u0000${message.createdAt ?? ""}\u0000${message.content ?? ""}`;
}

mock.module("@/db/client", () => ({
  runWithDbCacheAsync: async <T>(fn: () => Promise<T>) => await fn(),
}));
mock.module("@/lib/runtime/cloud-bindings", () => ({
  runWithCloudBindingsAsync: async <T>(_env: unknown, fn: () => Promise<T>) =>
    await fn(),
}));
mock.module("@/lib/services/shared-runtime/cached-agent-dates", () => ({
  rehydrateCachedAgentDates: (agent: unknown) => {
    rehydrateCalls++;
    return agent;
  },
}));
mock.module("@/db/repositories/shared-runtime-history", () => ({
  sharedRuntimeHistoryRepository: {
    get: async () => {
      repositoryReads++;
      return repositoryRow;
    },
    upsert: async (
      _agentId: string,
      _channelId: string,
      history: unknown[],
    ) => {
      repositoryWrites++;
      repositoryHistoryLengths.push(history.length);
      repositoryHistories.push(history);
    },
    merge: async (_agentId: string, _channelId: string, history: unknown[]) => {
      repositoryWrites++;
      const byId = new Map<string, unknown>();
      for (const message of [...repositoryRow, ...history]) {
        byId.set(testMessageIdentity(message), message);
      }
      const merged = [...byId.values()];
      repositoryHistoryLengths.push(merged.length);
      repositoryHistories.push(merged);
      repositoryRow = merged;
      return merged;
    },
  },
}));
mock.module("@/lib/services/shared-runtime/shared-runtime-chat", () => ({
  MAX_HISTORY_MESSAGES: 40,
  sharedRuntimeChatService: {
    bridge: async (
      agent: { id: string },
      rpc: { id?: string | number; params?: { roomId?: string } },
      options: {
        funding?: unknown;
        historyStore: {
          load(agentId: string, channelId: string): Promise<unknown[]>;
          save(
            agentId: string,
            channelId: string,
            history: unknown[],
          ): Promise<void>;
          merge(
            agentId: string,
            channelId: string,
            messages: unknown[],
          ): Promise<unknown[]>;
        };
      },
    ) => {
      bridgeFunding = options.funding;
      if (rpc.id === "rate-limited") {
        throw new RateLimitError("Organization rate limit exceeded.", 29);
      }
      const channelId = rpc.params?.roomId ?? agent.id;
      const history = await options.historyStore.load(agent.id, channelId);
      await options.historyStore.merge(agent.id, channelId, [
        {
          id: `message-${rpc.id}`,
          role: "user",
          content: `turn-${rpc.id}`,
          createdAt: Date.now(),
        },
      ]);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { historyLength: history.length + 1 },
      };
    },
    stream: async (
      agent: { id: string },
      rpc: { id?: string | number; params?: { roomId?: string } },
      options: {
        historyStore: {
          merge(
            agentId: string,
            channelId: string,
            messages: unknown[],
          ): Promise<unknown[]>;
        };
      },
    ) => {
      const channelId = rpc.params?.roomId ?? agent.id;
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("event: chunk\ndata: {}\n\n"),
          );
        },
        cancel: async () => {
          canceled = true;
          if (streamMergeGate) await streamMergeGate;
          await options.historyStore.merge(agent.id, channelId, [
            {
              id: `user-${rpc.id}`,
              role: "user",
              content: `stream-user-${rpc.id}`,
              createdAt: 10,
            },
            {
              id: `assistant-${rpc.id}`,
              role: "assistant",
              content: "partial",
              createdAt: 11,
              interrupted: true,
            },
          ]);
        },
      });
      return new Response(body, {
        headers: { "x-canceled": String(canceled) },
      });
    },
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn: mock(() => undefined) },
}));

const { SharedRuntimeConversation } = await import(
  "./shared-runtime-conversation"
);

beforeEach(() => {
  streamMergeGate = null;
  resolveStreamMergeGate = () => {};
  rehydrateCalls = 0;
  bridgeFunding = undefined;
});

function makeState(data: Map<string, unknown>, background: Promise<unknown>[]) {
  const state = {
    alarmDeleted: false,
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      setAlarm: async () => {
        state.alarmDeleted = false;
      },
      deleteAlarm: async () => {
        state.alarmDeleted = true;
      },
      deleteAll: async () => {
        data.clear();
      },
    },
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  };
  return state;
}

// The envelope carries a full serialized agent row: the Durable Object
// rehydrates its Date columns at ingress, so a fixture without them would
// (correctly) fail the boundary check.
const AGENT_FIXTURE = {
  id: "agent-1",
  organization_id: "org-1",
  user_id: "user-1",
  execution_tier: "shared",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  claimed_at: null,
  pool_ready_at: null,
  last_backup_at: null,
  last_heartbeat_at: null,
  last_billed_at: null,
  shutdown_warning_sent_at: null,
  scheduled_shutdown_at: null,
};

function makeInvoke(object: { fetch(request: Request): Promise<Response> }) {
  return async (id: string) => {
    const response = await object.fetch(
      new Request("https://shared-runtime.internal/bridge", {
        method: "POST",
        body: JSON.stringify({
          operation: "bridge",
          agent: AGENT_FIXTURE,
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
}

test("prewarm joins cold hydration without writing a conversation turn", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [{ role: "assistant", content: "migrated" }];
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    {} as never,
  );

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/prewarm", {
      method: "POST",
      body: JSON.stringify({
        operation: "prewarm",
        agentId: AGENT_FIXTURE.id,
        roomId: "room-1",
      }),
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ success: true });
  expect(repositoryReads).toBe(1);
  expect(repositoryWrites).toBe(0);
  expect(data.get("conversation")).toMatchObject({
    agentId: AGENT_FIXTURE.id,
    channelId: "room-1",
    history: repositoryRow,
    dirty: false,
  });

  const warmResponse = await object.fetch(
    new Request("https://shared-runtime.internal/prewarm", {
      method: "POST",
      body: JSON.stringify({
        operation: "prewarm",
        agentId: AGENT_FIXTURE.id,
        roomId: "room-1",
      }),
    }),
  );
  expect(warmResponse.status).toBe(200);
  await warmResponse.arrayBuffer();
  expect(repositoryReads).toBe(1);

  const result = await makeInvoke(object)("first-real-turn");
  expect(result).toMatchObject({ result: { historyLength: 2 } });
  expect(repositoryReads).toBe(1);
});

test("warm coordinated turns use local history and mirror asynchronously", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [{ role: "assistant", content: "migrated" }];
  repositoryHistoryLengths.length = 0;
  repositoryHistories.length = 0;
  streamMergeGate = null;
  resolveStreamMergeGate = () => {};
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    {} as never,
  );
  const invoke = makeInvoke(object);

  expect(await invoke("cold")).toMatchObject({
    code: "conversation_cache_warming",
    retryable: true,
  });
  await Promise.all(background.splice(0));
  expect(repositoryReads).toBe(1);

  expect(await invoke("one")).toMatchObject({
    result: { historyLength: 2 },
  });
  // The mirror merge write runs strictly under waitUntil; drain it
  // and confirm the turn itself added no synchronous repository traffic.
  await Promise.all(background.splice(0));
  expect(repositoryReads).toBe(1);
  expect(repositoryWrites).toBe(1);

  expect(await invoke("two")).toMatchObject({
    result: { historyLength: 3 },
  });
  await Promise.all(background.splice(0));
  expect(repositoryReads).toBe(1);
  expect(repositoryWrites).toBe(2);
  expect(repositoryHistoryLengths).toEqual([2, 3]);
});

test("rowless personal turns use platform funding without sandbox rehydration", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  const personalAgent = {
    id: "personal:10b4363d-7537-50c3-a822-cdf12a4b1405",
    organization_id: "org-1",
    user_id: "user-1",
    execution_tier: "shared",
    agent_name: "Eliza",
    character_id: null,
    agent_config: { character: { name: "Eliza" } },
  };
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    {} as never,
  );

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/bridge", {
      method: "POST",
      body: JSON.stringify({
        operation: "personal-bridge",
        agent: personalAgent,
        rpc: {
          jsonrpc: "2.0",
          id: "personal-turn",
          method: "message.send",
          params: { text: "hello", roomId: "room-1" },
        },
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(bridgeFunding).toBe("platform");
  expect(rehydrateCalls).toBe(0);
  expect(repositoryReads).toBe(0);
  expect(data.get("conversation")).toMatchObject({
    agentId: personalAgent.id,
    history: expect.any(Array),
  });
  await Promise.all(background.splice(0));
});

test("concurrent turns serialize through one room and retain both writes", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  repositoryHistoryLengths.length = 0;
  repositoryHistories.length = 0;
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: AGENT_FIXTURE.id,
        channelId: "room-1",
        history: [],
        dirty: false,
        version: 1,
      },
    ],
  ]);
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    {} as never,
  );
  const invoke = makeInvoke(object);

  const [first, second] = await Promise.all([
    invoke("concurrent-one"),
    invoke("concurrent-two"),
  ]);

  expect(first).toMatchObject({ result: { historyLength: 1 } });
  expect(second).toMatchObject({ result: { historyLength: 2 } });
  const stored = data.get("conversation") as {
    history: Array<{ id?: string; content: string }>;
  };
  expect(stored.history.map((message) => message.id)).toEqual([
    "message-concurrent-one",
    "message-concurrent-two",
  ]);
  expect(stored.history.map((message) => message.content)).toEqual([
    "turn-concurrent-one",
    "turn-concurrent-two",
  ]);
  await Promise.all(background.splice(0));
});

test("stream body cancellation persists before the room queue releases", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  repositoryHistoryLengths.length = 0;
  repositoryHistories.length = 0;
  streamMergeGate = new Promise<void>((resolve) => {
    resolveStreamMergeGate = resolve;
  });
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: AGENT_FIXTURE.id,
        channelId: "room-1",
        history: [],
        dirty: false,
        version: 1,
      },
    ],
  ]);
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    {} as never,
  );

  const streamed = await object.fetch(
    new Request("https://shared-runtime.internal/stream", {
      method: "POST",
      body: JSON.stringify({
        operation: "stream",
        agent: AGENT_FIXTURE,
        rpc: {
          jsonrpc: "2.0",
          id: "cancelled",
          method: "message.send",
          params: { text: "hi", roomId: "room-1" },
        },
      }),
    }),
  );
  const reader = streamed.body!.getReader();
  await reader.read();
  const cancel = reader.cancel("client disconnected");

  let secondCompleted = false;
  const second = makeInvoke(object)("after-cancel").then((result) => {
    secondCompleted = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(secondCompleted).toBe(false);

  resolveStreamMergeGate();
  await cancel;
  const secondResult = await second;
  expect(secondResult).toMatchObject({ result: { historyLength: 3 } });

  const stored = (
    data.get("conversation") as {
      history: Array<{ content: string; interrupted?: boolean }>;
    }
  ).history;
  expect(stored.map((message) => message.content)).toEqual([
    "stream-user-cancelled",
    "partial",
    "turn-after-cancel",
  ]);
  expect(stored[1]?.interrupted).toBe(true);
  await Promise.all(background.splice(0));
});

test("failed durable cancellation write is retryable on a later finalize", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: AGENT_FIXTURE.id,
        channelId: "room-1",
        history: [],
        dirty: false,
        version: 1,
      },
    ],
  ]);
  const background: Promise<unknown>[] = [];
  let failNextPut = true;
  const state = makeState(data, background);
  const originalPut = state.storage.put;
  state.storage.put = async (key: string, value: unknown) => {
    if (failNextPut) {
      failNextPut = false;
      throw new Error("storage unavailable");
    }
    await originalPut(key, value);
  };
  const object = new SharedRuntimeConversation(state as never, {} as never);

  const fetchStream = async () => {
    const response = await object.fetch(
      new Request("https://shared-runtime.internal/stream", {
        method: "POST",
        body: JSON.stringify({
          operation: "stream",
          agent: AGENT_FIXTURE,
          rpc: {
            jsonrpc: "2.0",
            id: "retryable",
            method: "message.send",
            params: { text: "hi", roomId: "room-1" },
          },
        }),
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    return reader.cancel("client disconnected");
  };

  await expect(fetchStream()).rejects.toThrow("storage unavailable");
  expect(
    (data.get("conversation") as { history: unknown[] }).history,
  ).toHaveLength(0);

  await fetchStream();
  const stored = (
    data.get("conversation") as {
      history: Array<{ content: string; interrupted?: boolean }>;
    }
  ).history;
  expect(stored.map((message) => message.content)).toEqual([
    "stream-user-retryable",
    "partial",
  ]);
  expect(stored[1]?.interrupted).toBe(true);
});

test("the Postgres mirror merges externally written turns instead of erasing them", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [{ role: "assistant", content: "migrated" }];
  repositoryHistoryLengths.length = 0;
  repositoryHistories.length = 0;
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    {} as never,
  );
  const invoke = makeInvoke(object);

  await invoke("cold");
  await Promise.all(background.splice(0));

  // An uncoordinated writer (gateway/daemon) lands a turn directly in the
  // Postgres row while the Durable Object owns the live conversation.
  repositoryRow = [
    { role: "assistant", content: "migrated" },
    { role: "user", content: "gateway-turn", createdAt: 9_999_999_999_999 },
  ];

  await invoke("one");
  await Promise.all(background.splice(0));

  expect(repositoryWrites).toBe(1);
  const mirrored = repositoryHistories[0] as Array<{ content: string }>;
  const contents = mirrored.map((message) => message.content);
  expect(contents).toContain("gateway-turn");
  expect(contents).toContain("turn-one");
  expect(contents).toContain("migrated");
});

test("rate denial crosses the Durable Object boundary as a typed retryable 429", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: AGENT_FIXTURE.id,
        channelId: "room-1",
        history: [],
        dirty: false,
        version: 1,
      },
    ],
  ]);
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    {} as never,
  );

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/bridge", {
      method: "POST",
      body: JSON.stringify({
        operation: "bridge",
        agent: AGENT_FIXTURE,
        rpc: {
          jsonrpc: "2.0",
          id: "rate-limited",
          method: "message.send",
          params: { text: "hi", roomId: "room-1" },
        },
      }),
    }),
  );

  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("29");
  await expect(response.json()).resolves.toMatchObject({
    code: "rate_limit_exceeded",
    retryable: true,
  });
  expect(repositoryReads).toBe(0);
  expect(repositoryWrites).toBe(0);
});

test("delete operation clears room storage and cancels the mirror-retry alarm", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: AGENT_FIXTURE.id,
        channelId: "room-1",
        history: [{ id: "m-1", role: "user", content: "secret", createdAt: 1 }],
        dirty: true,
        version: 3,
      },
    ],
  ]);
  const background: Promise<unknown>[] = [];
  const state = makeState(data, background);
  const object = new SharedRuntimeConversation(state as never, {} as never);
  const invoke = makeInvoke(object);

  // A turn first, so the delete also has warm in-memory state to discard.
  expect(await invoke("pre-delete")).toMatchObject({
    result: { historyLength: 2 },
  });
  await Promise.all(background.splice(0));
  expect(data.size).toBe(1);

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/delete", {
      method: "POST",
      body: JSON.stringify({ operation: "delete", agentId: AGENT_FIXTURE.id }),
    }),
  );

  await expect(response.json()).resolves.toEqual({ success: true });
  expect(data.size).toBe(0);
  expect(state.alarmDeleted).toBe(true);

  // The next request must observe no resident history: it falls back to the
  // cold-hydration path (warming 503) instead of serving purged content.
  expect(await invoke("post-delete")).toMatchObject({
    code: "conversation_cache_warming",
    retryable: true,
  });
  await Promise.all(background.splice(0));
});
