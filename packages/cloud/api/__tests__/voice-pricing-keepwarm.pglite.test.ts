/**
 * The shared keep-warm cron writes the voice routes' catalog prices to the
 * Worker cache with the key and TTL the cache-only routes read. A cold serving
 * isolate then prices its first TTS or STT call from that entry: one Worker
 * cache read, no catalog read and no warming 503. The agent pricing prewarm
 * does the same for its token-rate key.
 *
 * Real cron route, real pricing cache and catalog lookup over
 * `ai_pricing_entries` rows on PGlite, and the in-memory Worker cache backend.
 * The agent sweep sees an empty activity window; its agent and kernel legs are
 * replaced because they do not price.
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
  calculateSTTCostFromCatalog,
  calculateTTSCostFromCatalog,
} from "@elizaos/cloud-shared/lib/services/ai-pricing";
import { __clearPersistedPricingCache } from "@elizaos/cloud-shared/lib/services/ai-pricing/cache";
import { ELEVENLABS_SNAPSHOT_PRICING } from "@elizaos/cloud-shared/lib/services/ai-pricing-definitions";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.CACHE_BACKEND = "memory";
setDefaultTimeout(60_000);

const CRON_SECRET = "keepwarm-test-secret";
/** `ai_pricing` rates that differ from the ElevenLabs snapshot (0.00005/char, 0.22/hour). */
const TTS_USD_PER_CHARACTER = 0.0002;
const STT_USD_PER_HOUR = 3.6;
const TEXT_MODEL = "openai/gpt-5-mini";
const INPUT_USD_PER_TOKEN = 0.000002;
const OUTPUT_USD_PER_TOKEN = 0.000008;
/** Every ElevenLabs catalog row the TTS and STT routes can price. */
const VOICE_KEYS = ELEVENLABS_SNAPSHOT_PRICING.filter(
  (row) => row.productFamily === "tts" || row.productFamily === "stt",
).length;
const WORKER_CACHE_TTL_SECONDS = 15 * 60;

const events: string[] = [];
let catalogFailure: Error | undefined;
let kernelPrewarms = 0;

const realCatalogRead =
  aiPricingRepository.listActiveEntriesForProviderModelPairs.bind(
    aiPricingRepository,
  );
