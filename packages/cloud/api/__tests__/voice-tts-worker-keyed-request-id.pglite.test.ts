/**
 * `POST /api/v1/voice/tts` in a Worker under an `Idempotency-Key` (#16425).
 * A Worker admits through the organization admission Durable Object lease,
 * which replays a request by its request id and admits ids of at most 128
 * characters from [A-Za-z0-9._:-]. The route kept the raw key and utterance
 * digest in the id, voice-tts:<org>:<key>:<utterance digest>. That id is
 * unchanged wherever the gate admitted it, so a request completed or left
 * unknown under it before this change is not synthesized or charged again.
 * The gate refused every other keyed id before dispatch (a UUID key, what the
 * app sends, made it 148 characters), and such an id now carries the digest
 * of the key and utterance. Repeats, a second utterance under one key and
 * unkeyed requests behave as they did with a short key.
 * Real route, real admission, the real gate class on in-memory storage and
 * the real credits service on PGlite; auth, pricing, content safety, the
 * ElevenLabs client, the first-line cache and usage records are replaced.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import * as elevenlabs from "@elizaos/cloud-shared/lib/services/elevenlabs";
import { loadInferenceAdmissionSnapshot } from "@elizaos/cloud-shared/lib/services/inference-admission-snapshot";
import * as firstLineCache from "@elizaos/cloud-shared/lib/services/tts-first-line-cache";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import { InferenceAdmissionGate } from "../src/inference-admission-gate";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
// The Worker lane: a Durable Object lease before dispatch, a debit after it.
process.env.INFERENCE_DEFERRED_ADMISSION = "true";
process.env.INFERENCE_OPTIMISTIC_BILLING = "true";
setDefaultTimeout(60_000);

const orgId = randomUUID();
const userId = randomUUID();
const COST_PER_CHAR = 0.001;
const providerCalls: string[] = [];
let balanceRevision = "0";
/**
 * While set, the route admits under the keyed id it used before #38564
 * (fbb124e5): voice-tts:<org>:<the key and utterance digest it reserves>.
 */
let routeBefore = false;
/** While set, the provider fails after it received the request. */
let providerOutcomeUnknown = false;
const { admitFlatGenerativeOperation } = generativeRouteAuth;

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  admitFlatGenerativeOperation: (
    params: Parameters<typeof admitFlatGenerativeOperation>[0],
  ) =>
    admitFlatGenerativeOperation(
      routeBefore && params.idempotencyKey
        ? {
            ...params,
            context: {
              ...params.context,
              requestId: `voice-tts:${orgId}:${params.idempotencyKey}`,
            },
          }
        : params,
    ),
  requireGenerativeRouteCaller: async () => ({
    user: { id: userId, organization_id: orgId },
    apiKeyId: null,
    // The snapshot the Worker carries is the projection of the stored policy,
    // which admission checks against the locked policy row.
    admissionSnapshot: await loadInferenceAdmissionSnapshot(orgId),
    credential: undefined,
  }),
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
    textToSpeech: async ({ text }: { text: string }) => {
      providerCalls.push(text);
      if (providerOutcomeUnknown) throw new Error("connection reset");
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

/** Durable Object storage in memory: one transaction runs at a time. */
class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
  async transaction<T>(run: (transaction: this) => Promise<T>): Promise<T> {
    return await run(this);
  }
}

