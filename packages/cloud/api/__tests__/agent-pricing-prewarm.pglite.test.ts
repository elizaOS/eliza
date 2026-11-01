/**
 * The shared-agent and voice-session prewarm legs write the token-rate key the
 * cache-only turn reads to the Worker cache, with the TTL those reads use. A
 * cold serving isolate then prices the agent's first turn from that entry: one
 * Worker-cache read, no catalog read and no warming 503. A leg that runs on an
 * isolate whose fresh rates came from the Worker cache reads and writes
 * nothing.
 *
 * Real prewarm legs, real pricing cache and catalog lookup over
 * `ai_pricing_entries` rows on PGlite, and the in-memory Worker cache backend.
 * The admission legs are replaced because they do not price.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { aiPricingRepository } from "@elizaos/cloud-shared/db/repositories/ai-pricing";
import { cache } from "@elizaos/cloud-shared/lib/cache/client";
import {
  calculateCost,
  getProviderFromModel,
  normalizeModelName,
} from "@elizaos/cloud-shared/lib/pricing";
import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/cloud-shared/lib/pricing-constants";
import { __clearPersistedPricingCache } from "@elizaos/cloud-shared/lib/services/ai-pricing/cache";
import * as admissionGate from "@elizaos/cloud-shared/lib/services/inference-admission-gate";
import * as admissionSnapshot from "@elizaos/cloud-shared/lib/services/inference-admission-snapshot";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.CACHE_BACKEND = "memory";
// The shared turn only prices a model whose provider is configured.
process.env.OPENAI_API_KEY = "test-openai-key";
setDefaultTimeout(60_000);

const TEXT_MODEL = "openai/gpt-5-mini";
const INPUT_USD_PER_TOKEN = 0.000002;
const OUTPUT_USD_PER_TOKEN = 0.000008;
const WORKER_CACHE_TTL_SECONDS = 15 * 60;

const events: string[] = [];
const realCatalogRead =
  aiPricingRepository.listActiveEntriesForProviderModelPairs.bind(
    aiPricingRepository,
  );
spyOn(
  aiPricingRepository,
  "listActiveEntriesForProviderModelPairs",
).mockImplementation(async (filters) => {
  events.push(`catalog:${filters.productFamily}`);
  return realCatalogRead(filters);
});
const cacheReads = spyOn(cache, "getWithOutcome");
const cacheWrites = spyOn(cache, "setWithOutcome");
const rateKeys = (calls: unknown[][]) =>
  calls
    .map(([key]) => String(key))
    .filter((key) => key.startsWith("iac:pricing:"));
const rateWrites = () =>
  cacheWrites.mock.calls.filter(([key]) =>
    String(key).startsWith("iac:pricing:"),
  );

mock.module(
  "@elizaos/cloud-shared/lib/services/inference-admission-gate",
  () => ({
    ...admissionGate,
    warmInferenceAdmissionGate: async () => undefined,
    warmInferenceRateLimitGate: async () => undefined,
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/inference-admission-snapshot",
  () => ({
    ...admissionSnapshot,
    warmInferenceAdmissionSnapshot: async () => undefined,
  }),
);

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { aiPricingEntries } = await import("@elizaos/cloud-shared/db/schemas");
const { prewarmSharedAgentTurnCaches } = await import(
  "@elizaos/cloud-shared/lib/services/shared-runtime/prewarm-shared-agent"
);
const { hydrateVoiceSharedAgentScope } = await import(
  "../v1/voice/session/lib/voice-agent-scope-hydration"
);

const organizationId = randomUUID();
const userId = randomUUID();
const agentId = randomUUID();
const agent = {
  id: agentId,
  organization_id: organizationId,
  user_id: userId,
  execution_tier: "shared",
  character_id: null,
  agent_name: "Pricing prewarm agent",
  agent_config: { model: TEXT_MODEL },
};

/** The leg agent create and the keep-warm cron run for a shared agent. */
const warmSharedAgent = () =>
  prewarmSharedAgentTurnCaches(
    agent as unknown as Parameters<typeof prewarmSharedAgentTurnCaches>[0],
  );

/** The background hydration a cold realtime voice turn schedules. */
const warmVoiceSession = () =>
  hydrateVoiceSharedAgentScope(
    { VOICE_REALTIME_ELIZA_MODEL: TEXT_MODEL } as unknown as Parameters<
      typeof hydrateVoiceSharedAgentScope
    >[0],
    { agentId, conversationId: randomUUID(), organizationId, userId },
    agent as unknown as Parameters<typeof hydrateVoiceSharedAgentScope>[2],
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
      ('bitrouter','openai',$1,'language','input','token',$2,'manual_override','https://pricing.test/text'),
      ('bitrouter','openai',$1,'language','output','token',$3,'manual_override','https://pricing.test/text')`,
    [TEXT_MODEL, String(INPUT_USD_PER_TOKEN), String(OUTPUT_USD_PER_TOKEN)],
  );
});

afterEach(async () => {
  // Each test starts from a cold isolate (empty L1) and a cold Worker cache.
  for (const key of new Set(rateKeys(cacheWrites.mock.calls)))
    await cache.del(key);
  __clearPersistedPricingCache();
  events.length = 0;
  cacheReads.mockClear();
  cacheWrites.mockClear();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

const withMarkup = (baseCost: number) => baseCost * PLATFORM_MARKUP_MULTIPLIER;

/** A new isolate prices a turn the way the cache-only turn does on a Worker. */
async function priceColdTurn() {
  __clearPersistedPricingCache();
  events.length = 0;
  cacheReads.mockClear();
  const pending: Promise<unknown>[] = [];
  const tokens = 1_000_000;
  const cost = await calculateCost(
    normalizeModelName(TEXT_MODEL),
    getProviderFromModel(TEXT_MODEL),
    tokens,
    tokens,
    "bitrouter",
    {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => pending.push(promise) },
    },
  );
  // A cold key here is the warming 503, and no catalog read.
  expect(events).toEqual([]);
  expect(cost.inputCost).toBeCloseTo(
    withMarkup(INPUT_USD_PER_TOKEN * tokens),
    6,
  );
  expect(cost.outputCost).toBeCloseTo(
    withMarkup(OUTPUT_USD_PER_TOKEN * tokens),
    6,
  );
  // A fresh entry: no refresh under `waitUntil`.
  expect(pending).toHaveLength(0);
  return rateKeys(cacheReads.mock.calls);
}

for (const [leg, warm] of [
  ["shared-agent prewarm", warmSharedAgent],
  ["voice-session hydration", warmVoiceSession],
] as const) {
  test(`the ${leg} writes the token-rate key a cold turn reads`, async () => {
    await warm();
    const written = rateWrites();
    expect(written).toHaveLength(1);
    expect(written[0][2]).toBe(WORKER_CACHE_TTL_SECONDS);

    expect(await priceColdTurn()).toEqual([String(written[0][0])]);
  });

  test(`the ${leg} reads and writes nothing when the fresh rates came from the Worker cache`, async () => {
    await warm();
    // Another isolate fills its local copy from the Worker cache; the leg
    // then runs there within the fresh window.
    await priceColdTurn();
    events.length = 0;
    await warm();
    expect(events).toEqual([]);
    expect(rateWrites()).toHaveLength(1);
  });
}
