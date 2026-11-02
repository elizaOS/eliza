/**
 * The shared keep-warm cron writes the default text model's inference price to
 * the Worker cache under the key the inference routes read. Without it, the
 * first chat/completions call after the 15 min entry expires is admitted from
 * a cold key and answered with the warming 503 (the resident's first voice
 * turn after an idle period). With it, a cold serving isolate prices that call
 * with one Worker-cache read, no catalog read and no 503.
 *
 * Real cron route, real pricing cache and catalog lookup over
 * `ai_pricing_entries` rows on PGlite, and the in-memory Worker cache backend.
 * The agent, room and kernel legs are replaced because they do not price.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { aiPricingRepository } from "@elizaos/cloud-shared/db/repositories/ai-pricing";
import { sharedRuntimeHistoryRepository } from "@elizaos/cloud-shared/db/repositories/shared-runtime-history";
import { cache } from "@elizaos/cloud-shared/lib/cache/client";
import {
  calculateCost,
  getProviderFromModel,
  normalizeModelName,
} from "@elizaos/cloud-shared/lib/pricing";
import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/cloud-shared/lib/pricing-constants";
import {
  canonicalizeCerebrasModelId,
  resolveAiProviderSource,
} from "@elizaos/cloud-shared/lib/providers/language-model";
import {
  __clearPersistedPricingCache,
  AiPricingCacheWarmingError,
} from "@elizaos/cloud-shared/lib/services/ai-pricing/cache";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.CACHE_BACKEND = "memory";
// The inference routes bill Cerebras-native models to the Cerebras source only
// when the Worker has a Cerebras key; a fake value selects that identity.
process.env.CEREBRAS_API_KEY = "csk-keepwarm-fixture";
setDefaultTimeout(60_000);

const CRON_SECRET = "keepwarm-test-secret";
/** `ai_pricing` rates that differ from the forced Cerebras rows. */
const INPUT_USD_PER_TOKEN = 0.000002;
const OUTPUT_USD_PER_TOKEN = 0.000003;
const TEXT_KEY_PREFIX = "iac:pricing:";
const WORKER_CACHE_TTL_SECONDS = 15 * 60;

/** Text catalog reads only; the voice leg reads its own families. */
let textCatalogReads = 0;
/**
 * While set, every Worker-cache write of a text pricing key reports this
 * outcome without writing, as the real client does: it never throws, it
 * returns "unavailable" when no backend is configured and "error" when the
 * backend rejects the write.
 */
let textWriteFailure: "unavailable" | "error" | undefined;
let kernelPrewarms = 0;

const realCatalogRead =
  aiPricingRepository.listActiveEntriesForProviderModelPairs.bind(
    aiPricingRepository,
  );
spyOn(
  aiPricingRepository,
  "listActiveEntriesForProviderModelPairs",
).mockImplementation(async (filters) => {
  if (filters.productFamily === "language") textCatalogReads++;
  return realCatalogRead(filters);
});
spyOn(
  sharedRuntimeHistoryRepository,
  "listRecentlyActiveAgentIds",
).mockResolvedValue([]);
spyOn(
  sharedRuntimeHistoryRepository,
  "listRecentlyActivePersonalRooms",
).mockResolvedValue([]);
const cacheReads = spyOn(cache, "getWithOutcome");
const realCacheWrite = cache.setWithOutcome.bind(cache);
/** Every key written, kept across `mockClear` so the next test starts cold. */
const writtenKeys = new Set<string>();
const cacheWrites = spyOn(cache, "setWithOutcome").mockImplementation(
  async (...args: Parameters<typeof realCacheWrite>) => {
    if (textWriteFailure && String(args[0]).startsWith(TEXT_KEY_PREFIX))
      return { kind: textWriteFailure, backend: "memory" as const };
    writtenKeys.add(String(args[0]));
    return realCacheWrite(...args);
  },
);
const textKeys = (calls: unknown[][]) =>
  calls
    .map(([key]) => String(key))
    .filter((key) => key.startsWith(TEXT_KEY_PREFIX));
const providerFetches = spyOn(globalThis, "fetch");

