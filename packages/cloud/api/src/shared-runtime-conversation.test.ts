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
let repositoryDeletes = 0;
let repositoryRow: unknown[] = [];
let repositoryMergeError: Error | null = null;
let repositoryMergeGate: Promise<void> | null = null;
const repositoryHistoryLengths: number[] = [];
const repositoryHistories: unknown[][] = [];
let streamMergeGate: Promise<void> | null = null;
let resolveStreamMergeGate = () => {};
let rehydrateCalls = 0;
let bridgeFunding: unknown;
let recoveredCutoverTargetId: string | null = null;
let lastBridgeAgent: unknown;
let lastStreamOptions: Record<string, unknown> | undefined;
let apnsOutcome: { outcome: string; reason?: string; status?: number } = {
  outcome: "accepted",
};
const apnsSentTokens: string[] = [];
const apnsOutcomes = new Map<
  string,
  { outcome: string; reason?: string; status?: number } | Error
>();
const loggerInfo = mock((_message: string, _context?: unknown) => undefined);
const loggerWarn = mock(() => undefined);

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
  getCloudAwareEnv: () => process.env,
  getCloudBinding: () => undefined,
  hasCloudBindingsContext: () => false,
  runWithCloudBindings: <T>(_env: unknown, fn: () => T) => fn(),
  runWithCloudBindingsAsync: async <T>(_env: unknown, fn: () => Promise<T>) =>
    await fn(),
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget: async () =>
    recoveredCutoverTargetId ? { id: recoveredCutoverTargetId } : null,
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
      if (repositoryMergeError) throw repositoryMergeError;
      if (repositoryMergeGate) await repositoryMergeGate;
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
    deleteByAgent: async () => {
      repositoryDeletes++;
      repositoryRow = [];
      return 1;
    },
  },
}));
mock.module("@/lib/services/shared-runtime/shared-runtime-chat", () => ({
  sharedRuntimeChatService: {
    getHistory: async (
      agentId: string,
      channelId: string,
      historyStore: {
        load(agentId: string, channelId: string): Promise<unknown[]>;
      },
    ) => await historyStore.load(agentId, channelId),
    bridge: async (
      agent: { id: string },
      rpc: {
        id?: string | number;
        params?: { roomId?: string; text?: string };
      },
      options: {
        funding?: unknown;
        mobilePushDispatch?: (message: {
          title: string;
          body?: string;
        }) => Promise<void>;
        historyStore: {
          load(
            agentId: string,
            channelId: string,
            queryText?: string,
          ): Promise<unknown[]>;
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
      lastBridgeAgent = agent;
      if (rpc.id === "push-event") {
        await options.mobilePushDispatch?.({
          title: "Reminder",
          body: "Stand up",
        });
      }
      if (rpc.id === "rate-limited") {
        throw new RateLimitError("Organization rate limit exceeded.", 29);
      }
      const channelId = rpc.params?.roomId ?? agent.id;
      const history = await options.historyStore.load(
        agent.id,
        channelId,
        rpc.params?.text,
      );
      await options.historyStore.merge(agent.id, channelId, [
        {
          id: `message-${rpc.id}`,
          role: "user",
          content:
            rpc.id === "large-history"
              ? (rpc.params?.text ?? "")
              : `turn-${rpc.id}`,
          createdAt: Date.now(),
        },
      ]);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          historyLength: history.length + 1,
          historyIds: history.map((message) =>
            typeof message === "object" &&
            message !== null &&
            typeof (message as { id?: unknown }).id === "string"
              ? (message as { id: string }).id
              : null,
          ),
        },
      };
    },
    stream: async (
      agent: { id: string },
      rpc: { id?: string | number; params?: { roomId?: string } },
      options: {
        trustedMessageRole?: "system";
        trustedHistoryCutoffAt?: number;
        historyStore: {
          merge(
            agentId: string,
            channelId: string,
            messages: unknown[],
          ): Promise<unknown[]>;
        };
      },
    ) => {
      lastStreamOptions = options as unknown as Record<string, unknown>;
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
mock.module("@/lib/mobile-push/apns-provider", () => ({
  resolveCloudApnsConfig: (env: { ELIZA_APNS_KEY?: string }) =>
    env.ELIZA_APNS_KEY ? { configured: true } : null,
  CloudApnsProvider: class {
    async send(token: string) {
      apnsSentTokens.push(token);
      const outcome = apnsOutcomes.get(token) ?? apnsOutcome;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => undefined,
    error: () => undefined,
    info: loggerInfo,
    warn: loggerWarn,
  },
}));

const { SharedRuntimeConversation } = await import(
  "./shared-runtime-conversation"
);
const { coordinateSharedPushDispatch } = await import(
  "@/lib/services/shared-runtime/conversation-coordinator"
);
type SharedRuntimeConversationInstance = InstanceType<
  typeof SharedRuntimeConversation
>;

beforeEach(() => {
  repositoryMergeError = null;
  repositoryMergeGate = null;
  repositoryDeletes = 0;
  streamMergeGate = null;
  resolveStreamMergeGate = () => {};
  rehydrateCalls = 0;
  bridgeFunding = undefined;
  recoveredCutoverTargetId = null;
  lastBridgeAgent = undefined;
  lastStreamOptions = undefined;
  apnsOutcome = { outcome: "accepted" };
  apnsSentTokens.length = 0;
  apnsOutcomes.clear();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
});

function makeState(data: Map<string, unknown>, background: Promise<unknown>[]) {
  const state = {
    alarmDeleted: false,
    alarmTime: null as number | null,
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      list: async <T>(options?: { prefix?: string }) =>
        new Map(
          [...data.entries()].filter(
            ([key]) => !options?.prefix || key.startsWith(options.prefix),
          ),
        ) as Map<string, T>,
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      delete: async (key: string) => {
        data.delete(key);
      },
      setAlarm: async (time?: number) => {
        state.alarmDeleted = false;
        state.alarmTime = typeof time === "number" ? time : null;
      },
      deleteAlarm: async () => {
        state.alarmDeleted = true;
        state.alarmTime = null;
      },
      deleteAll: async () => {
        data.clear();
      },
      transaction: async (
        operation: (txn: {
          list(): Promise<Map<string, unknown>>;
          delete(keys: string[]): Promise<number>;
          put(key: string, value: unknown): Promise<void>;
        }) => Promise<void>,
      ) =>
        await operation({
          list: async () => new Map(data),
          delete: async (keys) => {
            let deleted = 0;
            for (const key of keys) {
              if (data.delete(key)) deleted++;
            }
            return deleted;
          },
          put: async (key, value) => {
            data.set(key, structuredClone(value));
          },
        }),
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

async function pushOperation(
  object: { fetch(request: Request): Promise<Response> },
  body: Record<string, unknown>,
) {
  return await object.fetch(
    new Request("https://shared-runtime.internal/mobile-push", {
      method: "POST",
      body: JSON.stringify({ agentId: AGENT_FIXTURE.id, ...body }),
    }),
  );
}

test("rejects malformed channel metadata before runtime dispatch", async () => {
  const object = new SharedRuntimeConversation(
    makeState(new Map<string, unknown>(), []) as never,
    {} as never,
  );
  const response = await object.fetch(
    new Request("https://shared-runtime.internal/bridge", {
      method: "POST",
      body: JSON.stringify({
        operation: "bridge",
        agent: AGENT_FIXTURE,
        channel: { type: "NOT_A_CHANNEL", source: "forged source" },
        rpc: {
          jsonrpc: "2.0",
          id: "invalid-channel",
          method: "message.send",
          params: { text: "hi", roomId: "room-1" },
        },
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_channel" });
});

test("mobile push registration is durable, idempotent, iOS-only, and removable", async () => {
  const data = new Map<string, unknown>();
  const object = new SharedRuntimeConversation(
    makeState(data, []) as never,
    {} as never,
  );
  for (const platform of ["ios", "ios"] as const) {
    const response = await pushOperation(object, {
      operation: "push-register",
      platform,
      token: "ios-token",
    });
    expect(response.status).toBe(201);
    await response.arrayBuffer();
  }
  const list = await pushOperation(object, { operation: "push-list" });
  expect(await list.json()).toMatchObject({
    tokens: [{ token: "ios-token", platform: "ios" }],
  });
  const android = await pushOperation(object, {
    operation: "push-register",
    platform: "android",
    token: "android-token",
  });
  expect(android.status).toBe(400);
  await android.arrayBuffer();
  const removed = await pushOperation(object, {
    operation: "push-unregister",
    token: "ios-token",
  });
  expect((await removed.json()) as unknown).toEqual({ removed: true });
  expect(data.has("mobile-push-tokens")).toBe(false);
});

test("mobile push register and unregister share exact 4096-character boundaries", async () => {
  const data = new Map<string, unknown>();
  const object = new SharedRuntimeConversation(
    makeState(data, []) as never,
    {} as never,
  );
  const maximumToken = "x".repeat(4_096);
  const oversizedToken = "x".repeat(4_097);

  const maximumRegistration = await pushOperation(object, {
    operation: "push-register",
    platform: "ios",
    token: maximumToken,
  });
  expect(maximumRegistration.status).toBe(201);
  await maximumRegistration.arrayBuffer();

  const oversizedRegistration = await pushOperation(object, {
    operation: "push-register",
    platform: "ios",
    token: oversizedToken,
  });
  expect(oversizedRegistration.status).toBe(400);
  await oversizedRegistration.arrayBuffer();

  const maximumUnregister = await pushOperation(object, {
    operation: "push-unregister",
    token: maximumToken,
  });
  expect(maximumUnregister.status).toBe(200);
  expect((await maximumUnregister.json()) as unknown).toEqual({
    removed: true,
  });

  const oversizedUnregister = await pushOperation(object, {
    operation: "push-unregister",
    token: oversizedToken,
  });
  expect(oversizedUnregister.status).toBe(400);
  await oversizedUnregister.arrayBuffer();
});

test("notification dispatch sends iOS tokens and removes APNs-dead records", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    { ELIZA_APNS_KEY: "configured" } as never,
  );
  await (
    await pushOperation(object, {
      operation: "push-register",
      platform: "ios",
      token: "dead-token",
    })
  ).arrayBuffer();
  apnsOutcome = { outcome: "unregistered", reason: "BadDeviceToken" };
  const dispatched = await pushOperation(object, {
    operation: "push-dispatch",
    message: { title: "Reminder", body: "Time to leave" },
  });
  expect(dispatched.status).toBe(202);
  await dispatched.arrayBuffer();
  await Promise.all(background.splice(0));
  expect(apnsSentTokens).toEqual(["dead-token"]);
  expect(data.has("mobile-push-tokens")).toBe(false);
});

test("real coordinator namespace dispatch reaches the durable APNs provider path", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    { ELIZA_APNS_KEY: "configured" } as never,
  );
  await (
    await pushOperation(object, {
      operation: "push-register",
      platform: "ios",
      token: "coordinated-token",
    })
  ).arrayBuffer();
  const names: string[] = [];
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          object.fetch(new Request(input, init)),
      };
    },
  };

  await coordinateSharedPushDispatch(
    AGENT_FIXTURE.id,
    {
      title: "Reminder",
      collapseKey: "scheduled-occurrence",
      data: { notificationId: "scheduled-occurrence" },
    },
    { namespace: namespace as never },
  );
  await Promise.all(background.splice(0));

  expect(names).toEqual([`${AGENT_FIXTURE.id}:${AGENT_FIXTURE.id}`]);
  expect(apnsSentTokens).toEqual(["coordinated-token"]);
});

test("notification dispatch settles every device when one APNs request fails", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    { ELIZA_APNS_KEY: "configured" } as never,
  );
  for (const token of ["live-token", "dead-token", "network-token"]) {
    await (
      await pushOperation(object, {
        operation: "push-register",
        platform: "ios",
        token,
      })
    ).arrayBuffer();
  }
  apnsOutcomes.set("dead-token", {
    outcome: "unregistered",
    reason: "ExpiredToken",
  });
  apnsOutcomes.set("network-token", new Error("APNs timeout"));

  const dispatched = await pushOperation(object, {
    operation: "push-dispatch",
    message: { title: "Reminder" },
  });
  expect(dispatched.status).toBe(202);
  await dispatched.arrayBuffer();
  await Promise.all(background.splice(0));

  expect(new Set(apnsSentTokens)).toEqual(
    new Set(["live-token", "dead-token", "network-token"]),
  );
  expect(data.get("mobile-push-tokens")).toEqual([
    expect.objectContaining({ token: "live-token" }),
    expect.objectContaining({ token: "network-token" }),
  ]);
});

test("accepted occurrence replay is suppressed by the bounded durable ledger", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    { ELIZA_APNS_KEY: "configured" } as never,
  );
  await (
    await pushOperation(object, {
      operation: "push-register",
      platform: "ios",
      token: "live-token",
    })
  ).arrayBuffer();
  const dispatch = async () => {
    await (
      await pushOperation(object, {
        operation: "push-dispatch",
        message: {
          title: "Reminder",
          collapseKey: "reminder-occurrence-1",
        },
      })
    ).arrayBuffer();
    await Promise.all(background.splice(0));
  };

  await dispatch();
  await dispatch();

  expect(apnsSentTokens).toEqual(["live-token"]);
  const ledger = data.get("mobile-push-delivery-ledger") as Record<
    string,
    { status: string }
  >;
  expect(Object.keys(ledger)).toHaveLength(1);
  expect(Object.keys(ledger)[0]?.length).toBe(64);
  expect(Object.values(ledger)[0]?.status).toBe("accepted");
});

test("concurrent occurrence ledgers merge without storing raw maximum-length tokens", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    { ELIZA_APNS_KEY: "configured" } as never,
  );
  const token = "sensitive-token-".padEnd(4_096, "x");
  await (
    await pushOperation(object, {
      operation: "push-register",
      platform: "ios",
      token,
    })
  ).arrayBuffer();
  const enqueue = async (collapseKey: string) =>
    await (
      await pushOperation(object, {
        operation: "push-dispatch",
        message: { title: "Reminder", collapseKey },
      })
    ).arrayBuffer();

  await Promise.all([enqueue("occurrence-a"), enqueue("occurrence-b")]);
  await Promise.all(background.splice(0));
  await Promise.all([enqueue("occurrence-a"), enqueue("occurrence-b")]);
  await Promise.all(background.splice(0));

  expect(apnsSentTokens).toHaveLength(2);
  const ledgerJson = JSON.stringify(data.get("mobile-push-delivery-ledger"));
  expect(ledgerJson).not.toContain("sensitive-token-");
  expect(new TextEncoder().encode(ledgerJson).length).toBeLessThan(1_024);
  const ledger = data.get("mobile-push-delivery-ledger") as Record<
    string,
    { acceptedTokens: string[] }
  >;
  expect(Object.keys(ledger)).toHaveLength(2);
  for (const entry of Object.values(ledger)) {
    expect(entry.acceptedTokens).toHaveLength(1);
    expect(entry.acceptedTokens[0]?.length).toBe(64);
  }
});

