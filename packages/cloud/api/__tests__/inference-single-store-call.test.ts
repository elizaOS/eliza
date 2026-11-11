/**
 * Cached identity avoids primary reads while durable revocation, shared request
 * limits and a recoverable funding lease are checked before provider work.
 * The real routes run against PGlite and controlled provider/gate ports; all
 * unrelated cache/primary work is held until the response has returned.
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
process.env.OPENAI_API_KEY = "openai-key-for-single-store-call-test";
process.env.INFERENCE_PASSTHROUGH_EMBEDDINGS = "true";
process.env.CACHE_BACKEND = "memory";
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
const pricing = await import("@elizaos/cloud-shared/lib/pricing");
const flatPricing = await import(
  "@elizaos/cloud-shared/lib/services/ai-pricing"
);
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
const teamPool = await import(
  "@elizaos/cloud-shared/lib/services/team-credential-pool"
);
const firstLineCache = await import(
  "@elizaos/cloud-shared/lib/services/tts-first-line-cache"
);
const stewardClient = await import(
  "@elizaos/cloud-shared/lib/auth/steward-client"
);
const { requireGenerativeRouteCaller } = await import(
  "../src/lib/generative-route-auth"
);
const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);
const routes = {
  embeddings: (await import("../v1/embeddings/route")).default,
  tts: (await import("../v1/voice/tts/route")).default,
  stt: (await import("../v1/voice/stt/route")).default,
  warm: (await import("../v1/inference/warm/route")).default,
} as unknown as Record<
  "embeddings" | "tts" | "stt" | "warm",
  {
    request(
      url: string,
      init: RequestInit,
      env: Record<string, unknown>,
      executionCtx: unknown,
    ): Response | Promise<Response>;
  }
>;

type Snapshot =
  import("@elizaos/cloud-shared/lib/services/inference-auth-cache").InferenceAdmissionSnapshot;
type AuthEntry =
  import("@elizaos/cloud-shared/lib/services/inference-auth-cache").InferenceAuthContext;

const ORG = "94000000-0000-4000-8000-000000000001";
const USER = "95000000-0000-4000-8000-000000000001";
const PROVIDER_HOSTS = new Set([
  "api.cerebras.ai",
  "api.openai.com",
  "api.cartesia.ai",
  "api.deepgram.com",
]);
const AUTH_ENTRY_KEY_PREFIX = CacheKeys.inference
  .authContext("\u0000")
  .split("\u0000")[0]!;
/** A signed-in session's cached decision: that caller's one auth read. */
const SESSION_ENTRY_KEY_PREFIX = CacheKeys.inference
  .sessionAuthContext("\u0000")
  .split("\u0000")[0]!;

/**
 * Store calls observed since the request began. Primary statements, gate
 * calls and cache reads other than the auth entry are held until the request
 * has returned, so a request that awaited one could never return: those
 * counters hold the calls that ran, which is zero until then. Calls that
 * off-response bookkeeping merely started are not counted.
 */
const counts = { cacheReads: 0, gateCalls: 0, primary: 0 };
let primaryHold: Promise<void> = Promise.resolve();
const gatePaths: string[] = [];
let atProvider: typeof counts | undefined;
let providerCalls = 0;
let providerAuthorization: string | null = null;
let firstLineLookups = 0;
let firstLineLookupsAtProvider = 0;
/** A test's own gate answer for a path; undefined falls through to the default. */
let gateReply: ((path: string) => Response | undefined) | undefined;
/**
 * Gate calls wait for the request to return, so an awaited one would stall
 * it. Cleared only by tests of callers that are meant to await the gate.
 */
let gateHeld = false;
let debitedBalanceUsd = 9.99;
const spies: Array<{ mockRestore(): void }> = [];
const realFetch = globalThis.fetch;

