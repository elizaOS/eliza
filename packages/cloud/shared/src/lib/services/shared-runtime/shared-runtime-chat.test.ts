/**
 * Covers the cache-only shared chat engine across response and SSE boundaries.
 *
 * Real history-store and waitUntil contracts are used; model, money, and the
 * durable trace repository are deterministic seams.
 */

process.env.MOCK_REDIS = "1";

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ChannelType, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core/edge";

let turn: Record<string, unknown>;
let streamTurn: Record<string, unknown>;
let turnError: Error | null;
let streamTurnError: Error | null;
let streamTurnSetupGate: Promise<void> | null;
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
let turnTimingOutcome: "success" | "error" | null = null;
let streamTimingOutcome: "success" | "error" | null = null;
let onTurnDispatch: (() => void) | null = null;
const settleCalls: number[] = [];
let settleUnknownCalls = 0;
const billCalls: unknown[] = [];
const tokenEstimateInputs: Array<Array<{ content: string }>> = [];
const streamTurnInputs: Array<Record<string, unknown>> = [];
const estimateInputTokens = mock((messages: Array<{ content: string }>) => {
  tokenEstimateInputs.push(messages);
  return 12;
});
let characterReads = 0;
const loggerWarn = mock(() => undefined);
const traceRows: Array<Record<string, unknown>> = [];
const insertTrace = mock(async (row: Record<string, unknown>) => {
  traceRows.push(row);
});

mock.module("../../../db/repositories/shared-turn-traces", () => ({
  sharedTurnTracesRepository: { insertTrace },
}));

function timingReceipt(
  outcome: "success" | "error" | "aborted",
  completedOffsetMs: number | null = 125,
) {
  return {
    traceId: `trace-${outcome}`,
    outcome,
    historyMessageCount: 1,
    phases: {
      edgeContextDurationMs: 1,
      runtimeInitializeDurationMs: 2,
      connectionDurationMs: 3,
      historyProjectionDurationMs: 4,
    },
    offsets: {
      providerDispatchOffsetMs: 5,
      providerFirstTextOffsetMs: outcome === "success" ? 6 : null,
      completedOffsetMs,
    },
    inference: {
      composeStateDurationMs: 7,
      shouldRespondAndContextDurationMs: 8,
      responseHandlerFieldsDurationMs: 9,
      providerTotalDurationMs: 10,
      slowestProviderDurationMs: 10,
    },
    model: {
      replayed: false,
      durationMs: 0,
      callCount: 0,
      fallbackCount: 0,
      selectedProvider: "none" as const,
      callsTruncated: false,
      calls: [],
    },
    routing: { decision: "respond" as const, contextIds: ["room"] },
  };
}

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
    estimatedInputTokens?: number;
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
  estimateInputTokens,
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
  runSharedAgentTurn: async (input: {
    memory?: { recordTurnPair(pair: TestMemoryPair): Promise<void> };
    message?: string;
    messageIds?: { user: string; assistant: string };
    messageRole?: "system" | "user";
    onRuntimeTiming?: (receipt: ReturnType<typeof timingReceipt>) => void;
    execution?: { channel?: { type: ChannelType; source: string } };
    [key: string]: unknown;
  }) => {
    turnCalls++;
    lastTurnRole = input.messageRole;
    lastTurnInput = input;
    turnInputs.push(input);
    onTurnDispatch?.();
    if (turnTimingOutcome) input.onRuntimeTiming?.(timingReceipt(turnTimingOutcome, null));
    if (turnError) throw turnError;
    const history = Array.isArray(turn.history)
      ? turn.history.map((message, index) =>
          turn.responded === false && index === turn.history.length - 1
            ? { ...message, id: input.messageIds?.user }
            : index === turn.history.length - 2
              ? { ...message, id: input.messageIds?.user }
              : index === turn.history.length - 1
                ? { ...message, id: input.messageIds?.assistant }
                : message,
        )
      : turn.history;
    if (input.memory && !turn.degraded) {
      await input.memory.recordTurnPair({
        userMessage: input.message?.trim() ?? "",
        assistantReply: typeof turn.reply === "string" ? turn.reply : "",
        ...(input.messageIds ? { messageIds: input.messageIds } : {}),
        ...(input.messageRole ? { messageRole: input.messageRole } : {}),
        ...(input.execution?.channel ? { channel: input.execution.channel } : {}),
      });
    }
    return { ...turn, history };
  },
  runSharedAgentTurnStream: async (input: {
    abortSignal?: AbortSignal;
    onRuntimeTiming?: (receipt: ReturnType<typeof timingReceipt>) => void;
    [key: string]: unknown;
  }) => {
    streamTurnCalls++;
    lastStreamTurnInput = input;
    streamTurnInputs.push(input);
    if (streamTurnError) throw streamTurnError;
    streamAbortSignal = input.abortSignal;
    if (streamTurnSetupGate) await streamTurnSetupGate;
    if (streamTimingOutcome) input.onRuntimeTiming?.(timingReceipt(streamTimingOutcome));
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
  text: 'Added "Buy milk" to your list.',
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
  interrupted?: boolean;
  channel?: { type: ChannelType; source: string };
};
const memoryPairs: TestMemoryPair[] = [];
const memoryScopes: Array<{ agentKey: string; roomKey: string }> = [];
let sharedMemoryStoreOverride: Record<string, unknown> | null | undefined;
const recordTurnPair = mock(async (pair: TestMemoryPair) => {
  memoryPairs.push(pair);
});
const createSharedMemoryStore = mock((scope: { agentKey: string; roomKey: string }) => {
  memoryScopes.push(scope);
  if (sharedMemoryStoreOverride !== undefined) return sharedMemoryStoreOverride;
  return process.env.SHARED_MEMORY_TABLES_ENABLED === "true" ? { recordTurnPair } : null;
});
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
const { SharedRuntimeChatService, sharedRuntimeChannelId } = await import("./shared-runtime-chat");

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
  createdAt?: number;
  interrupted?: boolean;
  grounding?:
    | {
        kind: "web_search";
        query: string;
        provider: "parallel" | "exa";
        text: string;
        observedAt: number;
        sourceUrls?: string[];
        sources?: Array<{ url: string; text: string }>;
        truncated: boolean;
      }
    | {
        kind: "web_search_unavailable";
        query: string;
        observedAt: number;
      };
};