mock.module(
  "@elizaos/cloud-shared/lib/services/shared-runtime/prewarm-shared-agent",
  () => ({
    prewarmPersonalSharedRoom: async () => undefined,
    prewarmSharedAgentTurnCaches: async () => undefined,
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/shared-runtime/shared-eliza-runtime",
  () => ({
    prewarmSharedElizaRuntime: async () => {
      kernelPrewarms++;
    },
  }),
);

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { aiPricingEntries } = await import("@elizaos/cloud-shared/db/schemas");
const app = new Hono();
app.route(
  "/api/v1/cron/shared-agent-keepwarm",
  (await import("../v1/cron/shared-agent-keepwarm/route"))
    .default as unknown as Hono,
);

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ aiPricingEntries }, empty.id),
  )) {
    await getPgliteClientForTests().exec(statement.replaceAll('"public".', ""));
  }
  await getPgliteClientForTests().query(
    `INSERT INTO ai_pricing_entries(billing_source,provider,model,product_family,charge_type,unit,unit_price,source_kind,source_url) VALUES
      ('cerebras','cerebras','cerebras/qwen-3.8-27b','language','input','token',$1,'manual_override','https://pricing.test/text'),
      ('cerebras','cerebras','cerebras/qwen-3.8-27b','language','output','token',$2,'manual_override','https://pricing.test/text')`,
    [String(INPUT_USD_PER_TOKEN), String(OUTPUT_USD_PER_TOKEN)],
  );
});