const bindings = {
  INFERENCE_ADMISSION_GATES: {
    getByName() {
      return {
        async fetch(request: Request) {
          if (gateHeld) await primaryHold;
          counts.gateCalls += 1;
          const path = new URL(request.url).pathname;
          gatePaths.push(path);
          const reply = gateReply?.(path);
          if (reply) return reply;
          if (path === "/rate-limit")
            return Response.json({
              allowed: true,
              remaining: 59,
              resetAt: Date.now() + 60_000,
            });
          if (path.startsWith("/lease-dispatched"))
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
          return Response.json({
            allowed: true,
            committed: true,
            hydrated: true,
          });
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

/** The key's row in the primary, read by the off-response entry rewrite. */
async function seedPrimaryKey(key: {
  keyHash: string;
  id: string;
}): Promise<void> {
  await getPgliteClientForTests().query(
    `INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, rate_limit,
       is_active, usage_count, created_at, updated_at, user_created)
     VALUES ($1, $2, $3, 'eliza_si', $4, $5, 1000, true, 0, now(), now(), true)`,
    [key.id, `single-store-${key.id}`, key.keyHash, ORG, USER],
  );
}

async function readEntry(key: { keyHash: string }): Promise<unknown> {
  return await cache.get(CacheKeys.inference.authContext(key.keyHash));
}

interface Call {
  response: Response;
  beforeProvider: typeof counts | undefined;
  beforeResponse: typeof counts;
  background: Promise<unknown>[];
}

type ExecutionCtx = { waitUntil(task: Promise<unknown>): void };

/** One Worker request; held store calls are released once it has returned. */
async function serve(
  run: (executionCtx: ExecutionCtx) => Response | Promise<Response>,
): Promise<Call> {
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
  const requestStore: Record<string, unknown> = {};
  const response = await runWithCloudBindingsAsync(bindings, () =>
    runWithRequestContext(requestStore, () =>
      Promise.resolve(
        run({
          waitUntil(task) {
            background.push(task);
          },
        }),
      ),
    ),
  );
  // workerd does not carry the request's async store into a stream's pull or
  // cancel, where a streamed response is settled. Bun does, so the store is
  // emptied here: nothing that runs after the response may depend on it.
  for (const name of Object.keys(requestStore)) delete requestStore[name];
  const beforeResponse = { ...counts };
  releasePrimary();
  return { response, beforeProvider: atProvider, beforeResponse, background };
}

function chat(rawKey: string, stream = true): Promise<Call> {
  return serve((executionCtx) =>
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
      { executionCtx },
    ),
  );
}

const ROUTE_ENV = {
  CARTESIA_API_KEY: "cartesia-key-for-single-store-call-test",
  DEEPGRAM_API_KEY: "deepgram-key-for-single-store-call-test",
  VOICE_BATCH_STT_PROVIDER: "deepgram",
};

function route(name: keyof typeof routes, init: RequestInit): Promise<Call> {
  return serve((executionCtx) =>
    routes[name].request("https://api.eliza.app/", init, ROUTE_ENV, {
      ...executionCtx,
      passThroughOnException: () => undefined,
      props: {},
    }),
  );
}

/** One second of 16 kHz mono PCM silence in a WAV container. */
function wavFile(): File {
  const samples = 16_000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1)
      bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return new File([bytes], "speech.wav", { type: "audio/wav" });
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

beforeAll(async () => {
  // The primary the off-response refreshes read: an organization with no
  // credit left, its owner, and the policy tables admission is read from.
  const exec = async (query: string) => {
    await getPgliteClientForTests().exec(query);
  };
  const { createBillingSnapshotFixture } = await import(
    "../../shared/src/db/repositories/account-billing-snapshot-test-fixture"
  );
  await createBillingSnapshotFixture(exec, "");
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { users, userModerationStatus } = await import(
    "@elizaos/cloud-shared/db/schemas"
  );
  await exec("DROP TABLE users CASCADE");
  for (const table of [users, userModerationStatus]) {
    const config = getTableConfig(table);
    await exec(
      `CREATE TABLE "${config.name}" (${config.columns
        .map(
          (column) =>
            `"${column.name}" ${"enumValues" in column && column.enumValues ? "text" : column.getSQLType()}`,
        )
        .join(", ")})`,
    );
  }
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '0', 1, 0, '{}', true, false, 'active')`);
  await exec(`INSERT INTO users(id, organization_id, is_active, steward_user_id, role)
    VALUES ('${USER}', '${ORG}', true, 'subject_single_store', 'owner')`);

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
  // Every cache operation is a store call. Only a read of the auth entry may
  // run before the request returns; all others wait for it.
  const cacheMethods = cache as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const authEntryReads = new Set(["get", "getWithOutcome"]);
  for (const method of [
    "get",
    "getWithOutcome",
    "getWithSWR",
    "mget",
    "getAndDelete",
    "getOrSet",
    "wrapNullable",
    "set",
    "setWithOutcome",
    "setIfNotExists",
    "incr",
    "expire",
    "pexpire",
    "pttl",
    "del",
    "delConfirmed",
    "delPattern",
    "delPatternConfirmed",
    "scanByPrefix",
    "pushQueueHead",
    "getQueueLength",
    "moveQueueTail",
    "removeQueueValue",
    "listQueue",
  ]) {
    expect(typeof cacheMethods[method]).toBe("function");
    const original = cacheMethods[method]!.bind(cache);
    spies.push(
      spyOn(cacheMethods, method).mockImplementation(
        async (...args: unknown[]) => {
          const isAuthEntryRead =
            authEntryReads.has(method) &&
            (String(args[0]).startsWith(AUTH_ENTRY_KEY_PREFIX) ||
              String(args[0]).startsWith(SESSION_ENTRY_KEY_PREFIX));
          if (!isAuthEntryRead) await primaryHold;
          counts.cacheReads += 1;
          return original(...args);
        },
      ),
    );
  }
  // The first-line audio cache is object storage, outside the cache client.
  spies.push(
    spyOn(
      firstLineCache.getCloudFirstLineCacheService(),
      "get",
    ).mockImplementation(async () => {
      firstLineLookups += 1;
      return null;
    }),
  );
  // A warm isolate prices from memory; this file has no pricing table.
  spies.push(
    spyOn(pricing, "calculateCost").mockResolvedValue({
      inputCost: 0.001,
      outputCost: 0.009,
      totalCost: 0.01,
    }),
  );
  const flat = (totalCost: number) => ({
    totalCost,
    baseTotalCost: totalCost,
    platformMarkup: 0,
  });
  spies.push(
    spyOn(flatPricing, "calculateTTSCostFromCatalog").mockResolvedValue(
      flat(0.02) as Awaited<
        ReturnType<typeof flatPricing.calculateTTSCostFromCatalog>
      >,
    ),
  );
  spies.push(
    spyOn(flatPricing, "calculateSTTCostFromCatalog").mockResolvedValue(
      flat(0.03) as Awaited<
        ReturnType<typeof flatPricing.calculateSTTCostFromCatalog>
      >,
    ),
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
    const host = new URL(url).hostname;
    if (!PROVIDER_HOSTS.has(host)) return realFetch(input, init);
    providerCalls += 1;
    atProvider = { ...counts };
    firstLineLookupsAtProvider = firstLineLookups;
    providerAuthorization = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).get("authorization");
    if (host === "api.openai.com")
      return Response.json({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.25, 0.5] }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 3, total_tokens: 3 },
      });
    if (host === "api.cartesia.ai")
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    if (host === "api.deepgram.com")
      return Response.json({
        metadata: { duration: 1 },
        results: {
          channels: [
            {
              alternatives: [{ transcript: "hello", confidence: 1, words: [] }],
            },
          ],
          utterances: [],
        },
      });
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
  providerAuthorization = null;
  firstLineLookups = 0;
  firstLineLookupsAtProvider = 0;
  gateReply = undefined;
  gateHeld = false;
  debitedBalanceUsd = 9.99;
  authContext.__clearInferenceApiKeyHydrations();
  snapshots.resetInferenceAdmissionMemoryCacheForTests();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const spy of spies) spy.mockRestore();
  await closeDatabaseConnectionsForTests();
});

for (const stream of [true, false]) {
  test(`a warm ${stream ? "streamed" : "buffered"} request reaches the provider after cached auth and durable admission`, async () => {
    const key = newKey();
    await seedEntry(key, snapshot());
    const call = await chat(key.rawKey, stream);
    expect(call.response.status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(call.beforeProvider).toEqual({
      cacheReads: 1,
      gateCalls: 3,
      primary: 0,
    });
    await finish(call);
    // Revocation, shared limits and a recoverable lease precede provider work;
    // accounting fences and settles that same durable owner after the response.
    expect(gatePaths).toEqual([
      "/credential/check",
      "/rate-limit",
      "/lease-dispatched-authorized",
      "/settlement-fence",
      "/settle",
    ]);
  });
}

test("a billing hold in the entry is refused with 402 before provider dispatch", async () => {
  const key = newKey();
  await seedEntry(key, snapshot({ billingHold: true }));
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(402);
  expect((await call.response.json()) as unknown).toMatchObject({
    error: { type: "insufficient_quota", code: "billing_hold_active" },
  });
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse.gateCalls).toBe(2);
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
  expect(call.beforeResponse.gateCalls).toBe(2);
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
  expect(call.beforeResponse.gateCalls).toBe(2);
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

test("an entry with less credit than the request's estimate is refused before the provider", async () => {
  const key = newKey();
  // The request is estimated at $0.01; the entry holds half of that.
  await seedEntry(
    key,
    snapshot({
      balance: {
        balanceUsd: 0.005,
        balanceAt: Date.now(),
        balanceRevision: "1",
      },
    }),
  );
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(402);
  expect((await call.response.json()) as unknown).toMatchObject({
    error: { type: "insufficient_quota", code: "insufficient_credits" },
  });
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse).toEqual({
    cacheReads: 1,
    gateCalls: 2,
    primary: 0,
  });
});

for (const stream of [true, false]) {
  test(`a ${stream ? "streamed" : "buffered"} request whose settlement empties the balance rewrites its cached entry, and the next request is refused from it`, async () => {
    const key = newKey();
    await seedPrimaryKey(key);
    await seedEntry(key, snapshot());
    debitedBalanceUsd = 0;
    const call = await chat(key.rawKey, stream);
    expect(call.response.status).toBe(200);
    expect(call.beforeProvider).toEqual({
      cacheReads: 1,
      gateCalls: 3,
      primary: 0,
    });
    await finish(call);
    // The rewrite read the primary; it ran only after the response.
    expect(counts.primary).toBeGreaterThan(0);
    // The entry itself now carries the primary's state: no credit left.
    expect(await readEntry(key)).toMatchObject({
      orgId: ORG,
      apiKeyId: key.id,
      keyHash: key.keyHash,
      admission: { billingHold: false, balance: { balanceUsd: 0 } },
    });

    // The next request, in an isolate with no memory of the first, is
    // refused from its single read of that entry.
    snapshots.resetInferenceAdmissionMemoryCacheForTests();
    authContext.__clearInferenceApiKeyHydrations();
    providerCalls = 0;
    const next = await chat(key.rawKey, stream);
    expect(next.response.status).toBe(402);
    expect((await next.response.json()) as unknown).toMatchObject({
      error: { type: "insufficient_quota", code: "insufficient_credits" },
    });
    expect(providerCalls).toBe(0);
    expect(next.beforeResponse).toEqual({
      cacheReads: 1,
      gateCalls: 2,
      primary: 0,
    });
  });
}

const AUTH_AND_RATE = { cacheReads: 1, gateCalls: 2, primary: 0 };
const AUTH_RATE_AND_LEASE = { cacheReads: 1, gateCalls: 3, primary: 0 };

const embed = (rawKey: string) =>
  route("embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
  });

test("a warm embeddings request reaches the provider after cached auth and durable admission", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const call = await embed(key.rawKey);
  expect(call.response.status).toBe(200);
  expect(providerCalls).toBe(1);
  expect(call.beforeProvider).toEqual(AUTH_RATE_AND_LEASE);
  await finish(call);
});

test("embeddings refuse with the same funding codes as chat", async () => {
  const resetsAt = "2030-01-01T00:00:00.000Z";
  const base = snapshot();
  const refusals: Array<[Partial<Snapshot>, Record<string, unknown>]> = [
    [{ billingHold: true }, { code: "billing_hold_active" }],
    [
      {
        authority: { ...base.authority, effectiveUntil: resetsAt },
        subscriptionFunded: true,
        funding: { balanceUsd: 0, balanceRevision: "1" },
      },
      { code: "allowance_exhausted", resetsAt },
    ],
    [
      {
        balance: { balanceUsd: 0, balanceAt: Date.now(), balanceRevision: "1" },
      },
      { code: "insufficient_credits" },
    ],
  ];
  for (const [state, refusal] of refusals) {
    const key = newKey();
    await seedEntry(key, snapshot(state));
    const call = await embed(key.rawKey);
    expect(call.response.status).toBe(402);
    expect((await call.response.json()) as unknown).toMatchObject({
      error: { type: "insufficient_quota", ...refusal },
    });
    expect(providerCalls).toBe(0);
    expect(call.beforeResponse).toEqual(AUTH_AND_RATE);
  }
});

const speak = (
  rawKey: string,
  text = "The first sentence is spoken. The second one follows it.",
) =>
  route("tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

test("a warm text-to-speech request reaches the provider after cached auth and durable admission", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const call = await speak(key.rawKey);
  expect(call.response.status).toBe(200);
  expect(providerCalls).toBe(1);
  expect(call.beforeProvider).toEqual(AUTH_RATE_AND_LEASE);
  // Two sentences are never served from the first-line audio cache.
  expect(firstLineLookupsAtProvider).toBe(0);
  await finish(call);
});

test("text-to-speech of one short sentence adds exactly one first-line audio lookup, with durable admission and no primary read", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const call = await speak(key.rawKey, "Got it.");
  expect(call.response.status).toBe(200);
  expect(providerCalls).toBe(1);
  expect(call.beforeProvider).toEqual(AUTH_RATE_AND_LEASE);
  expect(firstLineLookupsAtProvider).toBe(1);
  await finish(call);
});

test("text-to-speech refuses an exhausted allowance in the shape clients parse", async () => {
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
  const call = await speak(key.rawKey);
  expect(call.response.status).toBe(402);
  expect((await call.response.json()) as unknown).toMatchObject({
    error: {
      type: "insufficient_quota",
      code: "allowance_exhausted",
      resetsAt,
    },
    required: 0.02,
  });
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse).toEqual(AUTH_AND_RATE);
});

const transcribe = (rawKey: string) => {
  const form = new FormData();
  form.set("audio", wavFile());
  return route("stt", {
    method: "POST",
    headers: { Authorization: `Bearer ${rawKey}` },
    body: form,
  });
};

test("a warm speech-to-text request reaches the provider after cached auth and durable admission", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const call = await transcribe(key.rawKey);
  expect(call.response.status).toBe(200);
  expect(providerCalls).toBe(1);
  expect(call.beforeProvider).toEqual(AUTH_RATE_AND_LEASE);
  await finish(call);
});

test("speech-to-text refuses a billing hold in the shape clients parse", async () => {
  const key = newKey();
  await seedEntry(key, snapshot({ billingHold: true }));
  const call = await transcribe(key.rawKey);
  expect(call.response.status).toBe(402);
  expect((await call.response.json()) as unknown).toMatchObject({
    error: { type: "insufficient_quota", code: "billing_hold_active" },
  });
  expect(providerCalls).toBe(0);
  expect(call.beforeResponse).toEqual(AUTH_AND_RATE);
});

test("the warm-up route checks durable credential standing without a primary read", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const call = await route("warm", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.rawKey}` },
  });
  expect(call.response.status).toBe(202);
  expect(call.beforeResponse).toEqual(AUTH_AND_RATE);
  await finish(call);
  // Its gate publication ran, after the response.
  expect(counts.gateCalls).toBeGreaterThan(0);
});