test("retry sends only unsettled devices and never logs an APNs token URL", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    { ELIZA_APNS_KEY: "configured" } as never,
  );
  for (const token of ["accepted-token", "private-device-token"]) {
    await (
      await pushOperation(object, {
        operation: "push-register",
        platform: "ios",
        token,
      })
    ).arrayBuffer();
  }
  apnsOutcomes.set(
    "private-device-token",
    new Error(
      "fetch failed https://api.push.apple.com/3/device/private-device-token",
    ),
  );
  const dispatch = async () => {
    await (
      await pushOperation(object, {
        operation: "push-dispatch",
        message: {
          title: "Reminder",
          collapseKey: "reminder-occurrence-2",
        },
      })
    ).arrayBuffer();
    await Promise.all(background.splice(0));
  };

  await dispatch();
  expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(
    "private-device-token",
  );
  expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(
    "api.push.apple.com",
  );
  expect(JSON.stringify(loggerWarn.mock.calls)).toContain("1 transport");

  apnsOutcomes.delete("private-device-token");
  await dispatch();
  expect(apnsSentTokens).toEqual([
    "accepted-token",
    "private-device-token",
    "private-device-token",
  ]);
});

test("partial-failure ledger prunes hashes through repeated token rotation", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const object = new SharedRuntimeConversation(
    makeState(data, background) as never,
    { ELIZA_APNS_KEY: "configured" } as never,
  );
  const mutateToken = async (
    operation: "push-register" | "push-unregister",
    token: string,
  ) => {
    await (
      await pushOperation(object, {
        operation,
        ...(operation === "push-register" ? { platform: "ios" } : {}),
        token,
      })
    ).arrayBuffer();
  };
  const dispatch = async () => {
    await (
      await pushOperation(object, {
        operation: "push-dispatch",
        message: {
          title: "Reminder",
          collapseKey: "rotation-occurrence",
        },
      })
    ).arrayBuffer();
    await Promise.all(background.splice(0));
  };
  await mutateToken("push-register", "always-failing-token");
  apnsOutcomes.set("always-failing-token", new Error("offline"));

  let previousRotatedToken: string | undefined;
  for (let index = 0; index < 40; index++) {
    if (previousRotatedToken) {
      await mutateToken("push-unregister", previousRotatedToken);
    }
    const rotatedToken = `rotated-token-${index}`;
    await mutateToken("push-register", rotatedToken);
    await dispatch();
    previousRotatedToken = rotatedToken;
  }

  const ledger = data.get("mobile-push-delivery-ledger") as Record<
    string,
    { status: string; acceptedTokens: string[] }
  >;
  const entry = Object.values(ledger)[0];
  expect(entry?.status).toBe("retryable");
  expect(entry?.acceptedTokens).toHaveLength(1);
  expect(entry?.acceptedTokens[0]?.length).toBe(64);
  expect(entry?.acceptedTokens.length).toBeLessThanOrEqual(32);
});

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
  await Promise.all(background.splice(0));
  expect(repositoryReads).toBe(1);
  expect(
    loggerInfo.mock.calls.filter(
      ([message]) =>
        message ===
        "[SharedRuntimeConversation] conversation prewarm completed",
    ),
  ).toHaveLength(1);
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
  await Promise.all(background.splice(0));
  expect(repositoryReads).toBe(1);
  expect(
    loggerInfo.mock.calls.filter(
      ([message]) =>
        message ===
        "[SharedRuntimeConversation] conversation prewarm completed",
    ),
  ).toHaveLength(1);

  const result = await makeInvoke(object)("first-real-turn");
  expect(result).toMatchObject({ result: { historyLength: 2 } });
  expect(repositoryReads).toBe(1);
});

