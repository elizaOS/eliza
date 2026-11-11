/**
 * A warm chat-completions request makes exactly one awaited store call before
 * the provider fetch: the cached auth entry read. No Durable Object call and
 * no Postgres statement precedes the provider. The entry alone also refuses a
 * request: a billing hold, an exhausted allowance, no credit, a revoked or an
 * expired key are answered without the provider or any second store.
 *
 * The real route, auth resolution, limiter and organization admission run
 * here. The provider is a recorded `fetch`; the debit and usage ledger are
 * controlled ports because this file carries no billing schema.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.CEREBRAS_API_KEY = "cerebras-key-for-single-store-call-test";
process.env.INFERENCE_PASSTHROUGH_STREAMING = "true";
setDefaultTimeout(120_000);

const { getPgliteClientForTests, closeDatabaseConnectionsForTests } =
  await import("@elizaos/cloud-shared/db/client");
const { cache } = await import("@elizaos/cloud-shared/lib/cache/client");
const { CacheKeys, CacheTTL } = await import(
  "@elizaos/cloud-shared/lib/cache/keys"
);
const { runWithCloudBindingsAsync } = await import(
  "@elizaos/cloud-shared/lib/runtime/cloud-bindings"
);
const { runWithRequestContext } = await import(
  "@elizaos/cloud-shared/lib/runtime/request-context"
);
const authCache = await import(
  "@elizaos/cloud-shared/lib/services/inference-auth-cache"
);
const authContext = await import(
  "@elizaos/cloud-shared/lib/services/inference-auth-context"
);
const rateLimit = await import(
  "@elizaos/cloud-shared/lib/middleware/rate-limit"
);
const pricing = await import("@elizaos/cloud-shared/lib/pricing");
const billing = await import("@elizaos/cloud-shared/lib/services/ai-billing");
const ledger = await import(
  "@elizaos/cloud-shared/lib/services/ai-billing-settled"
);
const fastPath = await import(
  "@elizaos/cloud-shared/lib/services/inference-billing-fast-path"
);
const snapshots = await import(
  "@elizaos/cloud-shared/lib/services/inference-admission-snapshot"
);
const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);

type Snapshot =
  import("@elizaos/cloud-shared/lib/services/inference-auth-cache").InferenceAdmissionSnapshot;
type AuthEntry =
  import("@elizaos/cloud-shared/lib/services/inference-auth-cache").InferenceAuthContext;

const ORG = "94000000-0000-4000-8000-000000000001";
const USER = "95000000-0000-4000-8000-000000000001";
const PROVIDER_URL = "https://api.cerebras.ai/v1/chat/completions";

/**
 * Store calls observed since the request began. Primary statements are held
 * until the request has returned, so a request that awaited one could never
 * return: `primary` counts the statements that ran, which is zero until then.
 * Statements that off-response bookkeeping merely started are not counted.
 */
const counts = { cacheReads: 0, gateCalls: 0, primary: 0 };
let primaryHold: Promise<void> = Promise.resolve();
const gatePaths: string[] = [];
let atProvider: typeof counts | undefined;
let providerCalls = 0;
let debitedBalanceUsd = 9.99;
const spies: Array<{ mockRestore(): void }> = [];
const realFetch = globalThis.fetch;

const bindings = {
  INFERENCE_ADMISSION_GATES: {
    getByName() {
      return {
        async fetch(request: Request) {
          counts.gateCalls += 1;
          const path = new URL(request.url).pathname;
          gatePaths.push(path);
          if (path === "/lease-dispatched")
            return Response.json({
              admitted: true,
              dispatched: true,
              availableUsd: 9,
              requiredUsd: 1,
            });
          if (path === "/settlement-fence")
            return Response.json({
              settlementFenced: true,
              estimatedCostUsd: 1,
            });
          if (path === "/settle") return Response.json({ settled: true });
          return Response.json({ allowed: true, committed: true });
        },
      };
    },
  },
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    authority: {
      generation: "1",
      source: "legacy",
      sourceSubscriptionId: null,
      sourceRevision: null,
      projectionRevision: null,
      catalogVersion: null,
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveUntil: null,
    },
    subscriptionFunded: false,
    balance: { balanceUsd: 10, balanceAt: Date.now(), balanceRevision: "1" },
    rateLimits: {
      completionsRpm: 60,
      embeddingsRpm: 60,
      standardRpm: 60,
      strictRpm: 15,
    },
    billingHold: false,
    ...overrides,
  };
}

let sequence = 0;
function newKey(): { rawKey: string; keyHash: string; id: string } {
  sequence += 1;
  const rawKey = `eliza_single_store_call_${sequence}_${Date.now()}`;
  return {
    rawKey,
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    id: crypto.randomUUID(),
  };
}