const gate = new InferenceAdmissionGate(
  { storage: new MemoryStorage() } as unknown as DurableObjectState,
  {} as never,
);
/** Request ids the Worker leased at the gate, in order. */
const leasedRequestIds: string[] = [];
const gates = {
  getByName: () => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/lease")) {
        const body = (await request.clone().json()) as { requestId?: unknown };
        leasedRequestIds.push(String(body.requestId));
      }
      return await gate.fetch(request);
    },
  }),
};

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
  const { rows } = await pg().query<{ balance_revision: string }>(
    "SELECT balance_revision::text AS balance_revision FROM organizations WHERE id=$1",
    [orgId],
  );
  balanceRevision = rows[0]?.balance_revision ?? "0";
  const hydrated = await gate.fetch(
    new Request("https://inference-admission.internal/hydrate", {
      method: "POST",
      body: JSON.stringify({ balanceUsd: 10, balanceRevision }),
    }),
  );
  expect(hydrated.status).toBe(200);
});
beforeEach(() => {
  leasedRequestIds.length = 0;
  routeBefore = false;
  providerOutcomeUnknown = false;
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function balance(): Promise<number> {
  const { rows } = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [orgId],
  );
  return Number(rows[0]?.credit_balance);
}

/** One Worker request: answers, then every waitUntil task has finished. */
async function speak(
  text: string,
  key: string | null,
): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const background: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil(task: Promise<unknown>) {
      background.push(task);
    },
    passThroughOnException() {},
    props: {},
  };
  const response = await runWithCloudBindingsAsync(
    { INFERENCE_ADMISSION_GATES: gates },
    async () =>
      await app.request(
        "/api/v1/voice/tts",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key && { "Idempotency-Key": key }),
          },
          body: JSON.stringify({ text }),
        },
        { NODE_ENV: "test" },
        executionCtx,
      ),
  );
  const body = await response.text();
  // Settlement runs under waitUntil, after the response; a task may add more.
  let settled = 0;
  while (settled < background.length) {
    const pending = background.slice(settled);
    settled = background.length;
    await Promise.allSettled(pending);
  }
  return {
    status: response.status,
    body,
    retryAfter: response.headers.get("Retry-After"),
  };
}

const shortKey = () => `k-${randomUUID().slice(0, 8)}`;
/** The id before this change was 112 characters plus the key. */
const hexKey = (length: number) =>
  randomUUID().replaceAll("-", "").slice(0, length);

/** A short key fit the gate with the raw key in the id; a UUID key did not. */
const KEY_SHAPES = [
  ["a short key", shortKey],
  ["a UUID key", () => randomUUID()],
] as const;

test("requests without a key each synthesize and pay under their own request id", async () => {
  const text = "Your table is booked for eight.";
  const before = await balance();
  const calls = providerCalls.length;
  for (let request = 0; request < 2; request++)
    expect((await speak(text, null)).status).toBe(200);
  expect(providerCalls.slice(calls)).toEqual([text, text]);
  expect(await balance()).toBeCloseTo(
    before - 2 * text.length * COST_PER_CHAR,
    6,
  );
  expect(leasedRequestIds).toHaveLength(2);
  for (const requestId of leasedRequestIds)
    expect(requestId).toMatch(/^voice-tts:[0-9a-f-]{36}$/);
  expect(new Set(leasedRequestIds).size).toBe(2);
});

test.each([
  ["a short key", "completed", shortKey, 122],
  ["a 16 character key", "completed", () => hexKey(16), 128],
  ["a short key", "left unknown after dispatch", shortKey, 122],
] as const)(
  "with %s, a request %s before this change is not synthesized or charged again",
  async (shape, outcome, newKey, idLength) => {
    const key = newKey();
    const text = `Your order ships tomorrow, with ${shape}, ${outcome}.`;
    const before = await balance();
    const calls = providerCalls.length;
    routeBefore = true;
    providerOutcomeUnknown = outcome === "left unknown after dispatch";
    expect((await speak(text, key)).status).toBe(
      providerOutcomeUnknown ? 500 : 200,
    );
    expect(providerCalls.slice(calls)).toEqual([text]);
    const paid = before - text.length * COST_PER_CHAR;
    expect(await balance()).toBeCloseTo(paid, 6);
    expect(leasedRequestIds[0]).toMatch(
      new RegExp(`^voice-tts:${orgId}:${key}:[0-9a-f]{64}$`),
    );
    expect(leasedRequestIds[0]).toHaveLength(idLength);

    // The same key and utterance after the change: the same id, refused.
    routeBefore = false;
    providerOutcomeUnknown = false;
    const retry = await speak(text, key);
    expect(providerCalls.slice(calls)).toEqual([text]);
    expect(await balance()).toBeCloseTo(paid, 6);
    expect(retry.status).toBe(503);
    expect(retry.retryAfter).toBe("1");
    expect(leasedRequestIds[1]).toBe(leasedRequestIds[0]);
  },
);