test("fresh-room prewarm skips a legacy history query", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [{ role: "assistant", content: "must not leak" }];
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
        roomId: "new-phone-call",
        startEmpty: true,
      }),
    }),
  );

  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(repositoryReads).toBe(0);
  expect(repositoryWrites).toBe(0);
  expect(data.get("conversation")).toMatchObject({
    agentId: AGENT_FIXTURE.id,
    channelId: "new-phone-call",
    history: [],
    dirty: false,
  });
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

test("a cutover seal snapshots history and blocks new Shared turns until release or commit", async () => {
  const personalAgent = {
    id: "personal-agent-cutover",
    organization_id: "org-1",
    user_id: "user-1",
    character_id: null,
    agent_name: "Eliza",
    agent_config: { character: { name: "Eliza" } },
    execution_tier: "shared",
  };
  const history = [{ id: "u1", role: "user", content: "hello", createdAt: 10 }];
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: personalAgent.id,
        channelId: personalAgent.id,
        history,
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
  const request = (payload: Record<string, unknown>) =>
    object.fetch(
      new Request("https://shared-runtime.internal/cutover", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  const personalTurn = () =>
    request({
      operation: "personal-bridge",
      agent: personalAgent,
      rpc: {
        jsonrpc: "2.0",
        id: "after-seal",
        method: "message.send",
        params: { text: "new turn", roomId: personalAgent.id },
      },
    });

  const sealed = await request({
    operation: "cutover-seal",
    agentId: personalAgent.id,
    roomId: personalAgent.id,
    token: "cutover-1",
    leaseMs: 60_000,
    organizationId: personalAgent.organization_id,
    dedicatedAgentId: "dedicated-agent-1",
  });
  expect(sealed.status).toBe(200);
  const sealedPayload: unknown = await sealed.json();
  expect(sealedPayload).toEqual({ success: true, history });

  const blocked = await personalTurn();
  expect(blocked.status).toBe(423);
  expect(await blocked.json()).toMatchObject({
    code: "personal_cutover_in_progress",
    retryable: true,
  });

  const released = await request({
    operation: "cutover-release",
    token: "cutover-1",
  });
  expect(released.status).toBe(200);
  await released.json();
  const resumed = await personalTurn();
  expect(resumed.status).toBe(200);
  await resumed.json();

  await request({
    operation: "cutover-seal",
    agentId: personalAgent.id,
    roomId: personalAgent.id,
    token: "cutover-2",
    leaseMs: 60_000,
    organizationId: personalAgent.organization_id,
    dedicatedAgentId: "dedicated-agent-1",
  }).then((response) => response.json());
  const committedSeal = await request({
    operation: "cutover-commit",
    token: "cutover-2",
  });
  expect(committedSeal.status).toBe(200);
  await committedSeal.json();
  const committed = await personalTurn();
  expect(committed.status).toBe(409);
  expect(await committed.json()).toMatchObject({
    code: "personal_eliza_dedicated",
    retryable: false,
  });

  const storedSeal = data.get("personal-cutover-seal") as {
    token: string;
    expiresAt: number;
    committed: boolean;
  };
  data.set("personal-cutover-seal", { ...storedSeal, expiresAt: 0 });
  const staleSession = await personalTurn();
  expect(staleSession.status).toBe(409);
  expect(await staleSession.json()).toMatchObject({
    code: "personal_eliza_dedicated",
    retryable: false,
  });
});

test("an expired pending seal recovers the authoritative Dedicated marker", async () => {
  const personalAgent = {
    id: "personal-agent-recovery",
    organization_id: "org-recovery",
    user_id: "user-recovery",
    character_id: null,
    agent_name: "Eliza",
    agent_config: { character: { name: "Eliza" } },
    execution_tier: "shared",
  };
  recoveredCutoverTargetId = "dedicated-agent-recovery";
  const data = new Map<string, unknown>([
    [
      "personal-cutover-seal",
      {
        token: "cutover-recovery",
        expiresAt: 0,
        committed: false,
        organizationId: personalAgent.organization_id,
        sourceAgentId: personalAgent.id,
        dedicatedAgentId: recoveredCutoverTargetId,
      },
    ],
  ]);
  const object = new SharedRuntimeConversation(
    makeState(data, []) as never,
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
          id: "turn-after-db-commit",
          method: "message.send",
          params: { text: "stay dedicated", roomId: personalAgent.id },
        },
      }),
    }),
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "personal_eliza_dedicated",
    retryable: false,
  });
  expect(data.get("personal-cutover-seal")).toMatchObject({
    token: "cutover-recovery",
    committed: true,
    dedicatedAgentId: recoveredCutoverTargetId,
  });
});