async function seedEntry(
  key: { keyHash: string; id: string },
  admission: Snapshot,
  overrides: Partial<AuthEntry> = {},
): Promise<void> {
  const entry: AuthEntry = {
    v: authCache.INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    userId: USER,
    orgId: ORG,
    apiKeyId: key.id,
    apiKeyRateLimit: 1000,
    apiKeyExpiresAt: null,
    keyHash: key.keyHash,
    appScopeId: null,
    admission,
    ...overrides,
  };
  const outcome = await cache.setWithOutcome(
    CacheKeys.inference.authContext(key.keyHash),
    entry,
    CacheTTL.inference.authContext,
    { keyClass: "inference_auth" },
  );
  expect(outcome.kind).toBe("written");
}

interface Call {
  response: Response;
  beforeProvider: typeof counts | undefined;
  beforeResponse: typeof counts;
  background: Promise<unknown>[];
}

async function chat(rawKey: string, stream = true): Promise<Call> {
  const background: Promise<unknown>[] = [];
  counts.cacheReads = 0;
  counts.gateCalls = 0;
  counts.primary = 0;
  gatePaths.length = 0;
  atProvider = undefined;
  let releasePrimary = () => {};
  primaryHold = new Promise<void>((resolve) => {
    releasePrimary = resolve;
  });
  const response = await runWithCloudBindingsAsync(bindings, () =>
    runWithRequestContext({}, () =>
      handleChatCompletionsPOST(
        new Request("https://api.eliza.app/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${rawKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "cerebras/qwen-3.8-27b",
            messages: [{ role: "user", content: "hello" }],
            ...(stream && {
              stream: true,
              stream_options: { include_usage: true },
            }),
          }),
        }),
        {
          executionCtx: {
            waitUntil(task) {
              background.push(task);
            },
          },
        },
      ),
    ),
  );
  const beforeResponse = { ...counts };
  releasePrimary();
  return { response, beforeProvider: atProvider, beforeResponse, background };
}

/** Drain the stream and every task the request registered, including nested ones. */
async function finish(call: Call): Promise<void> {
  await call.response.text();
  for (let settled = 0; settled < call.background.length; ) {
    const pending = call.background.slice(settled);
    settled = call.background.length;
    await runWithCloudBindingsAsync(bindings, () =>
      Promise.allSettled(pending),
    );
  }
}