test("a refused pre-provider lease never invokes or debits the provider", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const debits = (
    fastPath.debitInferenceCost as unknown as {
      mock: { calls: unknown[] };
    }
  ).mock.calls.length;
  // A durable refusal arrives after cached identity/rate checks and before
  // provider invocation, so it cannot create a billable provider effect.
  gateReply = (path) =>
    path.startsWith("/lease-dispatched")
      ? Response.json(
          { admitted: false, availableUsd: 0, requiredUsd: 1 },
          { status: 402 },
        )
      : undefined;
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(402);
  expect(providerCalls).toBe(0);
  await finish(call);
  expect(
    (fastPath.debitInferenceCost as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length,
  ).toBe(debits);
});

test("a credential revoked between cached auth and durable dispatch cannot invoke the provider", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  gateReply = (path) =>
    path === "/lease-dispatched-authorized"
      ? Response.json(
          { allowed: false, reason: "credential_revoked" },
          { status: 403 },
        )
      : undefined;
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(401);
  expect(providerCalls).toBe(0);
  expect(gatePaths).toContain("/lease-dispatched-authorized");
  await finish(call);
});

test("an unavailable durable dispatch cannot invoke the provider", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  gateReply = (path) =>
    path === "/lease-dispatched-authorized"
      ? new Response("unavailable", { status: 503 })
      : undefined;
  const call = await chat(key.rawKey);
  expect(call.response.status).toBe(503);
  expect(providerCalls).toBe(0);
  expect(
    gatePaths.filter((path) => path === "/lease-dispatched-authorized"),
  ).toHaveLength(3);
  await finish(call);
});