test("an expired pending seal releases Shared when no Dedicated marker exists", async () => {
  const personalAgent = {
    id: "personal-agent-release",
    organization_id: "org-release",
    user_id: "user-release",
    character_id: null,
    agent_name: "Eliza",
    agent_config: { character: { name: "Eliza" } },
    execution_tier: "shared",
  };
  const data = new Map<string, unknown>([
    [
      "personal-cutover-seal",
      {
        token: "cutover-release",
        expiresAt: 0,
        committed: false,
        organizationId: personalAgent.organization_id,
        sourceAgentId: personalAgent.id,
        dedicatedAgentId: "dedicated-agent-missing",
      },
    ],
  ]);
  const object = new SharedRuntimeConversation(
    makeState(data, []) as never,
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
          id: "turn-after-expired-lease",
          method: "message.send",
          params: { text: "continue shared", roomId: personalAgent.id },
        },
      }),
    }),
  );

  expect(response.status).toBe(200);
  await response.json();
  expect(data.has("personal-cutover-seal")).toBe(false);
});

test("target convergence reservation and Dedicated cutover serialize onto one winner", async () => {
  const agentId = "personal:00000000-0000-5000-8000-000000000099";
  const convergence = {
    operation: "provisional-convergence-reserve",
    agentId,
    token: "phone-telegram:source:target",
    holderId: "claim-holder",
    leaseMs: 60_000,
  };
  const cutover = {
    operation: "cutover-seal",
    agentId,
    roomId: agentId,
    token: "personal-cutover:target:dedicated",
    leaseMs: 60_000,
    organizationId: "00000000-0000-4000-8000-000000000001",
    dedicatedAgentId: "00000000-0000-4000-8000-000000000002",
  };
  const race = async (
    first: typeof convergence | typeof cutover,
    second: typeof convergence | typeof cutover,
  ) => {
    const data = new Map<string, unknown>();
    const object = new SharedRuntimeConversation(
      makeState(data, []) as never,
      {} as never,
    );
    const invoke = async (payload: Record<string, unknown>) => {
      const response = await object.fetch(
        new Request(
          "https://shared-runtime.internal/convergence-cutover-race",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        ),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const results = await Promise.all([invoke(first), invoke(second)]);
    return { data, invoke, results };
  };

  const convergenceFirst = await race(convergence, cutover);
  expect(convergenceFirst.results).toEqual([
    { status: 200, body: { success: true } },
    {
      status: 423,
      body: {
        success: false,
        error: "Personal history is being linked. Retry shortly.",
        code: "personal_convergence_in_progress",
        retryable: true,
      },
    },
  ]);
  await convergenceFirst.invoke({
    operation: "provisional-convergence-release",
    token: convergence.token,
    holderId: "not-the-holder",
  });
  await convergenceFirst.invoke({
    operation: "provisional-convergence-release",
    token: "phone-telegram:different:attempt",
    holderId: convergence.holderId,
  });
  expect(
    convergenceFirst.data.get("personal-provisional-convergence-reservation"),
  ).toMatchObject({
    token: convergence.token,
    holderIds: [convergence.holderId],
  });

  const cutoverFirst = await race(cutover, convergence);
  expect(cutoverFirst.results).toEqual([
    { status: 200, body: { success: true, history: [] } },
    {
      status: 423,
      body: { success: false, code: "personal_cutover_in_progress" },
    },
  ]);
  const refusedImport = await cutoverFirst.invoke({
    operation: "provisional-convergence-import",
    agentId,
    token: convergence.token,
    holderId: convergence.holderId,
    history: [],
  });
  expect(refusedImport).toEqual({
    status: 423,
    body: { success: false, code: "personal_cutover_in_progress" },
  });
  expect(cutoverFirst.data.has("personal-cutover-seal")).toBe(true);
  expect(
    cutoverFirst.data.has("personal-provisional-convergence-reservation"),
  ).toBe(false);
});

test("provisional convergence imports history once and aliases stale source-room turns", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  const sourceAgentId = "personal:00000000-0000-5000-8000-000000000001";
  const targetAgentId = "personal:00000000-0000-5000-8000-000000000002";
  const targetUserId = "00000000-0000-4000-8000-000000000003";
  const targetOrganizationId = "00000000-0000-4000-8000-000000000004";
  const sourceHistory = [
    { id: "source-1", role: "user", content: "phone history", createdAt: 1 },
  ];
  const targetHistory = [
    {
      id: "target-1",
      role: "assistant",
      content: "telegram history",
      createdAt: 2,
    },
  ];
  const sourceData = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: sourceAgentId,
        channelId: sourceAgentId,
        history: sourceHistory,
        dirty: false,
        version: 1,
      },
    ],
  ]);
  const targetData = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: targetAgentId,
        channelId: targetAgentId,
        history: targetHistory,
        dirty: false,
        version: 1,
      },
    ],
  ]);
  const sourceBackground: Promise<unknown>[] = [];
  const targetBackground: Promise<unknown>[] = [];
  const objects = new Map<string, SharedRuntimeConversationInstance>();
  const namespace = {
    getByName(name: string) {
      const object = objects.get(name);
      if (!object) throw new Error(`Missing test Durable Object ${name}`);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
          await object.fetch(
            input instanceof Request ? input : new Request(input, init),
          ),
      };
    },
  };
  const source = new SharedRuntimeConversation(
    makeState(sourceData, sourceBackground) as never,
    {
      SHARED_RUNTIME_CONVERSATIONS: namespace,
    } as never,
  );
  const target = new SharedRuntimeConversation(
    makeState(targetData, targetBackground) as never,
    {
      SHARED_RUNTIME_CONVERSATIONS: namespace,
    } as never,
  );
  objects.set(`${sourceAgentId}:${sourceAgentId}`, source);
  objects.set(`${targetAgentId}:${targetAgentId}`, target);

  const request = (
    object: SharedRuntimeConversationInstance,
    payload: Record<string, unknown>,
  ) =>
    object.fetch(
      new Request("https://shared-runtime.internal/provisional-convergence", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  const token = "phone-telegram:source-user:target-user";
  const holderId = "holder-one";
  const reserved = await request(target, {
    operation: "provisional-convergence-reserve",
    agentId: targetAgentId,
    token,
    holderId,
    leaseMs: 60_000,
  });
  expect(reserved.status).toBe(200);
  await reserved.json();
  const sealed = await request(source, {
    operation: "provisional-convergence-seal",
    agentId: sourceAgentId,
    token,
    holderId,
    targetAgentId,
    targetUserId,
    targetOrganizationId,
    leaseMs: 60_000,
  });
  expect(sealed.status).toBe(200);
  expect((await sealed.json()) as Record<string, unknown>).toEqual({
    success: true,
    alreadyAliased: false,
    history: sourceHistory,
  });

  const blocked = await request(source, {
    operation: "personal-bridge",
    agent: {
      ...AGENT_FIXTURE,
      id: sourceAgentId,
      agent_name: "Eliza",
      character_id: null,
      agent_config: { character: { name: "Eliza" } },
    },
    rpc: {
      jsonrpc: "2.0",
      id: "blocked-during-convergence",
      method: "message.send",
      params: { text: "wait", roomId: sourceAgentId },
    },
  });
  expect(blocked.status).toBe(423);
  expect(await blocked.json()).toMatchObject({
    code: "personal_convergence_in_progress",
  });

  const secondReserved = await request(target, {
    operation: "provisional-convergence-reserve",
    agentId: targetAgentId,
    token,
    holderId: "holder-two",
    leaseMs: 60_000,
  });
  expect(secondReserved.status).toBe(200);
  await secondReserved.json();
  const secondSeal = await request(source, {
    operation: "provisional-convergence-seal",
    agentId: sourceAgentId,
    token,
    holderId: "holder-two",
    targetAgentId,
    targetUserId,
    targetOrganizationId,
    leaseMs: 60_000,
  });
  expect(secondSeal.status).toBe(200);
  await secondSeal.json();
  const releasedFirstHolder = await request(source, {
    operation: "provisional-convergence-release",
    token,
    holderId,
  });
  expect((await releasedFirstHolder.json()) as Record<string, unknown>).toEqual(
    { success: true },
  );
  await request(target, {
    operation: "provisional-convergence-release",
    token,
    holderId,
  }).then((response) => response.json());
  const stillSealed = sourceData.get(
    "personal-provisional-convergence-seal",
  ) as {
    holderIds: string[];
  };
  expect(stillSealed.holderIds).toEqual(["holder-two"]);
  expect(
    targetData.get("personal-provisional-convergence-reservation"),
  ).toMatchObject({ token, holderIds: ["holder-two"] });

  const importPayload = {
    operation: "provisional-convergence-import",
    agentId: targetAgentId,
    token,
    holderId: "holder-two",
    history: sourceHistory,
  };
  const imported = await request(target, importPayload);
  expect((await imported.json()) as Record<string, unknown>).toEqual({
    success: true,
    alreadyImported: false,
  });
  targetData.delete(`personal-provisional-convergence-import:${token}`);
  const replayedAfterMarkerLoss = await request(target, importPayload);
  expect(
    (await replayedAfterMarkerLoss.json()) as Record<string, unknown>,
  ).toEqual({
    success: true,
    alreadyImported: false,
  });
  const replayedImport = await request(target, importPayload);
  expect((await replayedImport.json()) as Record<string, unknown>).toEqual({
    success: true,
    alreadyImported: true,
  });

  const aliased = await request(source, {
    operation: "provisional-convergence-alias",
    token,
    targetAgentId,
    targetUserId,
    targetOrganizationId,
  });
  expect((await aliased.json()) as Record<string, unknown>).toEqual({
    success: true,
  });
  const replayedAlias = await request(source, {
    operation: "provisional-convergence-alias",
    token,
    targetAgentId,
    targetUserId,
    targetOrganizationId,
  });
  expect((await replayedAlias.json()) as Record<string, unknown>).toEqual({
    success: true,
  });
  const releasedTarget = await request(target, {
    operation: "provisional-convergence-release",
    token,
    holderId: "holder-two",
  });
  expect((await releasedTarget.json()) as Record<string, unknown>).toEqual({
    success: true,
  });
  expect(targetData.has("personal-provisional-convergence-reservation")).toBe(
    false,
  );

  const staleSourceTurn = await request(source, {
    operation: "personal-bridge",
    agent: {
      ...AGENT_FIXTURE,
      id: sourceAgentId,
      agent_name: "Eliza",
      character_id: null,
      agent_config: { character: { name: "Eliza" } },
    },
    rpc: {
      jsonrpc: "2.0",
      id: "stale-source-turn",
      method: "message.send",
      params: { text: "continue", roomId: sourceAgentId },
    },
  });
  expect(staleSourceTurn.status).toBe(200);
  expect(await staleSourceTurn.json()).toMatchObject({
    result: {
      historyLength: 3,
      historyIds: ["source-1", "target-1"],
    },
  });
  expect(lastBridgeAgent).toMatchObject({
    id: targetAgentId,
    user_id: targetUserId,
    organization_id: targetOrganizationId,
  });
  expect(sourceData.get("personal-provisional-convergence-alias")).toEqual({
    token,
    targetAgentId,
    targetUserId,
    targetOrganizationId,
  });
  expect(
    (
      targetData.get("conversation") as {
        history: Array<{ id: string }>;
      }
    ).history.map((message) => message.id),
  ).toEqual(["source-1", "target-1", "message-stale-source-turn"]);
  await Promise.all([...sourceBackground, ...targetBackground]);
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

test("archives and restores an oversized message without changing its content", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
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
  const content = "x".repeat(1_600_000);

  const turn = await object.fetch(
    new Request("https://shared-runtime.internal/bridge", {
      method: "POST",
      body: JSON.stringify({
        operation: "bridge",
        agent: AGENT_FIXTURE,
        rpc: {
          jsonrpc: "2.0",
          id: "large-history",
          method: "message.send",
          params: { text: content, roomId: "room-1" },
        },
      }),
    }),
  );
  expect(turn.status).toBe(200);
  await turn.arrayBuffer();

  const stored = data.get("conversation") as { history: unknown[] };
  expect(stored.history).toEqual([]);
  expect(
    [...data.keys()].filter((key) => key.startsWith("history-archive-body:"))
      .length,
  ).toBeGreaterThan(1);

  const historyResponse = await object.fetch(
    new Request("https://shared-runtime.internal/history", {
      method: "POST",
      body: JSON.stringify({
        operation: "history",
        agentId: AGENT_FIXTURE.id,
        roomId: "room-1",
      }),
    }),
  );
  const history = (await historyResponse.json()) as {
    history: Array<{ content: string }>;
  };
  expect(history.history).toHaveLength(1);
  expect(history.history[0]?.content).toBe(content);
  await Promise.all(background.splice(0));
});

test("personal history archives beyond the model window and cutover reads every turn", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: "personal:test-user",
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

  for (let index = 0; index < 45; index += 1) {
    const turnId = index === 0 ? "zebra-memory" : `archive-${index}`;
    const response = await object.fetch(
      new Request("https://shared-runtime.internal/personal-bridge", {
        method: "POST",
        body: JSON.stringify({
          operation: "personal-bridge",
          agent: {
            ...AGENT_FIXTURE,
            id: "personal:test-user",
            agent_name: "Eliza",
            character_id: null,
            agent_config: { character: { name: "Eliza" } },
          },
          rpc: {
            jsonrpc: "2.0",
            id: turnId,
            method: "message.send",
            params: { text: "hi", roomId: "room-1" },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }

  const recalledResponse = await object.fetch(
    new Request("https://shared-runtime.internal/personal-bridge", {
      method: "POST",
      body: JSON.stringify({
        operation: "personal-bridge",
        agent: {
          ...AGENT_FIXTURE,
          id: "personal:test-user",
          agent_name: "Eliza",
          character_id: null,
          agent_config: { character: { name: "Eliza" } },
        },
        rpc: {
          jsonrpc: "2.0",
          id: "recall",
          method: "message.send",
          params: { text: "What did I say about zebra?", roomId: "room-1" },
        },
      }),
    }),
  );
  const recalled = (await recalledResponse.json()) as {
    result?: { historyIds?: Array<string | null> };
  };
  expect(recalled.result?.historyIds).toContain("message-zebra-memory");

  const active = data.get("conversation") as { history: unknown[] };
  expect(active.history).toHaveLength(40);
  expect(
    [...data.keys()].filter((key) => key.startsWith("history-archive:")),
  ).toHaveLength(6);

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/history", {
      method: "POST",
      body: JSON.stringify({
        operation: "history",
        agentId: "personal:test-user",
        roomId: "room-1",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { history: unknown[] };
  expect(body.history).toHaveLength(46);
  await Promise.all(background.splice(0));
});

test("forwards the server-authenticated history cutoff across the Durable Object", async () => {
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
  const object = new SharedRuntimeConversation(
    makeState(data, []) as never,
    {} as never,
  );

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/stream", {
      method: "POST",
      body: JSON.stringify({
        operation: "stream",
        agent: AGENT_FIXTURE,
        trustedMessageRole: "system",
        trustedHistoryCutoffAt: 1_725_000_000_000,
        rpc: {
          jsonrpc: "2.0",
          id: "trusted-cutoff",
          method: "message.send",
          params: { text: "generate a greeting", roomId: "room-1" },
        },
      }),
    }),
  );
  await response.body?.cancel();

  expect(lastStreamOptions).toMatchObject({
    trustedMessageRole: "system",
    trustedHistoryCutoffAt: 1_725_000_000_000,
  });
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
  // Snapshot plus the persisted alarm-deadline set (idle expiry is armed on
  // every non-personal save).
  expect(data.size).toBe(2);

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/delete", {
      method: "POST",
      body: JSON.stringify({ operation: "delete", agentId: AGENT_FIXTURE.id }),
    }),
  );

  await expect(response.json()).resolves.toEqual({ success: true });
  // Everything is purged except the deletion tombstone that fences the room.
  expect(data.size).toBe(1);
  expect(data.has("deletion-tombstone")).toBe(true);
  expect(state.alarmDeleted).toBe(true);

  // The next request must observe the tombstone and fail closed instead of
  // re-creating conversation state for a deleted agent.
  expect(await invoke("post-delete")).toMatchObject({
    code: "agent_deleted",
    retryable: false,
  });
  await Promise.all(background.splice(0));
  expect(data.size).toBe(1);
});

test("a deletion tombstone fences late mirrors and alarms from resurrecting content", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const state = makeState(data, background);
  const object = new SharedRuntimeConversation(state as never, {} as never);

  const response = await object.fetch(
    new Request("https://shared-runtime.internal/delete", {
      method: "POST",
      body: JSON.stringify({ operation: "delete", agentId: AGENT_FIXTURE.id }),
    }),
  );
  await expect(response.json()).resolves.toEqual({ success: true });

  // A mirror queued before the deletion must become a no-op after it.
  await (
    object as unknown as {
      mirrorConversation(snapshot: unknown): Promise<void>;
    }
  ).mirrorConversation({
    agentId: AGENT_FIXTURE.id,
    channelId: "room-1",
    history: [{ id: "m-1", role: "user", content: "secret", createdAt: 1 }],
    dirty: true,
    version: 1,
  });
  expect(repositoryWrites).toBe(0);

  // A queued alarm firing after the deletion must not rebuild any state.
  await object.alarm();
  expect(data.size).toBe(1);
  expect(data.has("deletion-tombstone")).toBe(true);

  // Deletion stays idempotent under retries from the best-effort purge.
  const retried = await object.fetch(
    new Request("https://shared-runtime.internal/delete", {
      method: "POST",
      body: JSON.stringify({ operation: "delete", agentId: AGENT_FIXTURE.id }),
    }),
  );
  await expect(retried.json()).resolves.toEqual({ success: true });
  expect(data.size).toBe(1);
});

test("delete removes a Postgres mirror that finishes after the caller-side purge", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryDeletes = 0;
  repositoryRow = [];
  let releaseMerge = () => {};
  repositoryMergeGate = new Promise<void>((resolve) => {
    releaseMerge = resolve;
  });
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const state = makeState(data, background);
  const object = new SharedRuntimeConversation(state as never, {} as never);

  const lateMirror = (
    object as unknown as {
      mirrorConversation(snapshot: unknown): Promise<void>;
    }
  ).mirrorConversation({
    agentId: AGENT_FIXTURE.id,
    channelId: "room-1",
    history: [{ id: "m-1", role: "user", content: "secret", createdAt: 1 }],
    dirty: true,
    version: 1,
  });
  await Promise.resolve();

  const deletion = object.fetch(
    new Request("https://shared-runtime.internal/delete", {
      method: "POST",
      body: JSON.stringify({ operation: "delete", agentId: AGENT_FIXTURE.id }),
    }),
  );
  await Promise.resolve();
  releaseMerge();
  await lateMirror;
  const response = await deletion;
  await expect(response.json()).resolves.toEqual({ success: true });

  expect(repositoryWrites).toBe(1);
  expect(repositoryDeletes).toBeGreaterThanOrEqual(1);
  expect(repositoryRow).toEqual([]);
  expect(data.has("deletion-tombstone")).toBe(true);
});