beforeAll(() => {
  const client = getPgliteClientForTests() as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const method of ["query", "exec", "transaction"]) {
    const original = client[method]!.bind(client);
    client[method] = (...args: unknown[]) =>
      primaryHold.then(() => {
        counts.primary += 1;
        return original(...args);
      });
  }
  const getWithOutcome = cache.getWithOutcome.bind(cache);
  spies.push(
    spyOn(cache, "getWithOutcome").mockImplementation(((
      ...args: Parameters<typeof cache.getWithOutcome>
    ) => {
      counts.cacheReads += 1;
      return getWithOutcome(...args);
    }) as typeof cache.getWithOutcome),
  );
  const get = cache.get.bind(cache);
  spies.push(
    spyOn(cache, "get").mockImplementation(((
      ...args: Parameters<typeof cache.get>
    ) => {
      counts.cacheReads += 1;
      return get(...args);
    }) as typeof cache.get),
  );
  // A warm isolate prices from memory; this file has no pricing table.
  spies.push(
    spyOn(pricing, "calculateCost").mockResolvedValue({
      inputCost: 0.001,
      outputCost: 0.009,
      totalCost: 0.01,
    }),
  );
  spies.push(
    spyOn(billing, "billUsage").mockResolvedValue({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      totalCost: 0.01,
    } as Awaited<ReturnType<typeof billing.billUsage>>),
  );
  spies.push(
    spyOn(ledger, "recordSettledInferenceBilling").mockResolvedValue({
      usageRecord: null,
      record: {} as Awaited<
        ReturnType<typeof ledger.recordSettledInferenceBilling>
      >["record"],
    }),
  );
  spies.push(
    spyOn(fastPath, "debitInferenceCost").mockImplementation(
      async (_ctx, amountUsd) =>
        ({
          status: "collected",
          attemptedAmountUsd: amountUsd,
          collectedAmountUsd: amountUsd,
          newBalanceUsd: debitedBalanceUsd,
          balanceRevision: "2",
          transactionId: crypto.randomUUID(),
        }) as Awaited<ReturnType<typeof fastPath.debitInferenceCost>>,
    ),
  );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== PROVIDER_URL) return realFetch(input, init);
    providerCalls += 1;
    atProvider = { ...counts };
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    const chunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "qwen-3.8-27b",
    };
    if (body.stream) {
      return new Response(
        [
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          `data: ${JSON.stringify({ ...chunk, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return Response.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "qwen-3.8-27b",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }) as typeof fetch;
});

afterEach(() => {
  providerCalls = 0;
  debitedBalanceUsd = 9.99;
  authContext.__clearInferenceApiKeyHydrations();
  rateLimit.__clearIsolateRateWindows();
  snapshots.resetInferenceAdmissionMemoryCacheForTests();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const spy of spies) spy.mockRestore();
  await closeDatabaseConnectionsForTests();
});

for (const stream of [true, false]) {
  test(`a warm ${stream ? "streamed" : "buffered"} request reaches the provider after one cache read and no other store call`, async () => {
    const key = newKey();
    await seedEntry(key, snapshot());
    const call = await chat(key.rawKey, stream);
    expect(call.response.status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(call.beforeProvider).toEqual({
      cacheReads: 1,
      gateCalls: 0,
      primary: 0,
    });
    await finish(call);
    // Accounting runs only after the response: lease, fence, then settlement.
    expect(gatePaths).toEqual([
      "/lease-dispatched",
      "/settlement-fence",
      "/settle",
    ]);
  });
}

test("a billing hold in the entry is refused with 402 before any provider or gate call", async () => {
  const key = newKey();
  await seedEntry(key, snapshot({ billingHold: true }));
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(402);
  expect((await call.response.json()) as unknown).toMatchObject({
    error: { type: "insufficient_quota", code: "billing_hold_active" },
  });
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse.gateCalls).toBe(0);
  expect(call.beforeResponse.primary).toBe(0);
});

test("an exhausted plan allowance is refused with allowance_exhausted and its reset time", async () => {
  const key = newKey();
  const resetsAt = "2030-01-01T00:00:00.000Z";
  const base = snapshot();
  await seedEntry(
    key,
    snapshot({
      authority: { ...base.authority, effectiveUntil: resetsAt },
      subscriptionFunded: true,
      funding: { balanceUsd: 0, balanceRevision: "1" },
    }),
  );
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(402);
  expect((await call.response.json()) as unknown).toEqual({
    error: {
      message:
        "Plan allowance is used up for this period. Nothing is purchased automatically.",
      type: "insufficient_quota",
      code: "allowance_exhausted",
      resetsAt,
    },
  });
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse.gateCalls).toBe(0);
  expect(call.beforeResponse.primary).toBe(0);
});

test("an entry with no credit is refused with insufficient_credits", async () => {
  const key = newKey();
  await seedEntry(
    key,
    snapshot({
      balance: { balanceUsd: 0, balanceAt: Date.now(), balanceRevision: "1" },
    }),
  );
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(402);
  expect((await call.response.json()) as unknown).toMatchObject({
    error: { type: "insufficient_quota", code: "insufficient_credits" },
  });
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse.gateCalls).toBe(0);
  expect(call.beforeResponse.primary).toBe(0);
});

test("a revoked key's rewritten entry is refused with 401 from the one cache read", async () => {
  const key = newKey();
  const written = await authCache.writeInferenceApiKeyAuthRejection(
    key.keyHash,
    "rejected",
    401,
    "credential_inactive",
  );
  expect(written.kind).toBe("written");
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(401);
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse).toEqual({
    cacheReads: 1,
    gateCalls: 0,
    primary: 0,
  });
});

test("an expired key is refused with 401 from the entry's own expiry", async () => {
  const key = newKey();
  await seedEntry(key, snapshot(), { apiKeyExpiresAt: Date.now() - 1_000 });
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(401);
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse.gateCalls).toBe(0);
  expect(call.beforeResponse.primary).toBe(0);
});

test("a settlement that empties the balance refreshes the projection and the auth entry off the response", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  debitedBalanceUsd = 0;
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(200);
  expect(call.beforeProvider).toEqual({
    cacheReads: 1,
    gateCalls: 0,
    primary: 0,
  });
  await finish(call);
  // Both refreshes read the primary; they ran only after the response.
  expect(counts.primary).toBeGreaterThan(0);
});

test("a refused post-response lease still debits the request", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const debits = (
    fastPath.debitInferenceCost as unknown as {
      mock: { calls: unknown[] };
    }
  ).mock.calls.length;
  const refusing = {
    INFERENCE_ADMISSION_GATES: {
      getByName: () => ({
        fetch: async () =>
          Response.json(
            { admitted: false, availableUsd: 0, requiredUsd: 1 },
            { status: 402 },
          ),
      }),
    },
  };
  const original = bindings.INFERENCE_ADMISSION_GATES;
  bindings.INFERENCE_ADMISSION_GATES =
    refusing.INFERENCE_ADMISSION_GATES as unknown as typeof original;
  try {
    const call = await chat(key.rawKey);
    expect(call.response.status).toBe(200);
    await finish(call);
  } finally {
    bindings.INFERENCE_ADMISSION_GATES = original;
  }
  expect(
    (fastPath.debitInferenceCost as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length,
  ).toBe(debits + 1);
});