test("a warm request on the pooled-credential lane reaches the provider after cached auth and durable credential/rate checks", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const registry = teamPool.getTeamPoolRegistry();
  const pooled = [
    spyOn(registry, "selectCredentialCacheOnly").mockResolvedValue({
      kind: "ready",
      credential: {
        credentialId: crypto.randomUUID(),
        providerId: "cerebras-api",
        envKey: "CEREBRAS_API_KEY",
        apiKey: "pooled-team-key-for-single-store-call-test",
        label: "Team pool",
      },
    }),
  ];
  try {
    for (const stream of [true, false]) {
      providerCalls = 0;
      const call = await chat(key.rawKey, stream);
      expect(call.response.status).toBe(200);
      // This lane performs durable credential/rate checks but does not create
      // a funding lease because it uses the team's own provider credential.
      expect(call.beforeResponse).toEqual(AUTH_RATE_AND_LEASE);
      await finish(call);
      expect(providerCalls).toBe(1);
      // The team's own credential made the provider call.
      expect(providerAuthorization).toBe(
        "Bearer pooled-team-key-for-single-store-call-test",
      );
      // No organization funding lease exists for this lane.
      expect(gatePaths).toEqual([
        "/credential/check",
        "/rate-limit",
        "/credential/check",
      ]);
    }
  } finally {
    for (const spy of pooled) spy.mockRestore();
  }
});

