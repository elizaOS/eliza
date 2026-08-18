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
let turnCalls = 0;
let lastTurnInput: Record<string, unknown> | undefined;
const turnInputs: Record<string, unknown>[] = [];
let lastStreamTurnInput: Record<string, unknown> | undefined;
let streamTurnCalls = 0;
let admissionError: Error | null;
let billError: Error | null;
let billingGate: Promise<void> | null;
let releaseBilling = () => {};
let streamAbortSignal: AbortSignal | undefined;
let lastTurnRole: "system" | "user" | undefined;
const settleCalls: number[] = [];
let settleUnknownCalls = 0;
const billCalls: unknown[] = [];
let characterReads = 0;
const loggerWarn = mock(() => undefined);

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
    warn: loggerWarn,
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

const admissionSnapshot = {
  balance: { balanceUsd: 10, balanceAt: Date.now(), balanceRevision: 1 },
  rateLimits: {
    completionsRpm: 120,
    embeddingsRpm: 120,
    standardRpm: 120,
    strictRpm: 30,
  },
};
class TestInferenceAdmissionSnapshotCacheWarmingError extends Error {}
const getInferenceAdmissionSnapshotCacheOnly = mock(async () => admissionSnapshot);
mock.module("../inference-admission-snapshot", () => ({
  getInferenceAdmissionSnapshotCacheOnly,
  InferenceAdmissionSnapshotCacheWarmingError: TestInferenceAdmissionSnapshotCacheWarmingError,
  inferenceRateLimitConfig: () => ({ windowMs: 60_000, maxRequests: 120 }),
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
  billFlatUsage: async () => undefined,
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
  sharedTurnProvenance: (input: {
    execution?: {
      authenticatedPersonalSharedUser?: boolean;
      trustedChannel?: { source: string; channelType: string };
    };
    messageRole?: "system" | "user";
  }) => {
    if (input.messageRole === "system") {
      return { source: "shared-runtime-system", channelType: "DM" };
    }
    if (input.execution?.trustedChannel) return input.execution.trustedChannel;
    return {
      source:
        input.execution?.authenticatedPersonalSharedUser === true
          ? "client_chat"
          : "shared-runtime",
      channelType: "DM",
    };
  },
  runSharedAgentTurn: async (input: {
    messageIds?: { user: string; assistant: string };
    messageRole?: "system" | "user";
    [key: string]: unknown;
  }) => {
    turnCalls++;
    lastTurnRole = input.messageRole;
    lastTurnInput = input;
    turnInputs.push(input);
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
  runSharedAgentTurnStream: async (input: {
    abortSignal?: AbortSignal;
    [key: string]: unknown;
  }) => {
    streamTurnCalls++;
    lastStreamTurnInput = input;
    if (streamTurnError) throw streamTurnError;
    streamAbortSignal = input.abortSignal;
    return streamTurn;
  },
}));

const todoStore = { boundary: "canonical-shared-todo-store" };
const expectedTodoScope = {
  agentId: "10000000-0000-5000-8000-000000000001",
  entityId: "10000000-0000-5000-8000-000000000002",
};
const expectedTodoExecution = {
  scope: expectedTodoScope,
  store: todoStore,
};
const expectedTodoActionResult = {
  success: true,
  text: "Created: [ ] Buy milk",
  verifiedUserFacing: true,
  effectReceipts: [
    {
      receiptId: "todos:create:todo-1:receipt-1",
      operation: "todos.create",
      outcome: "applied",
    },
  ],
};
const createSharedTodoStore = mock(() => todoStore);
const sharedTodoStorageScope = mock(
  (_input: { sourceAgentId: string; ownerId: string }) => expectedTodoScope,
);
mock.module("./shared-todos", () => ({
  createSharedTodoStore,
  sharedTodoStorageScope,
}));

type TestMemoryPair = {
  userMessage: string;
  assistantReply: string;
  messageIds?: { user: string; assistant: string };
  messageRole?: "system" | "user";
  source?: string;
  channelType?: string;
  interrupted?: boolean;
};
const memoryPairs: TestMemoryPair[] = [];
const recordTurnPair = mock(async (pair: TestMemoryPair) => {
  memoryPairs.push(pair);
});
const createSharedMemoryStore = mock(() =>
  process.env.SHARED_MEMORY_TABLES_ENABLED === "true" ? { recordTurnPair } : null,
);
mock.module("./shared-memory-store", () => ({
  createSharedMemoryStore,
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
  wrapLanguageModel: ({ model }: { model: unknown }) => model,
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
const { personalSharedAgentId } = await import("./personal-shared-agent");
const { SharedRuntimeChatService } = await import("./shared-runtime-chat");

const organizationId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const agent = {
  id: personalSharedAgentId({ organizationId, userId }),
  organization_id: organizationId,
  user_id: userId,
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
  source?: string;
  channelType?: string;
  createdAt?: number;
  interrupted?: boolean;
};

function harness(initialHistory: TestMessage[] = [{ role: "assistant", content: "prior" }]) {
  let history: TestMessage[] = initialHistory;
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
  turnCalls = 0;
  lastTurnInput = undefined;
  turnInputs.length = 0;
  lastStreamTurnInput = undefined;
  streamTurnCalls = 0;
  characterReads = 0;
  loggerWarn.mockClear();
  enforceOrgRateLimit.mockClear();
  getInferenceAdmissionSnapshotCacheOnly.mockClear();
  admitOrganizationInference.mockClear();
  orgRateLimitResult = null;
  orgRateLimitError = null;
  billingGate = null;
  releaseBilling = () => {};
  streamAbortSignal = undefined;
  createSharedTodoStore.mockClear();
  sharedTodoStorageScope.mockClear();
  delete process.env.SHARED_MEMORY_TABLES_ENABLED;
  memoryPairs.length = 0;
  recordTurnPair.mockClear();
  createSharedMemoryStore.mockClear();
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
  lastTurnRole = undefined;
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

  test("ignores untrusted RPC roles and accepts only the server option", async () => {
    const service = new SharedRuntimeChatService();
    const untrustedRpc = {
      ...rpc,
      params: {
        ...rpc.params,
        messageRole: "system",
        trustedMessageRole: "system",
        execution: {
          messageRole: "system",
          trustedMessageRole: "system",
        },
      },
    };

    await service.bridge(agent, untrustedRpc, harness());
    expect(lastTurnRole).toBe("user");

    await service.bridge(agent, rpc, {
      ...harness(),
      trustedMessageRole: "system",
    });
    expect(lastTurnRole).toBe("system");
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
      config: { windowMs: 60_000, maxRequests: 120 },
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
    // Third background task is the P5 sampled turn-trace write (flag-gated,
    // no-op while SHARED_TURN_TRACES_ENABLED is off, but always scheduled
    // off-path so enabling the flag never changes response ordering).
    expect(h.background).toHaveLength(3);
    expect(settleCalls).toHaveLength(0);
    releaseBilling();
    await Promise.all(h.background);
    expect(billCalls).toHaveLength(1);
    expect((billCalls[0] as unknown[])[2]).toBe(payoutAwareReservation);
    expect(settleCalls).toEqual([0.004]);
  });

  test("platform-funded personal Shared rate-limits without touching account credits", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();

    const response = await service.bridge(agent, rpc, {
      ...h,
      funding: "platform",
    });

    expect(response.result?.text).toBe("hello back");
    expect(enforceOrgRateLimit).toHaveBeenCalledWith(agent.organization_id, "completions", {
      cacheOnly: true,
      executionCtx: h.executionCtx,
      config: { windowMs: 60_000, maxRequests: 60 },
    });
    expect(getInferenceAdmissionSnapshotCacheOnly).not.toHaveBeenCalled();
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(billCalls).toHaveLength(0);
    expect(settleCalls).toHaveLength(0);
    expect(h.history()).toHaveLength(3);
  });

  test("always uses AgentRuntime and only accepts server-owned channel provenance", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    turn.actionResults = [expectedTodoActionResult];
    const hostileRpc = {
      ...rpc,
      params: { ...rpc.params, source: "telegram", channelType: "DM" },
    };

    const response = await service.bridge(agent, hostileRpc, {
      ...h,
      funding: "platform",
      trustedChannel: { source: "discord", channelType: "GROUP" },
    });

    expect(lastTurnInput?.execution).toEqual({
      engine: "eliza-runtime",
      agentKey: agent.id,
      roomKey: expect.any(String),
      authenticatedPersonalSharedUser: true,
      trustedChannel: { source: "discord", channelType: "GROUP" },
      todos: expectedTodoExecution,
    });
    expect(sharedTodoStorageScope).toHaveBeenCalledWith({
      sourceAgentId: agent.id,
      ownerId: agent.user_id,
    });
    expect(response.result?.actionResults).toEqual([expectedTodoActionResult]);
  });

  test("requires the canonical account-derived Personal Shared identity for USER attestation", async () => {
    const service = new SharedRuntimeChatService();
    const forgedAgent = {
      ...agent,
      id: "00000000-0000-4000-8000-000000000099",
    };
    const forgedRpc = {
      ...rpc,
      params: {
        ...rpc.params,
        source: "client_chat",
        authenticatedPersonalSharedUser: true,
        execution: { authenticatedPersonalSharedUser: true },
      },
    };

    await service.bridge(forgedAgent, forgedRpc, {
      ...harness(),
      funding: "platform",
    });

    expect(lastTurnInput?.execution).toEqual({
      engine: "eliza-runtime",
      agentKey: forgedAgent.id,
      roomKey: expect.any(String),
      todos: expectedTodoExecution,
    });
  });

  test("keeps Todo-capable streaming on the same genuine AgentRuntime path", async () => {
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "Created: [ ] Buy milk" };
        yield {
          type: "finish",
          text: "Created: [ ] Buy milk",
          actionResults: [expectedTodoActionResult],
        };
      })(),
    };
    const response = await new SharedRuntimeChatService().stream(agent, rpc, {
      ...harness(),
      funding: "platform",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      JSON.stringify({ actionResults: [expectedTodoActionResult] }).slice(1, -1),
    );
    expect(lastStreamTurnInput?.execution).toEqual({
      engine: "eliza-runtime",
      agentKey: agent.id,
      roomKey: expect.any(String),
      authenticatedPersonalSharedUser: true,
      todos: expectedTodoExecution,
    });
    expect(sharedTodoStorageScope).toHaveBeenCalledWith({
      sourceAgentId: agent.id,
      ownerId: agent.user_id,
    });
  });

  test("streams successful primary effects together with blocked secondary capability results", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    const blockedCommunication = {
      capability: "communications",
      label: "Calls and messages",
      reply: "I can't initiate a separate email.",
    };
    streamTurn = {
      degraded: false,
      blockedSecondaryCapabilities: [blockedCommunication],
      parts: (async function* () {
        yield { type: "text-delta", text: "Created: [ ] Buy milk" };
        yield {
          type: "finish",
          text: "Created: [ ] Buy milk\n\nI can't initiate a separate email.",
          actionResults: [expectedTodoActionResult],
        };
      })(),
    };
    const response = await new SharedRuntimeChatService().stream(agent, rpc, {
      ...harness(),
      funding: "platform",
    });

    const body = await response.text();
    expect(body).toContain(JSON.stringify(expectedTodoActionResult));
    expect(body).toContain('"actionName":"DEDICATED_CAPABILITY_REQUIRED"');
    expect(body).toContain('"capability":"communications"');
    expect(memoryPairs).toEqual([
      expect.objectContaining({
        assistantReply: "Created: [ ] Buy milk\n\nI can't initiate a separate email.",
        interrupted: false,
      }),
    ]);
  });

  test("enables reminders only for platform-funded turns with trusted private delivery", async () => {
    const service = new SharedRuntimeChatService();
    const trustedRpc = {
      ...rpc,
      params: {
        ...rpc.params,
        trustedDelivery: {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456789",
        },
      },
    };

    await service.bridge(agent, trustedRpc, {
      ...harness(),
      funding: "platform",
    });
    expect(lastTurnInput?.execution).toEqual({
      engine: "eliza-runtime",
      agentKey: agent.id,
      roomKey: expect.any(String),
      authenticatedPersonalSharedUser: true,
      todos: expectedTodoExecution,
      reminders: {
        runner: expect.any(Object),
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          chatId: "123456789",
        },
      },
    });

    await service.bridge(agent, trustedRpc, {
      ...harness(),
      funding: "organization-credits",
    });
    expect(lastTurnInput?.execution).toEqual({
      engine: "eliza-runtime",
      agentKey: agent.id,
      roomKey: expect.any(String),
      todos: expectedTodoExecution,
    });

    for (const delivery of [
      {
        platform: "blooio",
        project: "eliza-app",
        phoneNumber: "+15551234567",
      },
      {
        platform: "discord",
        discordUserId: "123456789012345678",
      },
    ] as const) {
      await service.bridge(
        agent,
        {
          ...rpc,
          params: { ...rpc.params, trustedDelivery: delivery },
        },
        {
          ...harness(),
          funding: "platform",
        },
      );
      expect(lastTurnInput?.execution).toMatchObject({
        reminders: { delivery },
      });
    }
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
      config: { windowMs: 60_000, maxRequests: 120 },
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
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    const service = new SharedRuntimeChatService();
    const h = harness();
    const response = await service.stream(agent, rpc, h);
    const body = await response.text();
    expect(body).toContain("event: chunk");
    expect(body).toContain("event: done");
    expect(h.history()).toHaveLength(3);
    expect(memoryPairs).toEqual([
      expect.objectContaining({
        userMessage: "hello",
        assistantReply: "hello back",
        interrupted: false,
      }),
    ]);
    await Promise.all(h.background);
    expect(settleCalls).toEqual([0.004]);
  });

  test("preserves Telegram text provenance when the next turn lands on Discord voice", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    const h = harness([
      {
        id: "telegram-user",
        role: "user",
        content: "sent as Telegram text",
        source: "telegram",
        channelType: "DM",
      },
      {
        id: "telegram-assistant",
        role: "assistant",
        content: "replied as Telegram text",
        source: "telegram",
        channelType: "DM",
      },
    ]);
    const response = await new SharedRuntimeChatService().stream(agent, rpc, {
      ...h,
      trustedChannel: { source: "discord", channelType: "VOICE_GROUP" },
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(h.history().slice(0, 2)).toEqual([
      expect.objectContaining({ source: "telegram", channelType: "DM" }),
      expect.objectContaining({ source: "telegram", channelType: "DM" }),
    ]);
    expect(h.history().slice(-2)).toEqual([
      expect.objectContaining({ source: "discord", channelType: "VOICE_GROUP" }),
      expect.objectContaining({ source: "discord", channelType: "VOICE_GROUP" }),
    ]);
    expect(memoryPairs).toEqual([
      expect.objectContaining({ source: "discord", channelType: "VOICE_GROUP" }),
    ]);
  });

  test("no-model degradation remains a complete canonical SSE turn", async () => {
    streamTurn = {
      degraded: true,
      reply: "Eliza is temporarily unavailable (no shared model configured).",
    };

    const body = await (await new SharedRuntimeChatService().stream(agent, rpc, harness())).text();
    const frames = body
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => {
        const lines = frame.split("\n");
        return {
          event: lines.find((line) => line.startsWith("event: "))?.slice(7),
          data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}"),
        };
      });

    expect(frames.map((frame) => frame.event)).toEqual(["chunk", "done"]);
    expect(frames.map((frame) => frame.data.type)).toEqual(["token", "done"]);
    expect(frames[1]?.data.fullText).toBe(
      "Eliza is temporarily unavailable (no shared model configured).",
    );
    expect(frames[1]?.data.messageId).toBe(frames[0]?.data.messageId);
    expect(frames[1]?.data.userMessageId).toBe(frames[0]?.data.userMessageId);
    expect(settleCalls).toEqual([0]);
  });

  test("every SSE frame carries the canonical JSON type and done carries authoritative fullText (#17122)", async () => {
    const service = new SharedRuntimeChatService();
    const response = await service.stream(agent, rpc, harness());
    const frames = (await response.text())
      .split("\n\n")
      .filter((frame) => frame.trim().length > 0)
      .map((frame) => {
        const lines = frame.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
        const data = JSON.parse(
          lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}",
        ) as Record<string, unknown>;
        return { event, data };
      });
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      expect(frame.event).toBeDefined();
      expect(frame.data.type).toBe(frame.event === "chunk" ? "token" : frame.event);
    }
    const doneData = frames.find((frame) => frame.event === "done")?.data ?? {};
    const fullText = doneData.fullText;
    expect(fullText).toBe(doneData.text);
    expect(typeof fullText === "string" && fullText.length > 0).toBe(true);
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

  test("a keyed cancellation and retry converge history and memory on one stable assistant id", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store: turnClaims } = memoryTurnClaims();
    const keyedCancellationRpc = {
      ...rpc,
      id: "cancel-retry-key",
      params: { ...rpc.params, clientMessageId: "cancel-retry-key" },
    };
    let releaseProviderStream = () => {};
    const providerStreamGate = new Promise<void>((resolve) => {
      releaseProviderStream = resolve;
    });
    let releaseProviderCancellation = () => {};
    const providerCancellationGate = new Promise<void>((resolve) => {
      releaseProviderCancellation = resolve;
    });
    let providerCancelReason: unknown;
    streamTurn = {
      degraded: false,
      cancel: async (reason: unknown) => {
        providerCancelReason = reason;
        await providerCancellationGate;
      },
      parts: (async function* () {
        yield { type: "text-delta", text: "partial " };
        await providerStreamGate;
        yield { type: "text-delta", text: "late" };
        yield {
          type: "finish",
          text: "partial late",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    };

    const response = await service.stream(agent, keyedCancellationRpc, { ...h, turnClaims });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    const cancellation = reader.cancel("barge-in");
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const cancellationOutcome = await Promise.race([
      cancellation.then(() => "persisted" as const),
      new Promise<"stuck_on_provider">((resolve) => {
        guardTimer = setTimeout(() => resolve("stuck_on_provider"), 1_000);
      }),
    ]);
    if (guardTimer !== undefined) clearTimeout(guardTimer);
    expect(cancellationOutcome).toBe("persisted");

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
    const interruptedIds = memoryPairs[0]?.messageIds;
    expect(memoryPairs).toEqual([
      expect.objectContaining({
        userMessage: "hello",
        assistantReply: "partial ",
        interrupted: true,
        messageIds: expect.objectContaining({
          user: expect.any(String),
          assistant: expect.any(String),
        }),
      }),
    ]);

    // Provider teardown remains observed under waitUntil, but it is no longer
    // part of the room-lock release condition. Let both mocked provider tasks
    // finish so the test leaves no pending async work.
    releaseProviderCancellation();
    releaseProviderStream();
    await cancellation;
    await Promise.all(h.background);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.history()).toHaveLength(3);
    expect(h.history().at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      interrupted: true,
    });
    expect(memoryPairs).toEqual([
      expect.objectContaining({
        assistantReply: "partial ",
        interrupted: true,
      }),
    ]);
    expect(settleUnknownCalls).toBe(1);

    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "complete " };
        yield {
          type: "finish",
          text: "complete response",
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      })(),
    };
    const retry = await service.stream(agent, keyedCancellationRpc, { ...h, turnClaims });
    expect(await retry.text()).toContain("complete response");
    await Promise.all(h.background);

    expect(memoryPairs).toHaveLength(2);
    expect(memoryPairs[1]).toMatchObject({
      userMessage: "hello",
      assistantReply: "complete response",
      messageIds: interruptedIds,
    });
    expect(memoryPairs[1]).not.toHaveProperty("interrupted", true);
    expect(h.history().at(-1)).toMatchObject({
      id: interruptedIds?.assistant,
      role: "assistant",
      content: "complete response",
    });
    expect(h.history().at(-1)).not.toHaveProperty("interrupted", true);
  });

  test("stream cancellation observes provider teardown failures off the room-lock path", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    let releaseProviderStream = () => {};
    const providerStreamGate = new Promise<void>((resolve) => {
      releaseProviderStream = resolve;
    });
    streamTurn = {
      degraded: false,
      cancel: async () => {
        releaseProviderStream();
        throw new Error("provider cancel failed");
      },
      parts: (async function* () {
        yield { type: "text-delta", text: "partial " };
        await providerStreamGate;
      })(),
    };

    const response = await service.stream(agent, rpc, h);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("barge-in");
    await Promise.all(h.background);

    expect(h.history().at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      interrupted: true,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[SharedRuntimeChatService] provider stream cancellation did not settle cleanly",
      expect.objectContaining({
        agentId: agent.id,
        outcome: "rejected",
        error: "provider cancel failed",
      }),
    );
  });

  test("stream cancellation reports provider teardown that never settles", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    let releaseProviderStream = () => {};
    const providerStreamGate = new Promise<void>((resolve) => {
      releaseProviderStream = resolve;
    });
    streamTurn = {
      degraded: false,
      cancel: async () => {
        await new Promise<void>(() => undefined);
      },
      parts: (async function* () {
        yield { type: "text-delta", text: "partial " };
        await providerStreamGate;
      })(),
    };

    const response = await service.stream(agent, rpc, h);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("barge-in");
    releaseProviderStream();
    await Promise.all(h.background);

    expect(h.history().at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      interrupted: true,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[SharedRuntimeChatService] provider stream cancellation did not settle cleanly",
      expect.objectContaining({
        agentId: agent.id,
        outcome: "timed_out",
      }),
    );
  }, 10_000);

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

  // ---- durable claim/replay/conflict boundary for clientMessageId (#18045) ----

  type ClaimRecord = { hash: string; result?: Record<string, unknown> };

  function memoryTurnClaims(options: { failCompleteAttempts?: number } = {}) {
    const claims = new Map<string, ClaimRecord>();
    let remainingCompleteFailures = options.failCompleteAttempts ?? 0;
    return {
      claims,
      store: {
        claim: async (key: string, hash: string) => {
          const existing = claims.get(key);
          if (existing) {
            if (existing.hash !== hash) return { state: "conflict" as const };
            if (existing.result) {
              return { state: "replay" as const, result: existing.result as never };
            }
            return { state: "claimed" as const };
          }
          claims.set(key, { hash });
          return { state: "claimed" as const };
        },
        complete: async (key: string, result: Record<string, unknown>) => {
          if (remainingCompleteFailures > 0) {
            remainingCompleteFailures--;
            throw new Error("claim completion failed");
          }
          const existing = claims.get(key);
          if (existing) existing.result = result;
        },
      },
    };
  }

  const keyedRpc = {
    jsonrpc: "2.0" as const,
    id: "client-key-1",
    method: "message.send",
    params: { text: "hello", roomId: "room-1", clientMessageId: "client-key-1" },
  };

  test("an unkeyed client may reuse a JSON-RPC id without reusing durable message identities", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();

    await service.bridge(agent, rpc, h);
    await service.bridge(agent, rpc, h);

    const first = turnInputs[0]?.messageIds as { user: string; assistant: string } | undefined;
    const second = turnInputs[1]?.messageIds as { user: string; assistant: string } | undefined;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toEqual(first);
  });

  test("a replayed clientMessageId admits, dispatches, and bills exactly once (#18045)", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store } = memoryTurnClaims();
    const options = { ...h, turnClaims: store };

    const first = await service.bridge(agent, keyedRpc, options);
    await Promise.all(h.background);
    const historyAfterFirst = h.history().length;
    const second = await service.bridge(agent, keyedRpc, options);
    await Promise.all(h.background);

    expect(turnCalls).toBe(1);
    expect(lastTurnInput?.originClientMessageId).toBe("client-key-1");
    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    expect(billCalls).toHaveLength(1);
    expect(settleCalls).toEqual([0.004]);
    expect(second.result).toEqual(first.result);
    expect(second.id).toBe("client-key-1");
    expect(h.history()).toHaveLength(historyAfterFirst);
  });

  test("a reused clientMessageId with different text is rejected before admission", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store } = memoryTurnClaims();
    const options = { ...h, turnClaims: store };

    await service.bridge(agent, keyedRpc, options);
    await Promise.all(h.background);
    const historyAfterFirst = h.history().length;

    await expect(
      service.bridge(
        agent,
        { ...keyedRpc, params: { ...keyedRpc.params, text: "edited text" } },
        options,
      ),
    ).rejects.toMatchObject({ name: "SharedTurnConflictError" });

    expect(turnCalls).toBe(1);
    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    expect(h.history()).toHaveLength(historyAfterFirst);
  });

  test("a failed keyed turn re-executes under the SAME billing identities", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store } = memoryTurnClaims();
    const options = { ...h, turnClaims: store };

    turnError = new Error("provider connection lost");
    await expect(service.bridge(agent, keyedRpc, options)).rejects.toThrow(
      "provider connection lost",
    );
    await Promise.all(h.background);

    turnError = null;
    const retried = await service.bridge(agent, keyedRpc, options);
    expect(retried.result?.text).toBe("hello back");
    expect(turnCalls).toBe(2);
    expect(admitOrganizationInference).toHaveBeenCalledTimes(2);

    const firstContext = admitOrganizationInference.mock.calls[0]?.[0].context;
    const secondContext = admitOrganizationInference.mock.calls[1]?.[0].context;
    expect(firstContext?.requestId).toBe(secondContext?.requestId);
    expect(firstContext?.metadata?.idempotencyKey).toBe(secondContext?.metadata?.idempotencyKey);
    expect(firstContext?.metadata?.idempotencyKey).toBe(
      `shared-runtime:${agent.id}:${firstContext?.metadata?.channelId}:client-key-1`,
    );
  });

  test("a completed keyed stream turn replays its terminal frames without re-dispatch", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store } = memoryTurnClaims();
    const options = { ...h, turnClaims: store };

    const first = await service.stream(agent, keyedRpc, options);
    expect(first.headers.get("Server-Timing")).toMatch(
      /turn_claim;dur=\d+(?:\.\d+)?, turn_hydrate;dur=\d+(?:\.\d+)?, turn_admission;dur=\d+(?:\.\d+)?, turn_provider_setup;dur=\d+(?:\.\d+)?/,
    );
    const firstBody = await first.text();
    await Promise.all(h.background);
    const second = await service.stream(agent, keyedRpc, options);
    expect(second.headers.get("Server-Timing")).toMatch(/^turn_claim;dur=\d+(?:\.\d+)?$/);
    const secondBody = await second.text();

    expect(streamTurnCalls).toBe(1);
    expect(lastStreamTurnInput?.originClientMessageId).toBe("client-key-1");
    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    const doneFrame = (body: string) => {
      const match = body.match(/event: done\ndata: (.*)\n/);
      expect(match).toBeTruthy();
      return JSON.parse(match![1]) as Record<string, unknown>;
    };
    const firstDone = doneFrame(firstBody);
    const secondDone = doneFrame(secondBody);
    expect(secondDone.fullText).toBe("hello back");
    expect(secondDone.messageId).toBe(firstDone.messageId);
    expect(secondDone.userMessageId).toBe(firstDone.userMessageId);
  });

  test("claim completion failure retries to one canonical history, memory, and replay result", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store } = memoryTurnClaims({ failCompleteAttempts: 1 });
    const options = { ...h, turnClaims: store };

    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "first " };
        yield {
          type: "finish",
          text: "first completed reply",
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      })(),
    };
    const first = await service.stream(agent, keyedRpc, options);
    expect(await first.text()).toContain("Shared runtime stream failed");
    expect(memoryPairs.length).toBeGreaterThanOrEqual(1);
    const firstAttemptPairCount = memoryPairs.length;
    const stableIds = memoryPairs[0]?.messageIds;
    expect(memoryPairs[0]).toMatchObject({
      assistantReply: "first completed reply",
      messageIds: stableIds,
    });
    for (const pair of memoryPairs) {
      expect(pair).toMatchObject({
        messageIds: stableIds,
      });
    }
    expect(h.history().at(-1)).toMatchObject({
      id: stableIds?.assistant,
    });

    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "retry " };
        yield {
          type: "finish",
          text: "retry terminal reply",
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      })(),
    };
    const retry = await service.stream(agent, keyedRpc, options);
    const retryBody = await retry.text();
    expect(retryBody).toContain("retry terminal reply");
    expect(memoryPairs.length).toBeGreaterThan(firstAttemptPairCount);
    const retryPairs = memoryPairs.slice(firstAttemptPairCount);
    expect(retryPairs).toContainEqual(
      expect.objectContaining({
        assistantReply: "retry terminal reply",
        messageIds: stableIds,
      }),
    );
    for (const pair of retryPairs) {
      expect(pair).toMatchObject({
        messageIds: stableIds,
      });
    }
    expect(h.history().at(-1)).toMatchObject({
      id: stableIds?.assistant,
      content: "retry terminal reply",
    });

    const pairCountAfterRetry = memoryPairs.length;
    const replay = await service.stream(agent, keyedRpc, options);
    expect(await replay.text()).toContain("retry terminal reply");
    expect(streamTurnCalls).toBe(2);
    expect(memoryPairs).toHaveLength(pairCountAfterRetry);
  });
});
