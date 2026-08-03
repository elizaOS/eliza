/**
 * Covers the cache-only shared chat engine across response and SSE boundaries.
 *
 * Real history-store and waitUntil contracts are used; only model and money
 * providers are deterministic seams.
 */

process.env.MOCK_REDIS = "1";

import { beforeEach, describe, expect, mock, test } from "bun:test";

let turn: Record<string, unknown>;
let streamTurn: Record<string, unknown>;
let turnError: Error | null;
let streamTurnError: Error | null;
let admissionError: Error | null;
let billError: Error | null;
let billingGate: Promise<void> | null;
let releaseBilling = () => {};
let streamAbortSignal: AbortSignal | undefined;
const settleCalls: number[] = [];
let settleUnknownCalls = 0;
const billCalls: unknown[] = [];
let characterReads = 0;

class ApiInsufficientCreditsError extends Error {}

class ApiRateLimitError extends Error {
  retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

mock.module("../../api/errors", () => ({
  InsufficientCreditsError: ApiInsufficientCreditsError,
  RateLimitError: ApiRateLimitError,
}));

mock.module("../../pricing", () => ({
  getProviderFromModel: () => "openai",
}));

mock.module("../../utils/logger", () => ({
  logger: {
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const payoutAwareReservation = {
  reservedAmount: 0.01,
  reservationTransactionId: "reservation-1",
  affiliateAttribution: {
    affiliateCodeId: "00000000-0000-4000-8000-000000000010",
    affiliateUserId: "00000000-0000-4000-8000-000000000011",
    affiliateCode: "PARTNER",
    markupPercent: 0.2,
  },
  affiliatePayoutSourceId: "ai_billing:affiliate:shared-runtime-test",
  reconcile: async () => undefined,
};

class TestOrgRateLimitCacheNotReadyError extends Error {}
let orgRateLimitResult: Response | null = null;
let orgRateLimitError: Error | null = null;
const enforceOrgRateLimit = mock(async () => {
  if (orgRateLimitError) throw orgRateLimitError;
  return orgRateLimitResult;
});
mock.module("../../middleware/rate-limit", () => ({
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError: TestOrgRateLimitCacheNotReadyError,
}));

const admitOrganizationInference = mock(
  async (params: {
    context?: { metadata?: Record<string, unknown> };
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  }) => {
    if (admissionError) throw admissionError;
    params.executionCtx?.waitUntil(Promise.resolve());
    return {
      mode: "deferred_kv_ledger",
      settle: async (cost: number) => {
        settleCalls.push(cost);
        return null;
      },
      settleUnknown: async () => {
        settleUnknownCalls++;
        return null;
      },
      reservation: payoutAwareReservation,
    };
  },
);
mock.module("../organization-inference-admission", () => ({
  admitOrganizationInference,
}));
mock.module("../ai-billing", () => ({
  estimateInputTokens: () => 12,
  reserveCredits: async () => {
    throw new Error("synchronous reserve must not run");
  },
  billUsage: async (...args: unknown[]) => {
    billCalls.push(args);
    if (billingGate) await billingGate;
    if (billError) throw billError;
    return { totalCost: 0.004, inputTokens: 12, outputTokens: 4 };
  },
  recordUsageAnalytics: async () => null,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    required = 1;
    available = 0;
  },
}));
mock.module("../ai-billing-records", () => ({
  aiBillingRecordsService: { record: async () => undefined },
}));
mock.module("../../../db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganization: async (id: string) => {
      characterReads++;
      return {
        id,
        organization_id: agent.organization_id,
        name: "Cached Nova",
        system: "Be cached.",
      };
    },
  },
}));
mock.module("./run-shared-agent-turn", () => ({
  resolveSharedAgentTurnModel: () => "openai/gpt-oss-120b",
  runSharedAgentTurn: async (input: { messageIds?: { user: string; assistant: string } }) => {
    if (turnError) throw turnError;
    const history = Array.isArray(turn.history)
      ? turn.history.map((message, index) =>
          index === turn.history.length - 2
            ? { ...message, id: input.messageIds?.user }
            : index === turn.history.length - 1
              ? { ...message, id: input.messageIds?.assistant }
              : message,
        )
      : turn.history;
    return { ...turn, history };
  },
  runSharedAgentTurnStream: async (input: { abortSignal?: AbortSignal }) => {
    if (streamTurnError) throw streamTurnError;
    streamAbortSignal = input.abortSignal;
    return streamTurn;
  },
}));