const AGED = 120_000;

for (const [reason, status, body] of [
  ["credential_revoked", 401, { kind: "rejected" }],
  ["subject_moderation_disabled", 403, { kind: "suspended" }],
] as const) {
  test(`a gate fence (${reason}) refuses the current request and rewrites the entry while the primary still allows the key`, async () => {
    const key = newKey();
    await seedPrimaryKey(key);
    await seedEntry(key, snapshot(), { cachedAt: Date.now() - AGED });
    // Only the gate knows: a revoke that fenced the gate and then failed its
    // primary write. The key's row is still active.
    gateReply = (path) =>
      path === "/credential/check"
        ? Response.json({ allowed: false, reason }, { status: 403 })
        : undefined;
    const stale = await chat(key.rawKey);
    // The primary still allows the key, but the durable fence stops this request.
    expect(stale.response.status).toBe(status);
    expect(stale.beforeProvider).toBeUndefined();
    expect(stale.beforeResponse.gateCalls).toBe(1);
    expect(providerCalls).toBe(0);
    await finish(stale);
    expect(gatePaths).toContain("/credential/check");
    expect(await readEntry(key)).toMatchObject({
      decision: body.kind,
      status,
    });

    // A later request, in an isolate with no memory of the first and with the
    // fence still in place, is refused from its single read of that entry.
    authContext.__clearInferenceApiKeyHydrations();
    providerCalls = 0;
    const next = await chat(key.rawKey);
    expect(next.response.status).toBe(status);
    expect(providerCalls).toBe(0);
    expect(next.beforeResponse).toEqual({
      cacheReads: 1,
      gateCalls: 0,
      primary: 0,
    });
  });
}

