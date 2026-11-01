/**
 * `POST /api/v1/voice/tts` replays a credit reservation for a retried
 * `Idempotency-Key` (#16425). The key names one utterance: a second utterance
 * sent under the same key is a new paid request, while a retry of the same
 * utterance still replays. The paid lane reads the first-line cache and the
 * catalog price while moderation runs, and every gate still holds: no cached
 * audio, credit reservation or synthesis before moderation passes, and no
 * synthesis without an admitted reservation. Real credits service on PGlite;
 * auth, pricing, content safety, the ElevenLabs client, the first-line cache
 * and usage records are replaced.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import { AiPricingCacheWarmingError } from "@elizaos/cloud-shared/lib/services/ai-pricing/cache";
import * as elevenlabs from "@elizaos/cloud-shared/lib/services/elevenlabs";
import * as firstLineCache from "@elizaos/cloud-shared/lib/services/tts-first-line-cache";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

const orgId = randomUUID();
const userId = randomUUID();
const providerCalls: string[] = [];
const COST_PER_CHAR = 0.001;

/** Ordered marks from the replaced pre-synthesis steps of one request. */
const events: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timedStep = (name: string, ms: number) => async () => {
  events.push(`${name}:start`);
  await sleep(ms);
  events.push(`${name}:end`);
};
const cachedOpener = {
  bytes: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
  contentType: "audio/mpeg",
  byteSize: 4,
  hitCount: 1,
  codec: "mp3",
  scope: "global",
};
const passingGates = () => ({
  moderation: async (): Promise<unknown> => ({}),
  cacheRead: async (): Promise<typeof cachedOpener | null> => null,
  priceRead: async (): Promise<void> => undefined,
  costPerChar: COST_PER_CHAR,
});
let gates = passingGates();
afterEach(() => {
  gates = passingGates();
  events.length = 0;
});

const admitFlatGenerativeOperation =
  generativeRouteAuth.admitFlatGenerativeOperation;
mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => ({
    user: { id: userId, organization_id: orgId },
    apiKeyId: null,
    admissionSnapshot: undefined,
    credential: undefined,
  }),
  admitFlatGenerativeOperation: (
    params: Parameters<typeof admitFlatGenerativeOperation>[0],
  ) => {
    events.push("admission");
    return admitFlatGenerativeOperation(params);
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse: () => gates.moderation() },
}));
mock.module("@elizaos/cloud-shared/lib/services/ai-pricing", () => ({
  ...aiPricing,
  calculateTTSCostFromCatalog: async ({
    characterCount,
  }: {
    characterCount: number;
  }) => {
    await gates.priceRead();
    return {
      totalCost: characterCount * gates.costPerChar,
      baseTotalCost: characterCount * gates.costPerChar * 0.8,
      platformMarkup: characterCount * gates.costPerChar * 0.2,
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/elevenlabs", () => ({
  ...elevenlabs,
  getElevenLabsService: () => ({
    textToSpeech: async ({ text }: { text: string }) => {
      events.push("synthesis");
      providerCalls.push(text);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0x00]));
          controller.close();
        },
      });
    },
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/tts-first-line-cache", () => ({
  ...firstLineCache,
  getCloudFirstLineCacheService: () => ({
    get: () => gates.cacheRead(),
    put: async () => undefined,
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/usage", () => ({
  usageService: { create: async () => ({}) },
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const {
  organizations,
  users,
  creditTransactions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
  orgRateLimitOverrides,
  organizationConfig,
  orgStorageQuota,
  organizationEntitlements,
  organizationPaymentReversalHolds,
  autoTopUpAttempts,
} = await import("@elizaos/cloud-shared/db/schemas");
const { default: ttsRoute } = await import("../v1/voice/tts/route");

const pg = () => getPgliteClientForTests();
const SEEDED_TABLES = new Set([
  "organizations",
  "users",
  "credit_transactions",
  "billing_subscriptions",
  "organization_subscription_authorities",
  "org_rate_limit_overrides",
  "organization_config",
  "org_storage_quota",
  "organization_entitlements",
  "organization_payment_reversal_holds",
  "auto_top_up_attempts",
]);
const app = new Hono();
app.route("/api/v1/voice/tts", ttsRoute);

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        organizations,
        users,
        creditTransactions,
        billingSubscriptions,
        organizationSubscriptionAuthorities,
        orgRateLimitOverrides,
        organizationConfig,
        orgStorageQuota,
        organizationPaymentReversalHolds,
        autoTopUpAttempts,
      },
      empty.id,
    ),
  )) {
    // Keys into tables outside this slice of the schema are not created.
    const foreignKey = statement.match(/REFERENCES "([a-z_]+)"/);
    if (foreignKey && !SEEDED_TABLES.has(foreignKey[1])) continue;
    await pg().exec(statement.replaceAll('"public".', ""));
  }
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  await pg().exec(
    `CREATE TABLE organization_entitlements (${getTableConfig(
      organizationEntitlements,
    )
      .columns.map((column) => `"${column.name}" ${column.getSQLType()}`)
      .join(",")})`,
  );
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Speaker',$2,'10')",
    [orgId, `speaker-${orgId}`],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [userId, orgId, `subject_${userId}`],
  );
  await pg().query(
    "INSERT INTO organization_subscription_authorities(organization_id,state,policy_generation) VALUES ($1,'none',1)",
    [orgId],
  );
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

