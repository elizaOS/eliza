/**
 * The shared keep-warm cron writes the voice routes' catalog prices to the
 * Worker cache with the key and TTL the cache-only routes read. A cold serving
 * isolate then prices its first TTS or STT call from that entry: one Worker
 * cache read, no catalog read and no warming 503. The voice step runs after
 * the other legs with a deadline per key, so a stuck read delays only itself.
 *
 * Real cron route, real pricing cache and catalog lookup over
 * `ai_pricing_entries` rows on PGlite, and the in-memory Worker cache backend.
 * The agent sweep sees an empty activity window unless a test fills it; its
 * agent, room and kernel legs are replaced because they do not price.
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
import { randomUUID } from "node:crypto";
import { agentSandboxesRepository } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import { aiPricingRepository } from "@elizaos/cloud-shared/db/repositories/ai-pricing";
import { sharedRuntimeHistoryRepository } from "@elizaos/cloud-shared/db/repositories/shared-runtime-history";
import { cache } from "@elizaos/cloud-shared/lib/cache/client";
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
/** Every ElevenLabs catalog row the TTS and STT routes can price. */
const VOICE_KEYS = ELEVENLABS_SNAPSHOT_PRICING.filter(
  (row) => row.productFamily === "tts" || row.productFamily === "stt",
).length;
const WORKER_CACHE_TTL_SECONDS = 15 * 60;

const events: string[] = [];
let catalogFailure: Error | undefined;
/** Holds every catalog read for this model until released. */
let heldModel: { model: string; gate: Promise<void> } | undefined;
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
  const held = heldModel;
  if (held && filters.pairs.some(({ model }) => model.includes(held.model)))
    await held.gate;
  if (catalogFailure) throw catalogFailure;
  return realCatalogRead(filters);
});
const activeAgents = spyOn(
  sharedRuntimeHistoryRepository,
  "listRecentlyActiveAgentIds",
).mockResolvedValue([]);
const activeRooms = spyOn(
  sharedRuntimeHistoryRepository,
  "listRecentlyActivePersonalRooms",
).mockResolvedValue([]);
const findAgent = spyOn(agentSandboxesRepository, "findById");
const cacheReads = spyOn(cache, "getWithOutcome");
const realCacheWrite = cache.setWithOutcome.bind(cache);
/** Every key written, kept across `mockClear` so the next test starts cold. */
const writtenKeys = new Set<string>();
const cacheWrites = spyOn(cache, "setWithOutcome").mockImplementation(
  async (...args: Parameters<typeof realCacheWrite>) => {
    writtenKeys.add(String(args[0]));
    return realCacheWrite(...args);
  },
);
const keysWith = (prefix: string, calls: unknown[][]) =>
  calls.map(([key]) => String(key)).filter((key) => key.startsWith(prefix));
const writesWith = (prefix: string) =>
  cacheWrites.mock.calls.filter(([key]) => String(key).startsWith(prefix));

mock.module(
  "@elizaos/cloud-shared/lib/services/shared-runtime/prewarm-shared-agent",
  () => ({
    prewarmPersonalSharedRoom: async () => {
      events.push("prewarm:room");
    },
    prewarmSharedAgentTurnCaches: async () => {
      events.push("prewarm:agent");
    },
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
      ('elevenlabs','elevenlabs','elevenlabs/scribe_v2','stt','generation','hour',$2,'manual_override','https://pricing.test/stt')`,
    [String(TTS_USD_PER_CHARACTER), String(STT_USD_PER_HOUR)],
  );
});

afterEach(async () => {
  // Each test starts from a cold isolate (empty L1) and a cold Worker cache.
  catalogFailure = undefined;
  heldModel = undefined;
  setSystemTime();
  for (const key of writtenKeys) await cache.del(key);
  writtenKeys.clear();
  __clearPersistedPricingCache();
  events.length = 0;
  kernelPrewarms = 0;
  cacheReads.mockClear();
  cacheWrites.mockClear();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function sweep(env: Record<string, unknown> = {}) {
  const response = await app.request(
    "http://cloud.test/api/v1/cron/shared-agent-keepwarm",
    { method: "POST", headers: { "x-cron-secret": CRON_SECRET } },
    { CRON_SECRET, NODE_ENV: "test", ...env },
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  const body = (await response.json()) as {
    data?: Record<string, number>;
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

test("a sweep on an isolate whose entries came from the Worker cache does not rewrite them", async () => {
  await sweep();

  // Another isolate serves TTS and STT from the Worker cache; then a cron tick
  // lands on it within the fresh window.
  __clearPersistedPricingCache();
  cacheReads.mockClear();
  await priceVoiceRoutes();
  const served = keysWith("iac:flat-pricing:", cacheReads.mock.calls);
  expect(served).toHaveLength(2);
  events.length = 0;
  cacheWrites.mockClear();
  const swept = await sweep();

  // Only the keys this isolate has not read are read and written.
  expect(swept.data).toMatchObject({
    voicePricingWarmed: VOICE_KEYS,
    voicePricingFailed: 0,
  });
  expect(events).toHaveLength(VOICE_KEYS - 2);
  const written = writesWith("iac:flat-pricing:").map(([key]) => String(key));
  expect(written).toHaveLength(VOICE_KEYS - 2);
  for (const key of served) expect(written).not.toContain(key);
});

test("a stuck voice pricing read delays only the voice step", async () => {
  // A cold serving request on the cron's isolate starts a catalog read that
  // does not finish.
  let release: (() => void) | undefined;
  heldModel = {
    model: "eleven_flash_v2_5",
    gate: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const serving = workerRequest();
  await calculateTTSCostFromCatalog({
    model: "elevenlabs/eleven_flash_v2_5",
    characterCount: TEXT.length,
    cache: serving.cache,
  }).catch(() => undefined);

  const agentId = randomUUID();
  activeAgents.mockResolvedValueOnce([agentId]);
  findAgent.mockResolvedValueOnce({ id: agentId } as never);
  activeRooms.mockResolvedValueOnce([
    {
      agentId: "personal:6f1c2a3b-1d2e-5f3a-8b4c-0123456789ab",
      channelId: randomUUID(),
    },
  ]);
  events.length = 0;
  const startedAt = performance.now();
  const swept = await Promise.race([
    sweep({ SHARED_RUNTIME_CONVERSATIONS: {} }),
    Bun.sleep(5_000).then(() => undefined),
  ]);
  const sweepMs = performance.now() - startedAt;
  release?.();
  await Promise.allSettled(serving.pending);

  expect(swept?.status).toBe(200);
  // Every other leg ran before the first voice catalog read.
  expect(events.slice(0, 2)).toEqual(["prewarm:agent", "prewarm:room"]);
  expect(kernelPrewarms).toBe(1);
  // The stuck key cost the sweep its deadline; the other keys warmed.
  expect(swept?.data).toMatchObject({
    warmed: 1,
    personalRoomsWarmed: 1,
    voicePricingWarmed: VOICE_KEYS - 1,
    voicePricingFailed: 1,
  });
  expect(sweepMs).toBeLessThan(3_000);
  // The read was not cancelled: once it finishes, its entry is in the cache.
  const flashKey = writesWith("iac:flat-pricing:")
    .map(([key]) => String(key))
    .find((key) => key.includes("eleven_flash_v2_5"));
  expect((await cache.getWithOutcome(String(flashKey))).kind).toBe("hit");
});