/** The caller resolution of a route outside the inference hot path. */
async function resolveOrdinaryRouteCaller(rawKey: string): Promise<{
  caller?: unknown;
  error?: unknown;
  gateCallsBeforeReturn: number;
}> {
  let caller: unknown;
  let error: unknown;
  const call = await serve(async (executionCtx) => {
    const request = new Request("https://api.eliza.app/api/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    const store = new Map<string, unknown>();
    // The gate is the one store this resolution may await besides the entry.
    gateHeld = false;
    try {
      caller = await requireGenerativeRouteCaller(
        {
          req: { raw: request, url: request.url },
          env: {},
          executionCtx,
          get: (name: string) => store.get(name),
          set: (name: string, value: unknown) => store.set(name, value),
        } as unknown as Parameters<typeof requireGenerativeRouteCaller>[0],
        { compatibility: "raw" },
      );
    } catch (caught) {
      error = caught;
    }
    return new Response(null);
  });
  return {
    caller,
    error,
    gateCallsBeforeReturn: call.beforeResponse.gateCalls,
  };
}

test("a route outside the inference hot path checks the gate's fences on a warm key and refuses a revoked one at once", async () => {
  const key = newKey();
  await seedEntry(key, snapshot());
  const allowed = await resolveOrdinaryRouteCaller(key.rawKey);
  expect(allowed.error).toBeUndefined();
  expect(allowed.caller).toMatchObject({
    apiKeyId: key.id,
    authSource: "combined_cache",
  });
  expect(allowed.gateCallsBeforeReturn).toBe(1);
  expect(gatePaths).toEqual(["/credential/check"]);

  // The key is revoked at the gate; its cached entry is still positive.
  gateReply = (path) =>
    path === "/credential/check"
      ? Response.json(
          { allowed: false, reason: "credential_revoked" },
          { status: 403 },
        )
      : undefined;
  const revoked = await resolveOrdinaryRouteCaller(key.rawKey);
  expect(revoked.caller).toBeUndefined();
  expect(revoked.error).toMatchObject({ status: 401 });
});

test("a signed-in session whose settlement empties the balance rewrites its cached decision, and the next request is refused from it", async () => {
  const SUBJECT = "subject_single_store";
  const verified = spyOn(
    stewardClient,
    "verifyStewardTokenCached",
  ).mockResolvedValue({
    userId: SUBJECT,
    issuedAt: Math.floor(Date.now() / 1000),
  } as Awaited<ReturnType<typeof stewardClient.verifyStewardTokenCached>>);
  const sessionToken = "header.payload.signature";
  const readDecision = () =>
    authCache.readInferenceSessionAuthDecision(SUBJECT);
  // A session is checked against the gate on every request, before the provider.
  gateHeld = false;
  try {
    // Seeded as stored, with credit the primary no longer has: the write
    // path would replace the snapshot with the primary's own.
    const seeded = await cache.setWithOutcome(
      CacheKeys.inference.sessionAuthContext(
        createHash("sha256").update(SUBJECT).digest("hex"),
      ),
      {
        v: authCache.INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: USER,
        orgId: ORG,
        apiKeyId: null,
        stewardUserId: SUBJECT,
        admission: snapshot(),
      },
      CacheTTL.inference.authContext,
      { keyClass: "inference_auth" },
    );
    expect(seeded.kind).toBe("written");
    expect(await readDecision()).toMatchObject({
      stewardUserId: SUBJECT,
      admission: { balance: { balanceUsd: 10 } },
    });
    debitedBalanceUsd = 0;
    const call = await chat(sessionToken);
    expect(call.response.status).toBe(200);
    expect(providerCalls).toBe(1);
    await finish(call);
    // The decision itself now carries the primary's state: no credit left.
    expect(await readDecision()).toMatchObject({
      userId: USER,
      orgId: ORG,
      admission: { billingHold: false, balance: { balanceUsd: 0 } },
    });

    // Another isolate, with no memory of the first, refuses from the entry.
    snapshots.resetInferenceAdmissionMemoryCacheForTests();
    providerCalls = 0;
    const next = await chat(sessionToken);
    expect(next.response.status).toBe(402);
    expect((await next.response.json()) as unknown).toMatchObject({
      error: { type: "insufficient_quota", code: "insufficient_credits" },
    });
    expect(providerCalls).toBe(0);
    await Promise.allSettled(next.background);
  } finally {
    verified.mockRestore();
  }
});