afterEach(async () => {
  // Each test starts from a cold isolate (empty L1) and a cold Worker cache.
  textWriteFailure = undefined;
  setSystemTime();
  for (const key of writtenKeys) await cache.del(key);
  writtenKeys.clear();
  __clearPersistedPricingCache();
  textCatalogReads = 0;
  kernelPrewarms = 0;
  cacheReads.mockClear();
  cacheWrites.mockClear();
  providerFetches.mockClear();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function sweep() {
  const response = await app.request(
    "http://cloud.test/api/v1/cron/shared-agent-keepwarm",
    { method: "POST", headers: { "x-cron-secret": CRON_SECRET } },
    { CRON_SECRET, NODE_ENV: "test" },
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  const body = (await response.json()) as {
    data?: Record<string, number | boolean>;
  };
  return { status: response.status, data: body.data };
}

const INPUT_TOKENS = 1_200;
const OUTPUT_TOKENS = 500;

/**
 * The admission price of one chat/completions call on a Worker: the route's
 * model, provider and billing source, then `admitOrganizationInference`'s
 * cache-only `calculateCost`.
 */
async function priceChatAdmission(
  requestModel: string,
  pending: Promise<unknown>[] = [],
) {
  const model = canonicalizeCerebrasModelId(requestModel);
  const cost = await calculateCost(
    normalizeModelName(model),
    getProviderFromModel(model),
    INPUT_TOKENS,
    OUTPUT_TOKENS,
    resolveAiProviderSource(model) ?? "gateway",
    {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => pending.push(promise) },
    },
  );
  return { totalCost: cost.totalCost, pending };
}

const ROW_COST =
  (INPUT_USD_PER_TOKEN * INPUT_TOKENS + OUTPUT_USD_PER_TOKEN * OUTPUT_TOKENS) *
  PLATFORM_MARKUP_MULTIPLIER;

test("without the sweep the first call after the entry expires is the warming 503", async () => {
  const pending: Promise<unknown>[] = [];
  await expect(
    priceChatAdmission("cerebras/qwen-3.8-27b", pending),
  ).rejects.toBeInstanceOf(AiPricingCacheWarmingError);
  // The refusal schedules the hydration a retry would read.
  expect(pending).toHaveLength(1);
  await Promise.allSettled(pending);
});

test("after the sweep a cold serving isolate prices the default text model from the Worker cache", async () => {
  const swept = await sweep();
  expect(swept.status).toBe(200);
  expect(swept.data).toMatchObject({ textPricingWarmed: true });
  expect(kernelPrewarms).toBe(1);
  // One `ai_pricing` read per side (input and output, in parallel).
  expect(textCatalogReads).toBe(2);
  const written = cacheWrites.mock.calls.filter(([key]) =>
    String(key).startsWith(TEXT_KEY_PREFIX),
  );
  expect(written).toHaveLength(1);
  expect(written[0]?.[2]).toBe(WORKER_CACHE_TTL_SECONDS);
  // Pricing only: the sweep makes no provider or model call.
  expect(providerFetches).not.toHaveBeenCalled();

  // A new isolate: empty L1, the Worker cache as the sweep left it. Both model
  // spellings a resident sends resolve to the warmed key.
  for (const requestModel of ["cerebras/qwen-3.8-27b", "qwen-3.8-27b"]) {
    __clearPersistedPricingCache();
    textCatalogReads = 0;
    cacheReads.mockClear();
    cacheWrites.mockClear();
    const served = await priceChatAdmission(requestModel);
    expect(textCatalogReads).toBe(0);
    expect(textKeys(cacheReads.mock.calls)).toEqual([String(written[0]?.[0])]);
    // Fresh entry: no refresh under `waitUntil` and no write.
    expect(served.pending).toHaveLength(0);
    expect(textKeys(cacheWrites.mock.calls)).toHaveLength(0);
    // Billing is the `ai_pricing` row, the same as an authoritative read.
    expect(served.totalCost).toBeCloseTo(ROW_COST, 12);
  }
  const authoritative = await calculateCost(
    "qwen-3.8-27b",
    "cerebras",
    INPUT_TOKENS,
    OUTPUT_TOKENS,
    "cerebras",
  );
  expect(authoritative.totalCost).toBeCloseTo(ROW_COST, 12);
});

test("each cron tick keeps the key inside its TTL and a tick in the fresh window does nothing", async () => {
  await sweep();
  // Same isolate within 60 s: no catalog read and no write.
  textCatalogReads = 0;
  cacheWrites.mockClear();
  expect((await sweep()).data).toMatchObject({ textPricingWarmed: true });
  expect(textCatalogReads).toBe(0);
  expect(textKeys(cacheWrites.mock.calls)).toHaveLength(0);

  // Every 5 min tick rewrites the key, so after the first sweep's entry would
  // have expired a cold isolate still prices from the Worker cache.
  const start = Date.now();
  for (const minutes of [5, 10, 15]) {
    setSystemTime(new Date(start + minutes * 60_000));
    cacheWrites.mockClear();
    await sweep();
    expect(textKeys(cacheWrites.mock.calls)).toHaveLength(1);
  }
  setSystemTime(new Date(start + 15.5 * 60_000));
  __clearPersistedPricingCache();
  textCatalogReads = 0;
  const served = await priceChatAdmission("cerebras/qwen-3.8-27b");
  expect(textCatalogReads).toBe(0);
  expect(served.totalCost).toBeCloseTo(ROW_COST, 12);

  // With no tick for 15 min the entry expires and the route is cold again.
  setSystemTime(new Date(start + 30.5 * 60_000));
  __clearPersistedPricingCache();
  await expect(
    priceChatAdmission("cerebras/qwen-3.8-27b"),
  ).rejects.toBeInstanceOf(AiPricingCacheWarmingError);
});

test.each(["unavailable", "error"] as const)(
  "a Worker-cache write outcome of %s is a failed text keep-warm and leaves the sweep and the route as before",
  async (outcome) => {
    textWriteFailure = outcome;
    const failed = await sweep();
    expect(failed.status).toBe(200);
    expect(failed.data).toMatchObject({ textPricingWarmed: false });
    expect(failed.data?.voicePricingWarmed).toBeGreaterThan(0);
    expect(kernelPrewarms).toBe(1);
    expect(textKeys(cacheWrites.mock.calls)).toHaveLength(1);
    expect(textKeys([...writtenKeys].map((key) => [key]))).toHaveLength(0);
    // A second tick in the same isolate retries the write instead of trusting
    // the copy it could not store.
    expect((await sweep()).data).toMatchObject({ textPricingWarmed: false });
    expect(textKeys(cacheWrites.mock.calls)).toHaveLength(2);
    // A serving isolate keeps the route's retryable warming 503 for the cold key.
    __clearPersistedPricingCache();
    const pending: Promise<unknown>[] = [];
    await expect(
      priceChatAdmission("cerebras/qwen-3.8-27b", pending),
    ).rejects.toBeInstanceOf(AiPricingCacheWarmingError);
    await Promise.allSettled(pending);

    // The next tick warms it.
    textWriteFailure = undefined;
    __clearPersistedPricingCache();
    setSystemTime(new Date(Date.now() + 5 * 60_000));
    expect((await sweep()).data).toMatchObject({ textPricingWarmed: true });
    __clearPersistedPricingCache();
    const served = await priceChatAdmission("cerebras/qwen-3.8-27b");
    expect(served.totalCost).toBeCloseTo(ROW_COST, 12);
  },
);