spyOn(
  aiPricingRepository,
  "listActiveEntriesForProviderModelPairs",
).mockImplementation(async (filters) => {
  events.push(`catalog:${filters.productFamily}`);
  if (catalogFailure) throw catalogFailure;
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
const cacheWrites = spyOn(cache, "setWithOutcome");
const keysWith = (prefix: string, calls: unknown[][]) =>
  calls.map(([key]) => String(key)).filter((key) => key.startsWith(prefix));
const writesWith = (prefix: string) =>
  cacheWrites.mock.calls.filter(([key]) => String(key).startsWith(prefix));

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
      ('elevenlabs','elevenlabs','elevenlabs/eleven_flash_v2_5','tts','generation','character',$1,'manual_override','https://pricing.test/tts'),
      ('elevenlabs','elevenlabs','elevenlabs/scribe_v2','stt','generation','hour',$2,'manual_override','https://pricing.test/stt'),
      ('bitrouter','openai',$3,'language','input','token',$4,'manual_override','https://pricing.test/text'),
      ('bitrouter','openai',$3,'language','output','token',$5,'manual_override','https://pricing.test/text')`,
    [
      String(TTS_USD_PER_CHARACTER),
      String(STT_USD_PER_HOUR),
      TEXT_MODEL,
      String(INPUT_USD_PER_TOKEN),
      String(OUTPUT_USD_PER_TOKEN),
    ],
  );
});

afterEach(async () => {
  // Each test starts from a cold isolate (empty L1) and a cold Worker cache.
  catalogFailure = undefined;
  setSystemTime();
  for (const key of new Set(keysWith("iac:", cacheWrites.mock.calls)))
    await cache.del(key);
  __clearPersistedPricingCache();
  events.length = 0;
  kernelPrewarms = 0;
  cacheReads.mockClear();
  cacheWrites.mockClear();
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
    data?: { voicePricingWarmed?: number; voicePricingFailed?: number };
  };
  return { status: response.status, data: body.data };
}

/** The cache options a Worker request prices with (`getGenerativePricingCacheOptions`). */
function workerRequest() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    cache: {
      cacheOnly: true,
      executionCtx: {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      },
    },
  };
}

const TEXT = "Your table is booked for seven tonight.";
const withMarkup = (baseCost: number) => baseCost * PLATFORM_MARKUP_MULTIPLIER;

/** The TTS and STT route calls, priced the way the routes do on a Worker. */
async function priceVoiceRoutes() {
  const tts = workerRequest();
  const stt = workerRequest();
  const ttsCost = await calculateTTSCostFromCatalog({
    model: "elevenlabs/eleven_flash_v2_5",
    characterCount: TEXT.length,
    cache: tts.cache,
  });
  const sttCost = await calculateSTTCostFromCatalog({
    model: "elevenlabs/scribe_v2",
    durationSeconds: 1,
    cache: stt.cache,
  });
  return {
    ttsCost: ttsCost.totalCost,
    sttCost: sttCost.totalCost,
    pending: [...tts.pending, ...stt.pending],
  };
}

test("after the keep-warm sweep a cold serving isolate prices TTS and STT from the Worker cache", async () => {
  const swept = await sweep();
  expect(swept.status).toBe(200);
  const written = writesWith("iac:flat-pricing:");
  const writtenKeys = written.map(([key]) => String(key));

  // A new isolate: empty L1, the Worker cache as the sweep left it.
  __clearPersistedPricingCache();
  events.length = 0;
  cacheReads.mockClear();
  cacheWrites.mockClear();
  // A cold key here is the warming 503 (or a join of the catalog read).
  const served = await priceVoiceRoutes();
  expect(events).toEqual([]);

  // The ai_pricing rows, not the snapshot rates.
  expect(served.ttsCost).toBeCloseTo(
    withMarkup(TTS_USD_PER_CHARACTER * TEXT.length),
    9,
  );
  expect(served.sttCost).toBeCloseTo(withMarkup(STT_USD_PER_HOUR / 3600), 9);
  // One Worker-cache read per route key, each a key the sweep wrote.
  const read = keysWith("iac:flat-pricing:", cacheReads.mock.calls);
  expect(read).toHaveLength(2);
  for (const key of read) expect(writtenKeys).toContain(key);
  // Fresh entries: no refresh under `waitUntil` and no write.
  expect(served.pending).toHaveLength(0);
  expect(writesWith("iac:flat-pricing:")).toHaveLength(0);

  // The sweep wrote every voice catalog key once, with the TTL reads use, and
  // still ran its other legs.
  expect(swept.data).toMatchObject({
    voicePricingWarmed: VOICE_KEYS,
    voicePricingFailed: 0,
  });
  expect(new Set(writtenKeys).size).toBe(VOICE_KEYS);
  for (const [, , ttlSeconds] of written)
    expect(ttlSeconds).toBe(WORKER_CACHE_TTL_SECONDS);
  expect(kernelPrewarms).toBe(1);
});

test("a sweep inside the fresh window writes nothing and later sweeps rewrite every key", async () => {
  await sweep();
  const flashKey = writesWith("iac:flat-pricing:")
    .map(([key]) => String(key))
    .find((key) => key.includes("eleven_flash_v2_5"));
  expect(flashKey).toBeDefined();

  // Same isolate, within 60 s: nothing to read or write.
  events.length = 0;
  cacheWrites.mockClear();
  expect((await sweep()).data?.voicePricingWarmed).toBe(VOICE_KEYS);
  expect(events).toEqual([]);
  expect(writesWith("iac:flat-pricing:")).toHaveLength(0);

  // A local copy from a non-Worker price read never reached the Worker cache,
  // so it does not stop the sweep from writing that key.
  __clearPersistedPricingCache();
  await cache.del(String(flashKey));
  await calculateTTSCostFromCatalog({
    model: "elevenlabs/eleven_flash_v2_5",
    characterCount: 1,
  });
  cacheWrites.mockClear();
  await sweep();
  expect(writesWith("iac:flat-pricing:").map(([key]) => key)).toContain(
    String(flashKey),
  );

  // The next cron tick (5 min) rewrites every key before the 15 min TTL ends.
  setSystemTime(new Date(Date.now() + 5 * 60_000));
  cacheWrites.mockClear();
  await sweep();
  expect(
    new Set(writesWith("iac:flat-pricing:").map(([key]) => key)).size,
  ).toBe(VOICE_KEYS);
});

test("a failed keep-warm is counted per key and the sweep still completes", async () => {
  catalogFailure = new Error("synthetic catalog failure");
  const failed = await sweep();
  expect(failed.status).toBe(200);
  expect(failed.data).toMatchObject({
    voicePricingWarmed: 0,
    voicePricingFailed: VOICE_KEYS,
  });
  expect(kernelPrewarms).toBe(1);
  expect(writesWith("iac:flat-pricing:")).toHaveLength(0);

  // A Worker-cache write that is not durable is a failed key, not a warm one.
  catalogFailure = undefined;
  cacheWrites.mockImplementationOnce(async () => ({
    kind: "error",
    backend: "memory",
  }));
  expect((await sweep()).data).toMatchObject({
    voicePricingWarmed: VOICE_KEYS - 1,
    voicePricingFailed: 1,
  });

  // The next sweep warms every key and a cold isolate prices from the cache.
  setSystemTime(new Date(Date.now() + 5 * 60_000));
  expect((await sweep()).data).toMatchObject({
    voicePricingWarmed: VOICE_KEYS,
    voicePricingFailed: 0,
  });
  __clearPersistedPricingCache();
  events.length = 0;
  const served = await priceVoiceRoutes();
  expect(events).toEqual([]);
  expect(served.ttsCost).toBeCloseTo(
    withMarkup(TTS_USD_PER_CHARACTER * TEXT.length),
    9,
  );
});

test("the agent pricing prewarm writes the token-rate key a cold turn reads", async () => {
  const model = normalizeModelName(TEXT_MODEL);
  const provider = getProviderFromModel(TEXT_MODEL);
  // The exact call the shared-agent and voice-session prewarm legs make.
  await calculateCost(model, provider, 1, 1, "bitrouter", {
    warmWorkerCache: true,
  });
  const written = writesWith("iac:pricing:");

  // A new isolate prices a turn (input and output tokens) from the Worker
  // cache; a cold key here is the warming 503.
  __clearPersistedPricingCache();
  events.length = 0;
  cacheReads.mockClear();
  const turn = workerRequest();
  const tokens = 1_000_000;
  const cost = await calculateCost(
    model,
    provider,
    tokens,
    tokens,
    "bitrouter",
    turn.cache,
  );
  expect(events).toEqual([]);
  expect(cost.inputCost).toBeCloseTo(
    withMarkup(INPUT_USD_PER_TOKEN * tokens),
    6,
  );
  expect(cost.outputCost).toBeCloseTo(
    withMarkup(OUTPUT_USD_PER_TOKEN * tokens),
    6,
  );
  expect(turn.pending).toHaveLength(0);
  // The prewarm wrote that key once, with the TTL reads use.
  expect(written).toHaveLength(1);
  expect(written[0][2]).toBe(WORKER_CACHE_TTL_SECONDS);
  expect(keysWith("iac:pricing:", cacheReads.mock.calls)).toEqual([
    String(written[0][0]),
  ]);
});
