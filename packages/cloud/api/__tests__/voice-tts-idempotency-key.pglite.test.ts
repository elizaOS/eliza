/**
 * `POST /api/v1/voice/tts` replays a credit reservation for a retried
 * `Idempotency-Key` (#16425). The key names one utterance: a second utterance
 * sent under the same key is a new paid request, while a retry of the same
 * utterance still replays. An ElevenLabs rejection releases the reservation.
 * Real credits service on PGlite; auth, pricing,
 * content safety, the ElevenLabs client, the first-line cache and usage
 * records are replaced.
 */
import {
  afterAll,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { ElevenLabs, ElevenLabsTimeoutError } from "@elevenlabs/elevenlabs-js";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import * as elevenlabs from "@elizaos/cloud-shared/lib/services/elevenlabs";
import { settlementDigest } from "@elizaos/cloud-shared/lib/services/settlement-digest";
import * as firstLineCache from "@elizaos/cloud-shared/lib/services/tts-first-line-cache";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { Bindings } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "@elizaos/host/protocol";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

const phaseRows: Array<Record<string, unknown>> = [];
const phaseLog = spyOn(logger, "audit").mockImplementation((name, data) => {
  if (name === "[CloudSpeech] phase timing")
    phaseRows.push(data as Record<string, unknown>);
});
let authCalls = 0;
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

const orgId = randomUUID();
const userId = randomUUID();
const providerCalls: string[] = [];
const providerVoices: string[] = [];
const providerFailures = new Map<string, Error>();
const COST_PER_CHAR = 0.001;

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => {
    authCalls++;
    return {
      user: { id: userId, organization_id: orgId },
      apiKeyId: null,
      admissionSnapshot: undefined,
      credential: undefined,
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse: async () => ({}) },
}));
mock.module("@elizaos/cloud-shared/lib/services/ai-pricing", () => ({
  ...aiPricing,
  calculateTTSCostFromCatalog: async ({
    characterCount,
  }: {
    characterCount: number;
  }) => ({
    totalCost: characterCount * COST_PER_CHAR,
    baseTotalCost: characterCount * COST_PER_CHAR * 0.8,
    platformMarkup: characterCount * COST_PER_CHAR * 0.2,
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/elevenlabs", () => ({
  ...elevenlabs,
  getElevenLabsService: () => ({
    textToSpeech: async ({
      text,
      voiceId,
    }: {
      text: string;
      voiceId: string;
    }) => {
      providerCalls.push(text);
      providerVoices.push(voiceId);
      const failure = providerFailures.get(text);
      if (failure) throw failure;
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
    get: async () => null,
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
  phaseLog.mockRestore();
  await closeDatabaseConnectionsForTests();
});

async function speak(
  text: string,
  idempotencyKey: string,
  identity: { voiceId?: string; modelId?: string } = {},
  expectedStatus = 200,
  bindings: Pick<Bindings, "ELEVENLABS_VOICE_ID"> = {},
) {
  const response = await app.request(
    "/api/v1/voice/tts",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ text, ...identity }),
    },
    { NODE_ENV: "test", ...bindings },
  );
  if (response.status !== expectedStatus)
    throw new Error(`tts ${response.status}: ${await response.text()}`);
  await response.arrayBuffer();
  // A failed request settles before it responds.
  if (expectedStatus !== 200) return;
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

async function reservationIds(key: string): Promise<string[]> {
  const { rows } = await pg().query<{ stripe_payment_intent_id: string }>(
    "SELECT stripe_payment_intent_id FROM credit_transactions WHERE organization_id=$1 AND stripe_payment_intent_id LIKE $2 ORDER BY stripe_payment_intent_id",
    [orgId, `reserve:${orgId}:${key}:%`],
  );
  return rows.map((row) => row.stripe_payment_intent_id);
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

  // Older proxies filled both defaults. A retry across the catalog rollout
  // must still find the reservation written by the old paid route.
  const fallbackKey = `fallback-${randomUUID()}`;
  const fallbackText = "Your driver will arrive in five minutes.";
  const oldProxyDefault = {
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    modelId: "eleven_flash_v2_5",
  };
  await speak(fallbackText, fallbackKey);
  const afterDirect = await balance();
  expect(afterDirect).toBeCloseTo(
    beforeRetry - fallbackText.length * COST_PER_CHAR,
    6,
  );

  const oldDigest = settlementDigest({
    ...oldProxyDefault,
    text: fallbackText,
    format: "mp3",
    withTimestamps: false,
    synthesis: {},
  });
  const oldReceipt = await pg().query(
    "SELECT id FROM credit_transactions WHERE stripe_payment_intent_id=$1",
    [`reserve:${orgId}:${fallbackKey}:${oldDigest}`],
  );
  expect(oldReceipt.rows).toHaveLength(1);
  await speak(fallbackText, fallbackKey, oldProxyDefault);
  expect(providerCalls).toHaveLength(5);
  expect(providerVoices.slice(-2)).toEqual([
    DEFAULT_ELEVENLABS_VOICE_ID,
    DEFAULT_ELEVENLABS_VOICE_ID,
  ]);
  expect(await balance()).toBeCloseTo(afterDirect, 6);

  // Selecting the preset explicitly uses custom voice pricing, even when
  // the same preset currently supplies the default.
  await speak(fallbackText, fallbackKey, {
    voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
  });
  const afterExplicit = await balance();
  expect(afterExplicit).toBeLessThan(afterDirect);
  await speak(fallbackText, fallbackKey, {
    voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
  });
  expect(await balance()).toBeCloseTo(afterExplicit, 6);

  const operatorText = "The operator selected this voice for the station.";
  const operatorKey = `operator-${randomUUID()}`;
  const operatorVoice = "operator-configured-voice";
  const processVoice = "process-configured-voice";
  const historicalReservationId = (key: string, voiceId: string) =>
    `reserve:${orgId}:${key}:${settlementDigest({
      text: operatorText,
      voiceId,
      modelId: "eleven_flash_v2_5",
      format: "mp3",
      withTimestamps: false,
      synthesis: {},
    })}`;
  const previousOperatorVoice = process.env.ELEVENLABS_VOICE_ID;
  try {
    process.env.ELEVENLABS_VOICE_ID = processVoice;
    await speak(operatorText, operatorKey, { voiceId: operatorVoice });
    const afterOperatorSeed = await balance();
    expect(await reservationIds(operatorKey)).toEqual([
      historicalReservationId(operatorKey, operatorVoice),
    ]);
    await speak(operatorText, operatorKey, {}, 200, {
      ELEVENLABS_VOICE_ID: operatorVoice,
    });
    expect(await balance()).toBeCloseTo(afterOperatorSeed, 6);
    await speak(operatorText, operatorKey, {}, 200, {
      ELEVENLABS_VOICE_ID: DEFAULT_ELEVENLABS_VOICE_ID,
    });
    const afterOperatorChange = await balance();
    expect(afterOperatorChange).toBeCloseTo(
      afterOperatorSeed - operatorText.length * COST_PER_CHAR,
      6,
    );
    await speak(operatorText, operatorKey, {}, 200, {
      ELEVENLABS_VOICE_ID: DEFAULT_ELEVENLABS_VOICE_ID,
    });
    expect(await balance()).toBeCloseTo(afterOperatorChange, 6);
    expect(await reservationIds(operatorKey)).toEqual(
      [
        historicalReservationId(operatorKey, operatorVoice),
        historicalReservationId(operatorKey, DEFAULT_ELEVENLABS_VOICE_ID),
      ].sort(),
    );
    expect(providerVoices.slice(-4)).toEqual([
      operatorVoice,
      operatorVoice,
      DEFAULT_ELEVENLABS_VOICE_ID,
      DEFAULT_ELEVENLABS_VOICE_ID,
    ]);

    for (const [bindings, voiceId, publishedVoice] of [
      [{}, processVoice, processVoice],
      [
        { ELEVENLABS_VOICE_ID: "" },
        oldProxyDefault.voiceId,
        DEFAULT_ELEVENLABS_VOICE_ID,
      ],
    ] satisfies Array<
      [Pick<Bindings, "ELEVENLABS_VOICE_ID">, string, string]
    >) {
      const key = `operator-precedence-${randomUUID()}`;
      await speak(operatorText, key, { voiceId }, 200, bindings);
      const afterSeed = await balance();
      await speak(operatorText, key, {}, 200, bindings);
      expect(await balance()).toBeCloseTo(afterSeed, 6);
      expect(await reservationIds(key)).toEqual([
        historicalReservationId(key, voiceId),
      ]);
      expect(providerVoices.slice(-2)).toEqual([
        publishedVoice,
        publishedVoice,
      ]);
    }
  } finally {
    if (previousOperatorVoice === undefined)
      delete process.env.ELEVENLABS_VOICE_ID;
    else process.env.ELEVENLABS_VOICE_ID = previousOperatorVoice;
  }
});

test("an ElevenLabs rejection releases the reservation; a failure without a status stays charged", async () => {
  const rejected = "Please confirm the table for two.";
  providerFailures.set(rejected, new ElevenLabs.UnprocessableEntityError({}));
  const beforeRejection = await balance();
  await speak(rejected, `rejected-${randomUUID()}`, {}, 500);
  expect(await balance()).toBeCloseTo(beforeRejection, 6);

  const timedOut = "Your order is on its way.";
  providerFailures.set(timedOut, new ElevenLabsTimeoutError("timed out"));
  await speak(timedOut, `timeout-${randomUUID()}`, {}, 500);
  expect(await balance()).toBeCloseTo(
    beforeRejection - timedOut.length * COST_PER_CHAR,
    6,
  );
  expect(providerCalls.slice(-2)).toEqual([rejected, timedOut]);
});

test("speech timing preserves TTS provider and charged amount", async () => {
  const before = await balance(),
    calls = providerCalls.length,
    auth = authCalls;
  phaseRows.length = 0;
  const text = "Diagnostic speech fixture.";
  await speak(text, `speech-phase-${randomUUID()}`);
  expect(phaseRows.map((row) => row.phase)).toEqual(["json_decode"]);
  expect(authCalls - auth).toBe(1);
  expect(providerCalls.length - calls).toBe(1);
  expect(await balance()).toBeCloseTo(before - text.length * COST_PER_CHAR, 6);
});

test("malformed TTS JSON retains auth policy and never calls a provider", async () => {
  const before = await balance(),
    calls = providerCalls.length,
    auth = authCalls;
  phaseRows.length = 0;
  const response = await app.request(
    "/api/v1/voice/tts",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    },
    { NODE_ENV: "test" },
  );
  expect(response.status).toBe(400);
  expect(phaseRows.map((row) => row.phase)).toEqual(["json_decode"]);
  expect(authCalls - auth).toBe(1);
  expect(providerCalls.length).toBe(calls);
  expect(await balance()).toBeCloseTo(before, 6);
});