class TestInferenceAdmissionDispatchMarkError extends Error {}

mock.module("../inference-admission-gate", () => ({
  InferenceAdmissionDispatchMarkError: TestInferenceAdmissionDispatchMarkError,
  isInferenceAdmissionDispatchMarkError: (error: unknown) =>
    error instanceof TestInferenceAdmissionDispatchMarkError ||
    (error as { cause?: unknown })?.cause instanceof TestInferenceAdmissionDispatchMarkError,
}));

mock.module("../inference-billing-fast-path", () => ({
  InferenceBalanceCacheWarmingError: class InferenceBalanceCacheWarmingError extends Error {},
}));

class MockAPICallError extends Error {
  statusCode?: number;

  constructor(options: { message: string; statusCode?: number }) {
    super(options.message);
    this.statusCode = options.statusCode;
  }

  static isInstance(value: unknown): value is MockAPICallError {
    return value instanceof MockAPICallError;
  }
}

class MockRetryError extends Error {
  lastError?: unknown;

  static isInstance(value: unknown): value is MockRetryError {
    return value instanceof MockRetryError;
  }
}

mock.module("ai", () => ({
  APICallError: MockAPICallError,
  RetryError: MockRetryError,
}));

// Sibling suites in the same bun process mock ../../cache/client globally with
// partial doubles (server-wallets-provision-proof exposes only setIfNotExists;
// resolve-shared-agent substitutes its own get/set), and bun's mock.module
// patches the process-wide registry — so batch composition decided whether the
// character-hydration get/set flow here saw a working cache. Pin this suite's
// own Map-backed double instead. It cannot be built from the real module: a
// sibling that loaded first has already replaced the registry entry, so an
// import here returns that sibling's partial mock, not the real exports.
const localCacheStore = new Map<string, unknown>();
mock.module("../../cache/client", () => ({
  NEGATIVE_CACHE_SENTINEL: { __none: true },
  cache: {
    isAvailable: () => true,
    get: async (key: string) => (localCacheStore.has(key) ? localCacheStore.get(key) : null),
    set: async (key: string, value: unknown) => {
      localCacheStore.set(key, value);
      return { ok: true };
    },
    getOrSet: async (key: string, compute: () => Promise<unknown>) => {
      if (localCacheStore.has(key)) return localCacheStore.get(key);
      const value = await compute();
      localCacheStore.set(key, value);
      return value;
    },
    setIfNotExists: async (key: string) => {
      if (localCacheStore.has(key)) return false;
      localCacheStore.set(key, "1");
      return true;
    },
  },
}));

const { InsufficientCreditsError } = await import("../ai-billing");
const { InferenceAdmissionDispatchMarkError } = await import("../inference-admission-gate");
const { SharedRuntimeChatService } = await import("./shared-runtime-chat");

const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  user_id: "00000000-0000-4000-8000-000000000003",
  execution_tier: "shared",
  agent_name: "Nova",
  character_id: null,
  agent_config: {
    character: {
      name: "Nova",
      system: "Be useful.",
      model: "openai/gpt-oss-120b",
    },
  },
} as never;
const rpc = {
  jsonrpc: "2.0" as const,
  id: "turn-1",
  method: "message.send",
  params: { text: "hello", roomId: "room-1" },
};

type TestMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  interrupted?: boolean;
};