test("concurrent alarm updates preserve both persisted deadlines", async () => {
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const state = makeState(data, background);
  const object = new SharedRuntimeConversation(state as never, {} as never);
  const updateAlarmDeadlines = (
    object as unknown as {
      updateAlarmDeadlines(
        mutate: (current: Record<string, number>) => Record<string, number>,
      ): Promise<void>;
    }
  ).updateAlarmDeadlines.bind(object);

  await Promise.all([
    updateAlarmDeadlines((current) => ({
      ...current,
      mirrorRetryAt: 200,
    })),
    updateAlarmDeadlines((current) => ({
      ...current,
      idleExpiryAt: 300,
    })),
  ]);

  expect(data.get("alarm-deadlines")).toEqual({
    mirrorRetryAt: 200,
    idleExpiryAt: 300,
  });
  expect(state.alarmTime).toBe(200);
});

test("an idle mirror-confirmed room expires by alarm and re-hydrates losslessly", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  const data = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  const state = makeState(data, background);
  const object = new SharedRuntimeConversation(state as never, {} as never);
  const invoke = makeInvoke(object);

  // Cold room: first turn hydrates from the (empty) mirror, second lands.
  expect(await invoke("cold")).toMatchObject({
    code: "conversation_cache_warming",
  });
  await Promise.all(background.splice(0));
  expect(await invoke("turn-1")).toMatchObject({
    result: { historyLength: 1 },
  });
  await Promise.all(background.splice(0));

  // The save armed the idle-expiry deadline on the single DO alarm.
  const deadlines = data.get("alarm-deadlines") as { idleExpiryAt?: number };
  expect(typeof deadlines.idleExpiryAt).toBe("number");
  expect(state.alarmTime).toBe(deadlines.idleExpiryAt ?? null);
  const mirrored = repositoryRow;
  expect((mirrored as unknown[]).length).toBe(1);

  // Fire the alarm past the deadline: the clean snapshot is dropped and the
  // Postgres mirror becomes the sole copy.
  data.set("alarm-deadlines", { idleExpiryAt: Date.now() - 1 });
  await object.alarm();
  expect(data.has("conversation")).toBe(false);
  expect(data.has("alarm-deadlines")).toBe(false);
  expect(state.alarmDeleted).toBe(true);

  // The next request re-hydrates the same history from the mirror.
  expect(await invoke("post-expiry")).toMatchObject({
    code: "conversation_cache_warming",
  });
  await Promise.all(background.splice(0));
  const rehydrated = await invoke("turn-2");
  expect(rehydrated).toMatchObject({ result: { historyLength: 2 } });
  expect(
    (rehydrated as { result: { historyIds: (string | null)[] } }).result
      .historyIds,
  ).toEqual(["message-turn-1"]);
  await Promise.all(background.splice(0));
});