function post(
  text: string,
  idempotencyKey: string,
  identity: { voiceId?: string; modelId?: string } = {},
) {
  return app.request(
    "/api/v1/voice/tts",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ text, ...identity }),
    },
    { NODE_ENV: "test" },
  );
}

async function speak(
  text: string,
  idempotencyKey: string,
  identity: { voiceId?: string; modelId?: string } = {},
) {
  const response = await post(text, idempotencyKey, identity);
  if (response.status !== 200)
    throw new Error(`tts ${response.status}: ${await response.text()}`);
  await response.arrayBuffer();
  // Settlement runs after the audio response; wait for every reservation to settle.
  for (let i = 0; i < 200; i++) {
    const { rows } = await pg().query<{ open: string }>(
      "SELECT count(*)::text AS open FROM credit_transactions WHERE organization_id=$1 AND settled_at IS NULL",
      [orgId],
    );
    if (rows[0]?.open === "0") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function balance(): Promise<number> {
  const { rows } = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [orgId],
  );
  return Number(rows[0]?.credit_balance);
}

/** Balance and reservation rows; a request that charges nothing changes neither. */
async function ledger() {
  const { rows } = await pg().query<{ rows: string }>(
    "SELECT count(*)::text AS rows FROM credit_transactions WHERE organization_id=$1",
    [orgId],
  );
  return { balance: await balance(), reservations: Number(rows[0]?.rows) };
}

test("one Idempotency-Key pays for one utterance: a different text is charged, the same text replays", async () => {
  const key = `utterance-${randomUUID()}`;
  const first = "Your table is booked for seven.";
  const second =
    "Your table is booked for seven, and the kitchen closes at ten, so please arrive on time.";

  await speak(first, key);
  const afterFirst = await balance();
  expect(afterFirst).toBeCloseTo(10 - first.length * COST_PER_CHAR, 6);

  await speak(second, key);
  expect(providerCalls).toEqual([first, second]);
  expect(await balance()).toBeCloseTo(
    afterFirst - second.length * COST_PER_CHAR,
    6,
  );

  // A retry of the first utterance under its key replays the paid reservation.
  const beforeRetry = await balance();
  await speak(first, key);
  expect(providerCalls).toHaveLength(3);
  expect(await balance()).toBeCloseTo(beforeRetry, 6);

  // The direct browser request omits the default voice and model. Its cloud
  // proxy fallback fills both compatibility defaults. They are the same
  // logical utterance and must replay one reservation after an ambiguous
  // direct response instead of charging again.
  const fallbackKey = `fallback-${randomUUID()}`;
  const fallbackText = "Your driver will arrive in five minutes.";
  await speak(fallbackText, fallbackKey);
  const afterDirect = await balance();
  expect(afterDirect).toBeCloseTo(
    beforeRetry - fallbackText.length * COST_PER_CHAR,
    6,
  );

  await speak(fallbackText, fallbackKey, {
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    modelId: "eleven_flash_v2_5",
  });
  expect(providerCalls).toHaveLength(5);
  expect(await balance()).toBeCloseTo(afterDirect, 6);
});

test("the cache read and the price read overlap moderation; admission and synthesis wait for it", async () => {
  gates.moderation = timedStep("moderation", 60);
  gates.cacheRead = async () => {
    await timedStep("cache", 20)();
    return null;
  };
  gates.priceRead = timedStep("price", 20);

  await speak("Moderation runs beside the reads.", `overlap-${randomUUID()}`);

  const at = (mark: string) => {
    expect(events).toContain(mark);
    return events.indexOf(mark);
  };
  // Both reads were in flight before the moderation verdict arrived.
  expect(at("cache:start")).toBeLessThan(at("moderation:end"));
  expect(at("price:start")).toBeLessThan(at("moderation:end"));
  // Paid admission and provider dispatch still wait for that verdict.
  expect(at("admission")).toBeGreaterThan(at("moderation:end"));
  expect(at("synthesis")).toBeGreaterThan(at("admission"));
});

test("a moderation rejection serves no cached audio, reserves no credits and never synthesizes", async () => {
  const calls = providerCalls.length;
  const before = await ledger();
  // A cached opener exists, and the verdict arrives after it can be read.
  gates.cacheRead = async () => cachedOpener;
  gates.moderation = async () => {
    await sleep(40);
    throw new ApiError(400, "validation_error", "Content failed safety review");
  };

  const blocked = await post("Got it.", `blocked-${randomUUID()}`);
  expect(blocked.status).toBe(400);
  expect(blocked.headers.get("X-TTS-Cache")).toBeNull();
  expect(await blocked.json()).toMatchObject({
    error: "Content failed safety review",
  });
  expect(events).toEqual([]);

  // A price read that fails while moderation is pending does not replace the
  // moderation verdict and is not left unhandled.
  gates.priceRead = async () => {
    throw new AiPricingCacheWarmingError();
  };
  const blockedWhileWarming = await post("Got it.", `blocked-${randomUUID()}`);
  expect(blockedWhileWarming.status).toBe(400);
  expect(providerCalls).toHaveLength(calls);
  expect(await ledger()).toEqual(before);

  // The same opener after moderation passes is served from the cache, free.
  gates = { ...passingGates(), cacheRead: async () => cachedOpener };
  const served = await post("Got it.", `served-${randomUUID()}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("X-TTS-Cache")).toBe("hit; first-sentence");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(
    cachedOpener.bytes,
  );
  expect(events).not.toContain("admission");
  expect(providerCalls).toHaveLength(calls);
  expect(await ledger()).toEqual(before);
});

test("no synthesis without an admitted reservation or a price", async () => {
  const calls = providerCalls.length;
  const before = await ledger();

  gates.costPerChar = 1_000;
  const refused = await post(
    "This reply costs more than the balance.",
    `refused-${randomUUID()}`,
  );
  expect(refused.status).toBe(402);
  expect(await refused.json()).toMatchObject({
    error: "Insufficient credits for text-to-speech",
  });
  expect(events).toEqual(["admission"]);

  events.length = 0;
  gates = passingGates();
  gates.priceRead = async () => {
    throw new AiPricingCacheWarmingError();
  };
  const warming = await post(
    "The price is not known yet.",
    `warming-${randomUUID()}`,
  );
  expect(warming.status).toBe(503);
  expect(events).toEqual([]);

  expect(providerCalls).toHaveLength(calls);
  expect(await ledger()).toEqual(before);
});