function harness() {
  let history: TestMessage[] = [{ role: "assistant", content: "prior" }];
  const background: Promise<unknown>[] = [];
  const merge = (messages: TestMessage[]): TestMessage[] => {
    const byId = new Map<string, TestMessage>();
    for (const message of [...history, ...messages]) {
      byId.set(
        "id" in message && typeof message.id === "string"
          ? message.id
          : `${message.role}\u0000${"createdAt" in message ? message.createdAt : ""}\u0000${message.content}`,
        message,
      );
    }
    history = [...byId.values()];
    return history;
  };
  return {
    background,
    historyStore: {
      load: async () => history,
      save: async (_agentId: string, _channelId: string, next: TestMessage[]) => {
        history = next;
      },
      merge: async (_agentId: string, _channelId: string, messages: TestMessage[]) =>
        merge(messages),
    },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    },
    history: () => history,
  };
}

beforeEach(() => {
  settleCalls.length = 0;
  settleUnknownCalls = 0;
  billCalls.length = 0;
  admissionError = null;
  billError = null;
  turnError = null;
  streamTurnError = null;
  characterReads = 0;
  enforceOrgRateLimit.mockClear();
  admitOrganizationInference.mockClear();
  orgRateLimitResult = null;
  orgRateLimitError = null;
  billingGate = null;
  releaseBilling = () => {};
  streamAbortSignal = undefined;
  turn = {
    degraded: false,
    reply: "hello back",
    history: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hello back" },
    ],
    model: "openai/gpt-oss-120b",
  };
  streamTurn = {
    degraded: false,
    parts: (async function* () {
      yield { type: "text-delta", text: "hello " };
      yield {
        type: "finish",
        text: "hello back",
        usage: { inputTokens: 12, outputTokens: 4 },
      };
    })(),
  };
});

function wrappedProviderError(statusCode: number): Error {
  return new Error("shared turn failed", {
    cause: new MockAPICallError({
      message: `provider returned ${statusCode}`,
      url: "https://provider.example/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
    }),
  });
}