test("an unmirrored snapshot is hard-retained at expiry until the mirror lands", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
  repositoryMergeError = new Error("mirror outage");
  const data = new Map<string, unknown>([
    [
      "conversation",
      {
        agentId: AGENT_FIXTURE.id,
        channelId: "room-1",
        history: [
          { id: "m-1", role: "user", content: "only copy", createdAt: 1 },
        ],
        dirty: true,
        version: 4,
      },
    ],
    ["alarm-deadlines", { idleExpiryAt: Date.now() - 1 }],
  ]);
  const background: Promise<unknown>[] = [];
  const state = makeState(data, background);
  const object = new SharedRuntimeConversation(state as never, {} as never);

  await object.alarm();
  await Promise.all(background.splice(0));

  // The dirty snapshot survives, and both the failed-mirror retry and the
  // re-armed expiry are persisted deadlines on the single alarm.
  expect(data.has("conversation")).toBe(true);
  const retained = data.get("alarm-deadlines") as {
    mirrorRetryAt?: number;
    idleExpiryAt?: number;
  };
  expect(typeof retained.mirrorRetryAt).toBe("number");
  expect(typeof retained.idleExpiryAt).toBe("number");
  expect(state.alarmDeleted).toBe(false);
  expect(state.alarmTime).toBe(
    Math.min(retained.mirrorRetryAt ?? 0, retained.idleExpiryAt ?? 0),
  );

  // Once the mirror recovers, the retried mirror confirms the snapshot and
  // the same alarm's due expiry drops it.
  repositoryMergeError = null;
  data.set("alarm-deadlines", {
    mirrorRetryAt: Date.now() - 1,
    idleExpiryAt: Date.now() - 1,
  });
  await object.alarm();
  await Promise.all(background.splice(0));
  expect(repositoryRow.length).toBe(1);
  expect(data.has("conversation")).toBe(false);
});

