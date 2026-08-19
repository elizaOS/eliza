/**
 * Proves the durable claim/replay/conflict boundary for client-keyed shared
 * turns (#18045) through the REAL route → conversation-coordinator → Durable
 * Object → shared chat service path. Only provider dispatch and the money
 * seams (admission, billing) are deterministic doubles, each with a call
 * counter — so the suite can assert that a cold create → first send → retry
 * sequence produces exactly ONE provider dispatch, ONE admission/reservation,
 * and ONE billed settlement, that the retry returns the identical terminal
 * result (even from a rebuilt Durable Object over the same storage), and that
 * a reused clientMessageId with different text is rejected with a structured
 * 409 instead of replacing the landed transcript pair.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

// ---------------------------------------------------------------------------
// Route seam: scope resolution is not under test; execution + billing are real.
// ---------------------------------------------------------------------------

const resolveSharedAgent = mock();
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

// ---------------------------------------------------------------------------
// Durable Object runtime seams (identical to shared-runtime-conversation.test).
// ---------------------------------------------------------------------------

mock.module("@/db/client", () => ({
  runWithDbCacheAsync: async <T>(fn: () => Promise<T>) => await fn(),
}));
mock.module("@/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => process.env,
  getCloudBinding: () => undefined,
  hasCloudBindingsContext: () => false,
  runWithCloudBindingsAsync: async <T>(_env: unknown, fn: () => Promise<T>) =>
    await fn(),
}));
mock.module("@/lib/services/shared-runtime/cached-agent-dates", () => ({
  rehydrateCachedAgentDates: (agent: unknown) => agent,
}));
mock.module("@/db/repositories/shared-runtime-history", () => ({
  sharedRuntimeHistoryRepository: {
    get: async () => [],
    merge: async (_agentId: string, _channelId: string, history: unknown[]) =>
      history,
  },
}));

// ---------------------------------------------------------------------------
// Money + provider seams with call counters (the quantities under test).
// ---------------------------------------------------------------------------

let providerDispatches = 0;
let admissions = 0;
let billSettlements = 0;
const settledCosts: number[] = [];
const admissionContexts: Array<{
  requestId: string;
  metadata?: Record<string, unknown>;
}> = [];

mock.module("@/lib/pricing", () => ({
  getProviderFromModel: () => "openai",
}));
mock.module("@/lib/middleware/rate-limit", () => ({
  enforceOrgRateLimit: async () => null,
  OrgRateLimitCacheNotReadyError: class extends Error {},
}));
mock.module("@/lib/services/inference-admission-snapshot", () => ({
  getInferenceAdmissionSnapshotCacheOnly: async () => ({
    balance: { balanceUsd: 10, balanceAt: Date.now(), balanceRevision: 1 },
    rateLimits: {
      completionsRpm: 120,
      embeddingsRpm: 120,
      standardRpm: 120,
      strictRpm: 30,
    },
  }),
  InferenceAdmissionSnapshotCacheWarmingError: class extends Error {},
  inferenceRateLimitConfig: () => ({ windowMs: 60_000, maxRequests: 120 }),
}));
mock.module("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference: async (params: {
    context: { requestId: string; metadata?: Record<string, unknown> };
  }) => {
    admissions++;
    admissionContexts.push(params.context);
    return {
      mode: "deferred_kv_ledger",
      settle: async (cost: number) => {
        settledCosts.push(cost);
        return null;
      },
      settleUnknown: async () => null,
      reservation: undefined,
    };
  },
}));
mock.module("@/lib/services/ai-billing", () => ({
  estimateInputTokens: () => 12,
  billUsage: async () => {
    billSettlements++;
    return { totalCost: 0.004, inputTokens: 12, outputTokens: 4 };
  },
  recordUsageAnalytics: async () => null,
  billFlatUsage: async () => {
    billSettlements++;
    return { totalCost: 0.004, inputTokens: 0, outputTokens: 0 };
  },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    required = 1;
    available = 0;
  },
}));
mock.module("@/lib/services/ai-billing-records", () => ({
  aiBillingRecordsService: { record: async () => undefined },
}));
mock.module("@/lib/services/inference-admission-gate", () => ({
  isInferenceAdmissionDispatchMarkError: () => false,
  warmInferenceAdmissionGate: async () => undefined,
  warmInferenceRateLimitGate: async () => undefined,
}));
mock.module("@/lib/services/inference-billing-fast-path", () => ({
  InferenceBalanceCacheWarmingError: class extends Error {},
}));
mock.module("@/lib/services/shared-runtime/run-shared-agent-turn", () => ({
  appendSharedInput: (history: unknown[], message: string) => [
    ...history,
    { role: "user", content: message },
  ],
  appendSharedTurn: (history: unknown[], message: string, reply: string) => [
    ...history,
    { role: "user", content: message },
    { role: "assistant", content: reply },
  ],
  resolveSharedAgentTurnModel: () => "openai/gpt-oss-120b",
  runSharedAgentTurn: async (input: {
    message: string;
    messageIds: { user: string; assistant: string };
  }) => {
    providerDispatches++;
    return {
      degraded: false,
      reply: `echo: ${input.message}`,
      history: [
        { id: input.messageIds.user, role: "user", content: input.message },
        {
          id: input.messageIds.assistant,
          role: "assistant",
          content: `echo: ${input.message}`,
        },
      ],
      model: "openai/gpt-oss-120b",
    };
  },
  runSharedAgentTurnStream: async () => {
    throw new Error("stream is not under test here");
  },
}));

const { SharedRuntimeConversation } = await import(
  "../src/shared-runtime-conversation"
);
const messagesRoute = (
  await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/route"
  )
).default;

// ---------------------------------------------------------------------------
// Real Durable Object namespace over persistent (per-test) storage.
// ---------------------------------------------------------------------------

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const AGENT_FIXTURE = {
  id: AGENT,
  organization_id: "org-1",
  user_id: "user-1",
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
};

function makeState(data: Map<string, unknown>, background: Promise<unknown>[]) {
  return {
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      deleteAll: async () => {
        data.clear();
      },
    },
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  };
}

function makeNamespace(
  data: Map<string, Map<string, unknown>>,
  background: Promise<unknown>[],
) {
  const objects = new Map<
    string,
    InstanceType<typeof SharedRuntimeConversation>
  >();
  return {
    getByName: (name: string) => {
      let object = objects.get(name);
      if (!object) {
        let storage = data.get(name);
        if (!storage) {
          storage = new Map();
          data.set(name, storage);
        }
        object = new SharedRuntimeConversation(
          makeState(storage, background) as never,
          {} as never,
        );
        objects.set(name, object);
      }
      return {
        fetch: async (url: RequestInfo | URL, init?: RequestInit) =>
          object!.fetch(new Request(url, init)),
      };
    },
  };
}

function postMessage(
  namespace: ReturnType<typeof makeNamespace>,
  body: unknown,
) {
  return messagesRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer user-api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { SHARED_RUNTIME_CONVERSATIONS: namespace } as never,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );
}

async function settleBackground(background: Promise<unknown>[]) {
  while (background.length) {
    await Promise.all(background.splice(0));
  }
}

beforeEach(() => {
  providerDispatches = 0;
  admissions = 0;
  billSettlements = 0;
  settledCosts.length = 0;
  admissionContexts.length = 0;
  resolveSharedAgent.mockReset();
  resolveSharedAgent.mockResolvedValue({
    agent: AGENT_FIXTURE,
    agentId: AGENT,
    agentName: "Nova",
  });
});

test("cold create → first send → retry: one dispatch, one admission, one charge, identical result", async () => {
  const data = new Map<string, Map<string, unknown>>();
  const background: Promise<unknown>[] = [];
  const namespace = makeNamespace(data, background);
  const send = { text: "hello", clientMessageId: "cmid-1" };

  // Cold first send: the conversation object hydrates off-path and answers
  // the documented retryable warming envelope.
  const cold = await postMessage(namespace, send);
  expect(cold.status).toBe(503);
  expect(await cold.json()).toMatchObject({
    code: "shared_runtime_cache_warming",
    retryable: true,
  });
  await settleBackground(background);

  // Warm retry executes the turn once.
  const first = await postMessage(namespace, send);
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { text: string };
  expect(firstBody.text).toBe("echo: hello");
  await settleBackground(background);
  expect(providerDispatches).toBe(1);
  expect(admissions).toBe(1);
  expect(billSettlements).toBe(1);
  expect(settledCosts).toEqual([0.004]);

  // Same-key retry (a lost response) replays the stored terminal result:
  // no second dispatch, admission, reservation, or charge.
  const retry = await postMessage(namespace, send);
  expect(retry.status).toBe(200);
  expect((await retry.json()) as { text: string }).toEqual(firstBody);
  await settleBackground(background);
  expect(providerDispatches).toBe(1);
  expect(admissions).toBe(1);
  expect(billSettlements).toBe(1);

  // The single admission used the deterministic client-keyed identities.
  expect(admissionContexts).toHaveLength(1);
  expect(String(admissionContexts[0]?.metadata?.idempotencyKey)).toEndWith(
    ":cmid-1",
  );

  // Same key + different text is a structured, non-retryable 409 conflict.
  const conflict = await postMessage(namespace, {
    text: "edited",
    clientMessageId: "cmid-1",
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({
    code: "client_message_conflict",
    retryable: false,
  });
  expect(providerDispatches).toBe(1);
  expect(admissions).toBe(1);

  // The claim survives the coordinator process: a REBUILT Durable Object over
  // the same storage still replays instead of re-dispatching.
  const rebuilt = makeNamespace(data, background);
  const replayAfterRestart = await postMessage(rebuilt, send);
  expect(replayAfterRestart.status).toBe(200);
  expect((await replayAfterRestart.json()) as { text: string }).toEqual(
    firstBody,
  );
  expect(providerDispatches).toBe(1);
  expect(admissions).toBe(1);
  expect(billSettlements).toBe(1);
});

test("distinct clientMessageIds still execute as distinct billed turns", async () => {
  const data = new Map<string, Map<string, unknown>>();
  const background: Promise<unknown>[] = [];
  const namespace = makeNamespace(data, background);

  const cold = await postMessage(namespace, {
    text: "one",
    clientMessageId: "cmid-a",
  });
  expect(cold.status).toBe(503);
  await settleBackground(background);

  const first = await postMessage(namespace, {
    text: "one",
    clientMessageId: "cmid-a",
  });
  expect(first.status).toBe(200);
  const second = await postMessage(namespace, {
    text: "two",
    clientMessageId: "cmid-b",
  });
  expect(second.status).toBe(200);
  await settleBackground(background);

  expect(((await second.json()) as { text: string }).text).toBe("echo: two");
  expect(providerDispatches).toBe(2);
  expect(admissions).toBe(2);
  expect(billSettlements).toBe(2);
  expect(admissionContexts[0]?.requestId).not.toBe(
    admissionContexts[1]?.requestId,
  );
});