function harness(initialHistory?: TestMessage[]) {
  let history: TestMessage[] = initialHistory ?? [{ role: "assistant", content: "prior" }];
  let staged: TestMessage[] = [];
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
      stagePending: (_agentId: string, _channelId: string, messages: TestMessage[]) => {
        staged = messages;
      },
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
    staged: () => staged,
  };
}

beforeEach(() => {
  settleCalls.length = 0;
  settleUnknownCalls = 0;
  billCalls.length = 0;
  tokenEstimateInputs.length = 0;
  streamTurnInputs.length = 0;
  estimateInputTokens.mockClear();
  admissionError = null;
  billError = null;
  turnError = null;
  streamTurnError = null;
  streamTurnSetupGate = null;
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
  turnTimingOutcome = null;
  streamTimingOutcome = null;
  onTurnDispatch = null;
  traceRows.length = 0;
  insertTrace.mockClear();
  delete process.env.SHARED_TURN_TRACES_ENABLED;
  delete process.env.SHARED_TURN_TRACES_SAMPLE;
  createSharedTodoStore.mockClear();
  sharedTodoStorageScope.mockClear();
  delete process.env.SHARED_MEMORY_TABLES_ENABLED;
  delete process.env.SHARED_FACTS_ENABLED;
  sharedMemoryStoreOverride = undefined;
  memoryPairs.length = 0;
  memoryScopes.length = 0;
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

  test("samples success, error, and abort terminal receipts exactly once without content", async () => {
    process.env.SHARED_TURN_TRACES_ENABLED = "true";
    process.env.SHARED_TURN_TRACES_SAMPLE = "1";
    let nowMs = 10_000;
    const now = spyOn(Date, "now").mockImplementation(() => nowMs);
    const assertOnlyReceipt = (outcome: "success" | "error" | "aborted") => {
      expect(insertTrace).toHaveBeenCalledTimes(1);
      expect(traceRows).toHaveLength(1);
      const row = traceRows[0] as {
        latency_ms: number;
        stages: { terminalTiming?: { outcome?: string } };
      };
      expect(row.stages.terminalTiming?.outcome).toBe(outcome);
      expect(JSON.stringify(row)).not.toContain("hello");
      return row;
    };

    try {
      turnTimingOutcome = "success";
      const successHarness = harness();
      await new SharedRuntimeChatService().bridge(agent, rpc, successHarness);
      await Promise.all(successHarness.background);
      assertOnlyReceipt("success");

      traceRows.length = 0;
      insertTrace.mockClear();
      turnTimingOutcome = "error";
      turnError = wrappedProviderError(503);
      onTurnDispatch = () => {
        nowMs += 137;
      };
      const errorHarness = harness();
      await expect(new SharedRuntimeChatService().bridge(agent, rpc, errorHarness)).rejects.toThrow(
        "shared turn failed",
      );
      await Promise.all(errorHarness.background);
      expect(assertOnlyReceipt("error").latency_ms).toBe(137);

      traceRows.length = 0;
      insertTrace.mockClear();
      turnTimingOutcome = null;
      turnError = null;
      onTurnDispatch = null;
      let releaseStream = () => {};
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      streamTurn = {
        degraded: false,
        cancel: async () => {
          const emitTiming = lastStreamTurnInput?.onRuntimeTiming as
            | ((receipt: ReturnType<typeof timingReceipt>) => void)
            | undefined;
          emitTiming?.(timingReceipt("aborted"));
          releaseStream();
        },
        parts: (async function* () {
          yield { type: "text-delta", text: "partial" };
          await streamGate;
        })(),
      };
      const abortHarness = harness();
      const response = await new SharedRuntimeChatService().stream(agent, rpc, abortHarness);
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel("test abort");
      await Promise.all(abortHarness.background);
      assertOnlyReceipt("aborted");
    } finally {
      now.mockRestore();
    }
  });

  test("retains complete content-free history provenance for a voice turn at zero sample", async () => {
    process.env.SHARED_TURN_TRACES_ENABLED = "true";
    process.env.SHARED_TURN_TRACES_SAMPLE = "0";
    const priorContent = "private prior sentence that must never enter diagnostics";
    const h = harness([
      {
        id: "prior-user-id",
        role: "user",
        content: priorContent,
        createdAt: 1_787_860_800_000,
      },
      {
        id: "prior-assistant-id",
        role: "assistant",
        content: "private partial reply",
        createdAt: 1_787_860_800_500,
        interrupted: true,
      },
    ]);
    await new SharedRuntimeChatService().bridge(agent, rpc, {
      ...h,
      channel: {
        type: ChannelType.VOICE_DM,
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      },
    });
    await Promise.all(h.background);

    expect(traceRows).toHaveLength(1);
    const row = traceRows[0] as {
      channel_id: string;
      stages: {
        historyProvenance?: {
          channelId: string;
          channelType: string;
          channelSource: string;
          messages: Array<Record<string, unknown>>;
        };
      };
    };
    expect(row.stages.historyProvenance).toEqual({
      channelId: row.channel_id,
      channelType: String(ChannelType.VOICE_DM),
      channelSource: String(MESSAGE_SOURCE_CLIENT_CHAT),
      messages: [
        {
          id: "prior-user-id",
          role: "user",
          createdAt: 1_787_860_800_000,
          interrupted: false,
        },
        {
          id: "prior-assistant-id",
          role: "assistant",
          createdAt: 1_787_860_800_500,
          interrupted: true,
        },
      ],
    });
    expect(JSON.stringify(row)).not.toContain(priorContent);
    expect(JSON.stringify(row)).not.toContain("private partial reply");
  });

  test("retains a voice failure that occurs before the runtime emits terminal timing", async () => {
    process.env.SHARED_TURN_TRACES_ENABLED = "true";
    process.env.SHARED_TURN_TRACES_SAMPLE = "0";
    turnTimingOutcome = null;
    turnError = new Error("provider failed before timing receipt");
    const h = harness([
      {
        id: "failed-turn-user-id",
        role: "user",
        content: "private failed turn",
        createdAt: 1_787_860_900_000,
      },
    ]);

    await expect(
      new SharedRuntimeChatService().bridge(agent, rpc, {
        ...h,
        traceId: "voice-failure-trace",
        channel: {
          type: ChannelType.VOICE_DM,
          source: MESSAGE_SOURCE_CLIENT_CHAT,
        },
      }),
    ).rejects.toThrow("provider failed before timing receipt");
    await Promise.all(h.background);

    expect(traceRows).toHaveLength(1);
    expect(traceRows[0]).toMatchObject({
      trace_id: "voice-failure-trace",
      stages: {
        finishReason: "error",
        historyProvenance: {
          messages: [
            {
              id: "failed-turn-user-id",
              role: "user",
              interrupted: false,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(traceRows[0])).not.toContain("private failed turn");
    expect(JSON.stringify(traceRows[0])).not.toContain("provider failed before timing receipt");
  });

  test("prices the exact projected grounding replay before admission", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness([
      { role: "user", content: "Search for Tessera architecture." },
      {
        role: "assistant",
        content: "Tessera is an ARC resource proxy.",
        grounding: {
          kind: "web_search",
          query: "Tessera architecture",
          provider: "parallel",
          text: "Tessera validates ARC resources through an origin guard.",
          observedAt: Date.now(),
          sourceUrls: ["https://example.com/tessera"],
          sources: [
            {
              url: "https://example.com/tessera",
              text: "Tessera validates ARC resources through an origin guard.",
            },
          ],
          truncated: false,
        },
      },
    ]);

    await service.bridge(
      agent,
      { ...rpc, params: { ...rpc.params, text: "How does Tessera architecture work?" } },
      h,
    );

    const estimatedMessages = estimateInputTokens.mock.calls[0]?.[0];
    expect(JSON.stringify(estimatedMessages)).toContain("untrusted_public_web_search_result");
    expect(JSON.stringify(estimatedMessages)).toContain("origin guard");
    expect(admitOrganizationInference.mock.calls[0]?.[0].estimatedInputTokens).toBe(12);
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

  test("lands a deliberate silent group turn without fabricating an assistant message", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    turn = {
      degraded: false,
      responded: false,
      reply: "",
      history: [
        { role: "assistant", content: "prior" },
        { role: "user", content: "ambient guild chatter" },
      ],
      model: "openai/gpt-oss-120b",
    };

    const response = await service.bridge(
      agent,
      { ...rpc, params: { text: "ambient guild chatter", roomId: "guild-room" } },
      {
        ...h,
        funding: "platform",
        channel: { type: ChannelType.GROUP, source: "discord" },
      },
    );

    expect(response.result).toMatchObject({ text: "", responded: false });
    expect(h.history()).toEqual([
      { role: "assistant", content: "prior" },
      expect.objectContaining({ role: "user", content: "ambient guild chatter" }),
    ]);
    expect(lastTurnInput?.execution).toMatchObject({
      channel: { type: ChannelType.GROUP, source: "discord" },
    });
  });

  test("always uses AgentRuntime execution without changing identity", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    turn.actionResults = [expectedTodoActionResult];

    const response = await service.bridge(agent, rpc, {
      ...h,
      funding: "platform",
    });

    expect(lastTurnInput?.execution).toEqual({
      agentKey: agent.id,
      roomKey: sharedRuntimeChannelId(agent.id, "room-1"),
      channel: { type: ChannelType.DM, source: MESSAGE_SOURCE_CLIENT_CHAT },
      authenticatedPersonalSharedUser: true,
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
      agentKey: forgedAgent.id,
      roomKey: sharedRuntimeChannelId(forgedAgent.id, "room-1"),
      channel: { type: ChannelType.DM, source: "shared-runtime" },
      todos: expectedTodoExecution,
    });
  });

  test("keeps Todo-capable streaming on the same genuine AgentRuntime path", async () => {
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: 'Added "Buy milk" to your list.' };
        yield {
          type: "finish",
          text: 'Added "Buy milk" to your list.',
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
      agentKey: agent.id,
      roomKey: sharedRuntimeChannelId(agent.id, "room-1"),
      channel: { type: ChannelType.DM, source: MESSAGE_SOURCE_CLIENT_CHAT },
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
      constraint: "This session cannot initiate a separate email.",
    };
    streamTurn = {
      degraded: false,
      blockedSecondaryCapabilities: [blockedCommunication],
      parts: (async function* () {
        yield { type: "text-delta", text: 'Added "Buy milk" to your list.' };
        yield {
          type: "finish",
          text: 'Added "Buy milk" to your list.\n\nI can\'t initiate a separate email.',
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
    expect(body).toContain('"kind":"capability_handoff"');
    expect(body).toContain('"originalIntent":"hello"');
    expect(body).toContain(`/cloud/agents/${encodeURIComponent(agent.id)}`);
    expect(memoryPairs).toEqual([
      expect.objectContaining({
        assistantReply: 'Added "Buy milk" to your list.\n\nI can\'t initiate a separate email.',
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
          connectorAccountId: "bot:123456789",
          chatId: "123456789",
        },
      },
    };

    await service.bridge(agent, trustedRpc, {
      ...harness(),
      funding: "platform",
    });
    expect(lastTurnInput?.execution).toEqual({
      agentKey: agent.id,
      roomKey: sharedRuntimeChannelId(agent.id, "room-1"),
      channel: { type: ChannelType.DM, source: MESSAGE_SOURCE_CLIENT_CHAT },
      authenticatedPersonalSharedUser: true,
      todos: expectedTodoExecution,
      reminders: {
        runner: expect.any(Object),
        delivery: {
          platform: "telegram",
          project: "eliza-app",
          connectorAccountId: "bot:123456789",
          chatId: "123456789",
        },
      },
    });

    await service.bridge(agent, trustedRpc, {
      ...harness(),
      funding: "organization-credits",
    });
    expect(lastTurnInput?.execution).toEqual({
      agentKey: agent.id,
      roomKey: sharedRuntimeChannelId(agent.id, "room-1"),
      channel: { type: ChannelType.DM, source: "shared-runtime" },
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
    streamTurn = {
      degraded: false,
      internalGrounding: {
        kind: "web_search",
        query: "NubsCarson Tessera GitHub",
        provider: "parallel",
        text: "Tessera validates ARC resources through an origin guard.",
        observedAt: Date.now(),
        sourceUrls: ["https://example.com/tessera"],
        sources: [
          {
            url: "https://example.com/tessera",
            text: "Tessera validates ARC resources through an origin guard.",
          },
        ],
        truncated: false,
      },
      parts: (async function* () {
        yield { type: "text-delta", text: "hello " };
        yield {
          type: "finish",
          text: "hello back",
          usage: { inputTokens: 12, outputTokens: 4 },
          actionResults: [
            {
              success: true,
              text: "hello back",
              data: {
                actionName: "WEB_SEARCH",
                query: "NubsCarson Tessera GitHub",
                provider: "parallel",
                sourceUrls: ["https://example.com/tessera"],
                groundingStatus: "verified",
              },
            },
          ],
        };
      })(),
    };
    const response = await service.stream(agent, rpc, h);
    const body = await response.text();
    expect(body).toContain("event: chunk");
    expect(body).toContain("event: done");
    expect(h.history()).toHaveLength(3);
    expect(h.history().at(-1)?.grounding).toEqual({
      kind: "web_search",
      query: "NubsCarson Tessera GitHub",
      provider: "parallel",
      text: "Tessera validates ARC resources through an origin guard.",
      observedAt: expect.any(Number),
      sourceUrls: ["https://example.com/tessera"],
      sources: [
        {
          url: "https://example.com/tessera",
          text: "Tessera validates ARC resources through an origin guard.",
        },
      ],
      truncated: false,
    });
    expect(memoryPairs).toEqual([
      expect.objectContaining({
        userMessage: "hello",
        assistantReply: "hello back",
        interrupted: false,
      }),
    ]);
    expect(memoryScopes).toHaveLength(1);
    expect(memoryScopes[0]?.roomKey).toBe(sharedRuntimeChannelId(agent.id, "room-1"));
    expect((lastStreamTurnInput?.execution as { roomKey?: string } | undefined)?.roomKey).toBe(
      sharedRuntimeChannelId(agent.id, "room-1"),
    );
    expect(memoryScopes[0]?.roomKey).not.toBe(agent.id);
    await Promise.all(h.background);
    expect(settleCalls).toEqual([0.004]);
  });

  test("terminal done frame is not held open by a stalled long-term-memory mirror (#25689)", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    // The mirror never settles: a stalled Hyperdrive/embeddings-sidecar write.
    // Under the old inline await the body below would never complete.
    let releaseMirror: (() => void) | undefined;
    recordTurnPair.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseMirror = resolve;
        }),
    );
    const service = new SharedRuntimeChatService();
    const h = harness();
    const response = await service.stream(agent, rpc, h);
    const body = await response.text();
    expect(body).toContain("event: chunk");
    expect(body).toContain("event: done");
    // The landed turn stays durable on the merged history boundary.
    expect(h.history().at(-1)).toMatchObject({ role: "assistant", content: "hello back" });
    releaseMirror?.();
    await Promise.all(h.background);
  });

  test("flushes transport readiness before the first provider text delta", async () => {
    let releaseProvider = () => {};
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        await providerGate;
        yield { type: "text-delta", text: "hello " };
        yield { type: "finish", text: "hello back" };
      })(),
    };

    const response = await new SharedRuntimeChatService().stream(agent, rpc, harness());
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe(": ready\n\n");

    releaseProvider();
    await reader?.cancel();
  });

  test("terminates a silent provider stream before the outer room watchdog", async () => {
    let providerNextStarted = false;
    streamTurn = {
      degraded: false,
      parts: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              providerNextStarted = true;
              return await new Promise<IteratorResult<never>>(() => {});
            },
          };
        },
      },
    };

    const service = new SharedRuntimeChatService(20);
    const h = harness([]);
    const body = await (await service.stream(agent, rpc, h)).text();

    expect(providerNextStarted).toBe(true);
    expect(body.startsWith(": ready\n\n")).toBe(true);
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(streamAbortSignal?.aborted).toBe(true);
    expect(h.history()).toEqual([expect.objectContaining({ role: "user", content: "hello" })]);
    await Promise.all(h.background);
    expect(settleUnknownCalls).toBe(1);
  });

  test("returns a terminal SSE timeout when provider setup never resolves", async () => {
    streamTurnSetupGate = new Promise<void>(() => {});
    const service = new SharedRuntimeChatService(20);
    const h = harness([]);

    const body = await (await service.stream(agent, rpc, h)).text();

    expect(body).toContain("event: error");
    expect(body).toContain("Shared runtime stream timed out");
    expect(streamAbortSignal?.aborted).toBe(true);
    expect(h.history()).toEqual([]);
    await Promise.all(h.background);
    expect(settleUnknownCalls).toBe(1);
  });

  test("bounds admitted facts hydration before provider setup", async () => {
    process.env.SHARED_FACTS_ENABLED = "true";
    sharedMemoryStoreOverride = {
      listFacts: async () => await new Promise<never>(() => {}),
    };
    const service = new SharedRuntimeChatService(20);
    const h = harness([]);

    const body = await (await service.stream(agent, rpc, h)).text();

    expect(body).toContain("event: error");
    expect(body).toContain("Shared runtime stream timed out");
    expect(streamTurnCalls).toBe(0);
    expect(streamAbortSignal).toBeUndefined();
    await Promise.all(h.background);
    expect(settleUnknownCalls).toBe(1);
  });

  test("lands partial provider output as interrupted when the terminal deadline expires", async () => {
    streamTurn = {
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await new Promise<void>(() => {});
      })(),
    };

    const service = new SharedRuntimeChatService(20);
    const h = harness([]);
    const body = await (await service.stream(agent, rpc, h)).text();

    expect(body).toContain("event: chunk");
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(h.history()).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({
        role: "assistant",
        content: "partial",
        interrupted: true,
      }),
    ]);
    await Promise.all(h.background);
    expect(settleUnknownCalls).toBe(1);
  });

  test("emits error without done when durable success finalization exceeds the deadline", async () => {
    process.env.SHARED_TURN_TRACES_ENABLED = "true";
    process.env.SHARED_TURN_TRACES_SAMPLE = "1";
    streamTimingOutcome = "success";
    const h = harness([]);
    h.historyStore.checkpointPending = async () => undefined;
    h.historyStore.merge = async () => await new Promise<never>(() => {});

    const body = await (await new SharedRuntimeChatService(20).stream(agent, rpc, h)).text();

    expect(body).toContain("event: chunk");
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(h.staged()).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "hello", interrupted: true }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(traceRows).toHaveLength(1);
    const trace = traceRows[0] as { stages: { terminalTiming?: { outcome?: string } } };
    expect(trace.stages.terminalTiming).toMatchObject({ outcome: "error" });
  });

  test("request abort terminates an abort-ignoring provider before the absolute deadline", async () => {
    streamTurn = {
      degraded: false,
      parts: {
        [Symbol.asyncIterator]() {
          return { next: async () => await new Promise<IteratorResult<never>>(() => {}) };
        },
      },
    };
    const requestAbort = new AbortController();
    const h = harness([]);
    const response = await new SharedRuntimeChatService(500).stream(agent, rpc, {
      ...h,
      abortSignal: requestAbort.signal,
    });
    const bodyPromise = response.text();

    requestAbort.abort(new Error("client disconnected"));
    const body = await bodyPromise;

    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(streamAbortSignal?.aborted).toBe(true);
  });

  test("a failed long-term-memory mirror is reported without failing the landed turn (#25689)", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    recordTurnPair.mockImplementationOnce(async () => {
      throw new Error("hyperdrive write stalled");
    });
    const service = new SharedRuntimeChatService();
    const h = harness();
    const response = await service.stream(agent, rpc, h);
    const body = await response.text();
    expect(body).toContain("event: done");
    expect(h.history().at(-1)).toMatchObject({ role: "assistant", content: "hello back" });
    // The deferred mirror task must settle cleanly (failure reported, not thrown).
    await Promise.all(h.background);
  });

  test("keeps a trusted transient prompt out of history and long-term memory", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    const service = new SharedRuntimeChatService();
    const h = harness();

    const response = await service.stream(agent, rpc, {
      ...h,
      trustedMessageRole: "system",
      transientInput: true,
    });
    expect(await response.text()).toContain("event: done");

    expect(lastStreamTurnInput).toMatchObject({
      message: "hello",
      messageRole: "system",
    });
    expect(h.history()).toEqual([
      { role: "assistant", content: "prior" },
      expect.objectContaining({ role: "assistant", content: "hello back" }),
    ]);
    expect(memoryPairs).toEqual([]);
  });

  test("no-model degradation remains a complete canonical SSE turn", async () => {
    streamTurn = {
      degraded: true,
      reply: "Eliza is temporarily unavailable (no shared model configured).",
    };

    const body = await (await new SharedRuntimeChatService().stream(agent, rpc, harness())).text();
    const frames = body
      .split("\n\n")
      .filter((frame) => Boolean(frame) && !frame.startsWith(":"))
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
      .filter((frame) => frame.trim().length > 0 && !frame.startsWith(":"))
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
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe(": ready\n\n");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    const cancellation = reader.cancel("barge-in");
    expect(h.staged()).toMatchObject([
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial", interrupted: true },
    ]);
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
    let staged: TestMessage[] = [];
    const backgroundFailures: unknown[] = [];
    const h = {
      background: [] as Promise<unknown>[],
      historyStore: {
        load: async () => history,
        stagePending: (_agentId: string, _channelId: string, messages: TestMessage[]) => {
          staged = messages;
        },
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
        waitUntil: (promise: Promise<unknown>) =>
          h.background.push(
            promise.catch((error: unknown) => {
              backgroundFailures.push(error);
            }),
          ),
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
    await reader.read();
    await expect(reader.cancel("first cancel")).resolves.toBeUndefined();
    expect(staged).toMatchObject([
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial", interrupted: true },
    ]);
    expect(history).toHaveLength(1);

    releaseProvider();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(h.background);

    expect(backgroundFailures).toContainEqual(
      expect.objectContaining({ message: "durable put failed" }),
    );
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

  test("keeps a keyed claim pending when claim completion exceeds the terminal deadline", async () => {
    const claims = memoryTurnClaims();
    claims.store.complete = async () => await new Promise<never>(() => {});
    const h = harness([]);
    h.historyStore.checkpointPending = async () => undefined;

    const body = await (
      await new SharedRuntimeChatService(20).stream(agent, keyedRpc, {
        ...h,
        turnClaims: claims.store,
      })
    ).text();

    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(claims.claims.get("client-key-1")?.result).toBeUndefined();
    expect(h.staged()).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "hello", interrupted: true }),
    ]);
  });

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
    expect(second.result).toEqual({
      ...first.result,
      timing: {
        replayed: true,
        durationMs: 0,
        callCount: 0,
        fallbackCount: 0,
        selectedProvider: "none",
        callsTruncated: false,
        // A replay never ran a provider call, so nothing was clamped. The
        // field is required on the receipt, so asserting it here keeps a
        // replayed receipt structurally identical to a live one.
        clamped: false,
        calls: [],
      },
    });
    expect(second.id).toBe("client-key-1");
    expect(h.history()).toHaveLength(historyAfterFirst);
  });

  test("isolates concurrent rooms sharing a clientMessageId and replays within one room", async () => {
    process.env.SHARED_MEMORY_TABLES_ENABLED = "true";
    const service = new SharedRuntimeChatService();
    const privateHarness = harness();
    const voiceHarness = harness();
    const privateClaims = memoryTurnClaims();
    const voiceClaims = memoryTurnClaims();
    const privateRpc = {
      ...keyedRpc,
      params: { ...keyedRpc.params, roomId: "  private-room  " },
    };
    const voiceRpc = {
      ...keyedRpc,
      params: { ...keyedRpc.params, roomId: "voice-room" },
    };
    const privateOptions = {
      ...privateHarness,
      turnClaims: privateClaims.store,
      channel: { type: ChannelType.DM, source: "client_chat" },
    };
    const voiceOptions = {
      ...voiceHarness,
      turnClaims: voiceClaims.store,
      channel: { type: ChannelType.VOICE_GROUP, source: "discord" },
    };

    await Promise.all([
      service.bridge(agent, privateRpc, privateOptions),
      service.bridge(agent, voiceRpc, voiceOptions),
    ]);
    await Promise.all([...privateHarness.background, ...voiceHarness.background]);

    expect(turnCalls).toBe(2);
    expect(admitOrganizationInference).toHaveBeenCalledTimes(2);
    expect(billCalls).toHaveLength(2);
    expect(settleCalls).toHaveLength(2);
    expect(memoryPairs).toHaveLength(2);
    const expectedRoomKeys = new Set([
      sharedRuntimeChannelId(agent.id, "private-room"),
      sharedRuntimeChannelId(agent.id, "voice-room"),
    ]);
    expect(new Set(memoryScopes.map((scope) => scope.roomKey))).toEqual(expectedRoomKeys);
    expect(
      new Set(turnInputs.map((input) => (input.execution as { roomKey: string }).roomKey)),
    ).toEqual(expectedRoomKeys);
    const identities = turnInputs.map((input) => input.messageIds);
    expect(identities[0]).not.toEqual(identities[1]);
    expect(memoryPairs.map((pair) => pair.channel)).toEqual([
      { type: ChannelType.DM, source: "client_chat" },
      { type: ChannelType.VOICE_GROUP, source: "discord" },
    ]);

    const memoryCount = memoryPairs.length;
    await service.bridge(agent, privateRpc, privateOptions);
    await Promise.all(privateHarness.background);
    expect(turnCalls).toBe(2);
    expect(admitOrganizationInference).toHaveBeenCalledTimes(2);
    expect(billCalls).toHaveLength(2);
    expect(settleCalls).toHaveLength(2);
    expect(memoryPairs).toHaveLength(memoryCount);
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

  test("a lifecycle cutoff freezes admission and model history across a pending retry", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store } = memoryTurnClaims();
    const cutoff = 1_000;
    const lifecycleRpc = {
      ...keyedRpc,
      params: {
        ...keyedRpc.params,
        text: "generate a call greeting",
        clientMessageId: "twilio-call:CA1:opening",
      },
    };
    await h.historyStore.merge(agent.id, "room-1", [
      { id: "pre", role: "user", content: "pre-call private fact", createdAt: cutoff - 1 },
      { id: "at", role: "assistant", content: "at-cutoff event", createdAt: cutoff },
      { id: "post", role: "user", content: "post-cutoff secret", createdAt: cutoff + 1 },
    ]);
    const options = {
      ...h,
      turnClaims: store,
      trustedMessageRole: "system" as const,
      trustedHistoryCutoffAt: cutoff,
    };

    streamTurnError = new Error("provider connection lost");
    await expect(service.stream(agent, lifecycleRpc, options)).rejects.toThrow(
      "provider connection lost",
    );
    await h.historyStore.merge(agent.id, "room-1", [
      {
        id: "later-post",
        role: "assistant",
        content: "newer retry-visible secret",
        createdAt: cutoff + 2,
      },
    ]);

    streamTurnError = null;
    const retried = await service.stream(agent, lifecycleRpc, options);
    expect(await retried.text()).toContain("hello back");
    await Promise.all(h.background);

    expect(streamTurnInputs).toHaveLength(2);
    for (const input of streamTurnInputs) {
      expect(input.history).toEqual([
        {
          id: "pre",
          role: "user",
          content: "pre-call private fact",
          createdAt: cutoff - 1,
        },
      ]);
    }
    const admissionPrompts = tokenEstimateInputs.filter((entries) =>
      entries.some((entry) => entry.content === "generate a call greeting"),
    );
    expect(admissionPrompts).toHaveLength(2);
    for (const prompt of admissionPrompts) {
      expect(prompt.map((entry) => entry.content)).toEqual([
        "Be useful.",
        "pre-call private fact",
        "generate a call greeting",
      ]);
    }
  });

  test("rejects a history cutoff without the trusted lifecycle role", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();

    await expect(
      service.bridge(agent, rpc, {
        ...h,
        trustedHistoryCutoffAt: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "INVALID_TRUSTED_HISTORY_CUTOFF",
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(turnCalls).toBe(0);
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

  test("never serializes internal grounding evidence into terminal or replay action results", async () => {
    const service = new SharedRuntimeChatService();
    const h = harness();
    const { store } = memoryTurnClaims();
    const observedAt = Date.now();
    streamTurn = {
      degraded: false,
      internalGrounding: {
        kind: "web_search",
        query: "current BTC price",
        provider: "parallel",
        text: "RAW_PROVIDER_BODY_SHOULD_NOT_ESCAPE",
        observedAt,
        sourceUrls: ["https://example.com/btc"],
        sources: [
          {
            url: "https://example.com/btc",
            text: "RAW_SOURCE_EXCERPT_SHOULD_NOT_ESCAPE",
          },
        ],
        truncated: false,
      },
      parts: (async function* () {
        yield { type: "text-delta", text: "BTC is 70,000 USD. " };
        yield {
          type: "finish",
          text: "BTC is 70,000 USD. Source: example.com — https://example.com/btc",
          actionResults: [
            {
              success: true,
              text: "BTC is 70,000 USD. Source: example.com — https://example.com/btc",
              data: {
                actionName: "WEB_SEARCH",
                query: "current BTC price",
                provider: "parallel",
                observedAt,
                sourceUrls: ["https://example.com/btc"],
                groundingStatus: "verified",
              },
            },
          ],
        };
      })(),
    };

    const options = { ...h, turnClaims: store };
    const firstBody = await (await service.stream(agent, keyedRpc, options)).text();
    const replayBody = await (await service.stream(agent, keyedRpc, options)).text();

    for (const body of [firstBody, replayBody]) {
      expect(body).toContain("https://example.com/btc");
      expect(body).not.toContain("RAW_PROVIDER_BODY_SHOULD_NOT_ESCAPE");
      expect(body).not.toContain("RAW_SOURCE_EXCERPT_SHOULD_NOT_ESCAPE");
      expect(body).not.toContain("originalModelReply");
      expect(body).not.toContain('"sources"');
    }
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