test.each([
  ["a 17 character key", () => hexKey(17), 129],
  ["a UUID key", () => randomUUID(), 148],
  [
    "a key with a character outside [A-Za-z0-9._:-]",
    () => `${shortKey()}/`,
    123,
  ],
] as const)(
  "%s, refused at the gate before dispatch, is admitted under the digest of the key and utterance and pays once",
  async (shape, newKey, refusedLength) => {
    const key = newKey();
    const text = `Your room is ready, with ${shape}.`;
    const before = await balance();
    const calls = providerCalls.length;
    routeBefore = true;
    expect((await speak(text, key)).status).toBe(503);
    expect(leasedRequestIds[0]).toHaveLength(refusedLength);
    expect(await balance()).toBeCloseTo(before, 6);

    routeBefore = false;
    expect((await speak(text, key)).status).toBe(200);
    expect(providerCalls.slice(calls)).toEqual([text]);
    expect(await balance()).toBeCloseTo(
      before - text.length * COST_PER_CHAR,
      6,
    );
    expect(leasedRequestIds[1]).toMatch(
      new RegExp(`^voice-tts:${orgId}:[0-9a-f]{64}$`),
    );
  },
);

test.each(KEY_SHAPES)(
  "with %s, the same key and utterance again is neither synthesized nor charged, as with a short key before",
  async (shape, newKey) => {
    const text = `Your driver will arrive in five minutes, with ${shape}.`;
    const key = newKey();
    const before = await balance();
    const calls = providerCalls.length;
    expect((await speak(text, key)).status).toBe(200);
    const paid = before - text.length * COST_PER_CHAR;
    expect(await balance()).toBeCloseTo(paid, 6);

    // The gate remembers the settled id: the repeat leases the same id and
    // is refused there, as a short key was before this change.
    const repeat = await speak(text, key);
    expect(repeat.status).toBe(503);
    expect(repeat.retryAfter).toBe("1");
    expect(providerCalls.slice(calls)).toEqual([text]);
    expect(await balance()).toBeCloseTo(paid, 6);
    expect(leasedRequestIds).toHaveLength(2);
    expect(leasedRequestIds[1]).toBe(leasedRequestIds[0]);
  },
);

test.each(KEY_SHAPES)(
  "with %s, a different utterance under the same key is a new paid request with its own request id",
  async (shape, newKey) => {
    const key = newKey();
    const first = `Your table is booked for nine, with ${shape}.`;
    const second = `Your table is booked for nine, and the kitchen closes at ten, with ${shape}.`;
    const before = await balance();
    const calls = providerCalls.length;
    expect((await speak(first, key)).status).toBe(200);
    expect((await speak(second, key)).status).toBe(200);
    expect(providerCalls.slice(calls)).toEqual([first, second]);
    const paid = before - (first.length + second.length) * COST_PER_CHAR;
    expect(await balance()).toBeCloseTo(paid, 6);
    expect(leasedRequestIds).toHaveLength(2);
    expect(leasedRequestIds[1]).not.toBe(leasedRequestIds[0]);

    // The first utterance stays bound to its own id under the shared key.
    expect((await speak(first, key)).status).toBe(503);
    expect(leasedRequestIds[2]).toBe(leasedRequestIds[0]);
    expect(providerCalls.slice(calls)).toEqual([first, second]);
    expect(await balance()).toBeCloseTo(paid, 6);
  },
);