test("a stalled stream consumer is fenced and releases the room lock", async () => {
  repositoryReads = 0;
  repositoryWrites = 0;
  repositoryRow = [];
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
  (object as unknown as { streamStallTimeoutMs: number }).streamStallTimeoutMs =
    20;

  const streamed = await object.fetch(
    new Request("https://shared-runtime.internal/stream", {
      method: "POST",
      body: JSON.stringify({
        operation: "stream",
        agent: AGENT_FIXTURE,
        rpc: {
          jsonrpc: "2.0",
          id: "stalled",
          method: "message.send",
          params: { text: "hi", roomId: "room-1" },
        },
      }),
    }),
  );
  // Consume one chunk, then stop pulling entirely without cancelling.
  const reader = streamed.body!.getReader();
  await reader.read();

  // The backstop must cancel the wedged upstream turn and release the room so
  // the next turn can proceed; without it this second turn waits forever.
  const second = await Promise.race([
    makeInvoke(object)("after-stall"),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
  ]);
  expect(second).toMatchObject({ result: {} });
  await Promise.all(background.splice(0));

  // The upstream cancellation persisted the interrupted turn durably.
  const stored = (
    data.get("conversation") as {
      history: Array<{ content: string; interrupted?: boolean }>;
    }
  ).history;
  expect(stored.map((message) => message.content)).toEqual([
    "stream-user-stalled",
    "partial",
    "turn-after-stall",
  ]);
  expect(stored[1]?.interrupted).toBe(true);
});