describe("SharedRuntimeChatService", () => {
  test("handles status, unknown methods, and invalid message input", async () => {
    const service = new SharedRuntimeChatService();
    expect((await service.bridge(agent, { ...rpc, method: "heartbeat" })).result).toMatchObject({
      ready: true,
      runtime: "shared",
    });
    expect((await service.bridge(agent, { ...rpc, method: "unknown" })).error?.code).toBe(-32601);
    expect(
      (
        await service.bridge(agent, {
          ...rpc,
          params: { text: " " },
        })
      ).error?.code,
    ).toBe(-32602);
  });

  test("returns before billing and persists ordered cache-local history", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    billingGate = new Promise((resolve) => {
      releaseBilling = resolve;
    });
    const response = await service.bridge(agent, rpc, h);
    expect(response.result?.text).toBe("hello back");
    expect(enforceOrgRateLimit).toHaveBeenCalledWith(agent.organization_id, "completions", {
      cacheOnly: true,
      executionCtx: h.executionCtx,
    });
    const admissionContext = admitOrganizationInference.mock.calls[0]?.[0].context;
    expect(admissionContext?.metadata).toMatchObject({
      agentId: agent.id,
      channelId: expect.any(String),
      runtime: "shared",
    });
    expect(admissionContext?.metadata).not.toHaveProperty("prompt");
    expect(JSON.stringify(admissionContext)).not.toContain("hello");
    expect(h.history()).toHaveLength(3);
    expect(h.background).toHaveLength(2);
    expect(settleCalls).toHaveLength(0);
    releaseBilling();
    await Promise.all(h.background);
    expect(billCalls).toHaveLength(1);
    expect((billCalls[0] as unknown[])[2]).toBe(payoutAwareReservation);
    expect(settleCalls).toEqual([0.004]);
  });

  test("rate denial and policy warming stop before billing admission or provider dispatch", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    orgRateLimitResult = Response.json(
      { error: "Too many requests", code: "rate_limit_exceeded" },
      { status: 429, headers: { "Retry-After": "31" } },
    );

    await expect(service.bridge(agent, rpc, h)).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfter: 31,
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(settleCalls).toEqual([]);

    enforceOrgRateLimit.mockClear();
    orgRateLimitResult = null;
    orgRateLimitError = new TestOrgRateLimitCacheNotReadyError("warming");
    await expect(service.bridge(agent, rpc, h)).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
    expect(enforceOrgRateLimit).toHaveBeenCalledWith(agent.organization_id, "completions", {
      cacheOnly: true,
      executionCtx: h.executionCtx,
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
  });

  test("cold linked character returns warming while hydration stays off path", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const linkedAgent = {
      ...agent,
      character_id: "00000000-0000-4000-8000-000000000099",
    };

    await expect(service.bridge(linkedAgent, rpc, h)).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
    expect(characterReads).toBe(1);
    await Promise.all(h.background.splice(0));

    expect((await service.bridge(linkedAgent, rpc, h)).result?.text).toBe("hello back");
    expect(characterReads).toBe(1);
  });

  test("cache-only character miss requires waitUntil before repository hydration", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const linkedAgent = {
      ...agent,
      character_id: "00000000-0000-4000-8000-000000000098",
    };

    await expect(
      service.bridge(linkedAgent, rpc, { historyStore: h.historyStore }),
    ).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
      message: "Character cache context is unavailable. Retry shortly.",
    });
    expect(characterReads).toBe(0);
    expect(h.background).toHaveLength(0);
  });

  test("degraded turns release zero while ambiguous post-dispatch failures retain the estimate", async () => {
    const service = new SharedRuntimeChatService();
    turn = {
      degraded: true,
      reply: "fallback",
      history: [],
      model: "openai/gpt-oss-120b",
    };
    expect((await service.bridge(agent, rpc, harness())).result?.degraded).toBe(true);
    expect(settleCalls).toEqual([0]);

    turn = {
      degraded: false,
      reply: "unused",
      get history() {
        throw new Error("turn failed");
      },
    };
    await expect(service.bridge(agent, rpc, harness())).rejects.toThrow("turn failed");
    expect(settleUnknownCalls).toBe(1);
  });

  test("settles zero for pre-provider failures and retains ambiguous provider failures", async () => {
    const service = new SharedRuntimeChatService();
    turnError = new Error("shared turn failed", {
      cause: new InferenceAdmissionDispatchMarkError("dispatch acknowledgement remained ambiguous"),
    });
    await expect(service.bridge(agent, rpc, harness())).rejects.toThrow("shared turn failed");
    expect(settleCalls).toEqual([0]);
    expect(settleUnknownCalls).toBe(0);

    settleCalls.length = 0;
    turnError = wrappedProviderError(422);
    await expect(service.bridge(agent, rpc, harness())).rejects.toThrow("shared turn failed");
    expect(settleCalls).toEqual([0]);
    expect(settleUnknownCalls).toBe(0);

    settleCalls.length = 0;
    turnError = wrappedProviderError(503);
    await expect(service.bridge(agent, rpc, harness())).rejects.toThrow("shared turn failed");
    expect(settleCalls).toEqual([]);
    expect(settleUnknownCalls).toBe(1);
  });

  test("billing failure after a delivered reply conservatively settles unknown usage", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    billError = new Error("meter unavailable");
    await service.bridge(agent, rpc, h);
    await Promise.all(h.background);
    expect(settleCalls).toEqual([]);
    expect(settleUnknownCalls).toBe(1);
  });

  test("translates insufficient admission to the bridge credit code", async () => {
    const service = new SharedRuntimeChatService();
    admissionError = new InsufficientCreditsError("no credits");
    expect((await service.bridge(agent, rpc, harness())).error?.code).toBe(-32002);
  });

  test("streams chunks, persists the completed turn, and bills off path", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const response = await service.stream(agent, rpc, h);
    const body = await response.text();
    expect(body).toContain("event: chunk");
    expect(body).toContain("event: done");
    expect(h.history()).toHaveLength(3);
    await Promise.all(h.background);
    expect(settleCalls).toEqual([0.004]);
  });

  test("stream error and no-parts paths conservatively settle unknown usage", async () => {
    const service = new SharedRuntimeChatService();
    streamTurn = { degraded: false };
    expect(await (await service.stream(agent, rpc, harness())).text()).toContain("did not start");
    expect(settleCalls).toEqual([]);
    expect(settleUnknownCalls).toBe(1);

    settleCalls.length = 0;
    settleUnknownCalls = 0;
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield await Promise.reject(new Error("provider disconnected"));
      })(),
    };
    expect(await (await service.stream(agent, rpc, harness())).text()).toContain(
      "Shared runtime stream failed",
    );
    expect(settleCalls).toEqual([]);
    expect(settleUnknownCalls).toBe(1);
  });

  test("stream refunds a pre-output rejection but not a rejection after bytes", async () => {
    const service = new SharedRuntimeChatService();
    streamTurnError = wrappedProviderError(400);
    await expect(service.stream(agent, rpc, harness())).rejects.toThrow("shared turn failed");
    expect(settleCalls).toEqual([0]);
    expect(settleUnknownCalls).toBe(0);

    settleCalls.length = 0;
    streamTurnError = null;
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "partial" };
        throw wrappedProviderError(400);
      })(),
    };
    expect(await (await service.stream(agent, rpc, harness())).text()).toContain(
      "Shared runtime stream failed",
    );
    expect(settleCalls).toEqual([]);
    expect(settleUnknownCalls).toBe(1);
  });

  test("stream response-body cancellation awaits interrupted history persistence", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    let releaseProvider = () => {};
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerCancelReason: unknown;
    streamTurn = {
      degraded: false,
      cancel: async (reason: unknown) => {
        providerCancelReason = reason;
        releaseProvider();
      },
      parts: (async function* () {
        yield { type: "text-delta", text: "partial " };
        await providerGate;
      })(),
    };

    const response = await service.stream(agent, rpc, h);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    await reader.cancel("barge-in");

    expect(h.history()).toHaveLength(3);
    expect(h.history()[1]).toMatchObject({
      id: expect.any(String),
      role: "user",
      content: "hello",
    });
    expect(h.history()[2]).toMatchObject({
      id: expect.any(String),
      role: "assistant",
      content: "partial",
      interrupted: true,
    });
    expect(streamAbortSignal?.aborted).toBe(true);
    expect(streamAbortSignal?.reason).toBe("barge-in");
    expect(providerCancelReason).toBe("barge-in");
    expect(settleUnknownCalls).toBe(1);
  });

  test("stream finalization retries after a failed history write", async () => {
    const service = new SharedRuntimeChatService();
    let attempts = 0;
    let history: TestMessage[] = [{ role: "assistant", content: "prior" }];
    const h = {
      background: [] as Promise<unknown>[],
      historyStore: {
        load: async () => history,
        save: async (_agentId: string, _channelId: string, next: TestMessage[]) => {
          history = next;
        },
        merge: async (_agentId: string, _channelId: string, messages: TestMessage[]) => {
          attempts++;
          if (attempts === 1) throw new Error("durable put failed");
          history = [...history, ...messages];
          return history;
        },
      },
      executionCtx: {
        waitUntil: (promise: Promise<unknown>) => h.background.push(promise),
      },
    };
    let releaseProvider = () => {};
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await providerGate;
        yield { type: "finish", text: "final", usage: { inputTokens: 1, outputTokens: 1 } };
      })(),
    };

    const response = await service.stream(agent, rpc, h);
    const reader = response.body!.getReader();
    await reader.read();
    await expect(reader.cancel("first cancel")).rejects.toThrow("durable put failed");
    expect(history).toHaveLength(1);

    releaseProvider();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(h.background);

    expect(attempts).toBe(2);
    expect(history.at(-2)).toMatchObject({ role: "user", content: "hello" });
    expect(history.at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      interrupted: true,
    });
    expect(settleUnknownCalls).toBe(1);
  });
});
