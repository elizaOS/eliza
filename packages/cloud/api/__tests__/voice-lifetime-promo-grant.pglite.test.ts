/**
 * An organization served by a redeemed subscription grant reaches paid Worker
 * voice. A lifetime grant (subscription_grants.ends_at NULL) projects a
 * promo_grant policy whose effectiveUntil is null; a time-limited grant
 * projects its end. Both must admit STT and TTS.
 *
 * Real caller resolution (requireGenerativeRouteCaller ->
 * resolveInferenceAuthContext / resolveInferenceSessionAuthContext), the real
 * routes, real admission, the real InferenceAdmissionGate class on in-memory
 * storage, and real credits on PGlite, under production and staging flags.
 * Replaced: content safety, pricing, the ElevenLabs client, the first-line
 * cache, usage rows, and the rate-limit Durable Object (always allows).
 * Subscriber-lane settlement tables are not seeded, so settlement is out of
 * scope here; a grant org settles on the same lane at either term.
 */
import {
  afterAll,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import * as elevenlabs from "@elizaos/cloud-shared/lib/services/elevenlabs";
import { loadInferenceAdmissionSnapshot } from "@elizaos/cloud-shared/lib/services/inference-admission-snapshot";
import { isInferenceAdmissionSnapshot } from "@elizaos/cloud-shared/lib/services/inference-auth-cache";
import * as firstLineCache from "@elizaos/cloud-shared/lib/services/tts-first-line-cache";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { InferenceAdmissionGate } from "../src/inference-admission-gate";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.INFERENCE_DEFERRED_ADMISSION = "true";
process.env.INFERENCE_OPTIMISTIC_BILLING = "true";
// Production values (wrangler.toml [env.production.vars]).
process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";
process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "false";
process.env.INFERENCE_SNAPSHOT_ADMISSION_ENABLED = "false";
process.env.CACHE_BACKEND = "memory";
setDefaultTimeout(120_000);

const TTS_COST_PER_CHAR = 0.001;
const STT_COST_PER_SECOND = 0.01;
const providerCalls: string[] = [];

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
    totalCost: characterCount * TTS_COST_PER_CHAR,
    baseTotalCost: characterCount * TTS_COST_PER_CHAR * 0.8,
    platformMarkup: characterCount * TTS_COST_PER_CHAR * 0.2,
  }),
  calculateSTTCostFromCatalog: async ({
    durationSeconds,
  }: {
    durationSeconds: number;
  }) => ({
    totalCost: durationSeconds * STT_COST_PER_SECOND,
    baseTotalCost: durationSeconds * STT_COST_PER_SECOND,
    platformMarkup: 0,
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/elevenlabs", () => ({
  ...elevenlabs,
  getElevenLabsService: () => ({
    textToSpeech: async ({ text }: { text: string }) => {
      providerCalls.push(`tts:${text}`);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0x00]));
          controller.close();
        },
      });
    },
    speechToText: async () => {
      providerCalls.push("stt");
      return { transcript: "hello", audioDurationSeconds: 1 };
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
const schema = await import("@elizaos/cloud-shared/db/schemas");
const { default: ttsRoute } = await import("../v1/voice/tts/route");
const { default: sttRoute } = await import("../v1/voice/stt/route");
const { mintStewardTokenFromClaims } = await import(
  "@elizaos/cloud-shared/lib/auth/steward-client"
);

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
app.route("/api/v1/voice/stt", sttRoute);

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | null = null;
  async get<T>(key: string | string[]): Promise<T | undefined> {
    if (Array.isArray(key)) {
      const found = new Map<string, unknown>();
      for (const one of key) {
        const value = this.values.get(one);
        if (value !== undefined) found.set(one, structuredClone(value));
      }
      return found as T;
    }
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

const gatesByName = new Map<string, InferenceAdmissionGate>();
const leases: string[] = [];
const gates = {
  getByName: (name: string) => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (name.startsWith("rate-limit:")) {
        const body = (await request.clone().json()) as {
          windowStartedAt: number;
          windowMs: number;
        };
        return Response.json({
          allowed: true,
          remaining: 1,
          resetAt: body.windowStartedAt + body.windowMs,
        });
      }
      if (path.startsWith("/lease")) leases.push(name);
      let gate = gatesByName.get(name);
      if (!gate) {
        gate = new InferenceAdmissionGate(
          { storage: new MemoryStorage() } as unknown as DurableObjectState,
          {} as never,
        );
        gatesByName.set(name, gate);
      }
      return await gate.fetch(request);
    },
  }),
};

const SESSION_SECRET = "synthetic-lifetime-grant-session-secret-".repeat(2);

/** Schema-derived table without constraints; rows below supply every value read. */
async function createLooseTable(table: unknown): Promise<void> {
  const config = getTableConfig(table as never);
  await pg().exec(
    `CREATE TABLE IF NOT EXISTS "${config.name}" (${config.columns
      .map(
        (column) =>
          `"${column.name}" ${"enumValues" in column && column.enumValues ? "text" : column.getSQLType()}`,
      )
      .join(", ")})`,
  );
}

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        organizations: schema.organizations,
        users: schema.users,
        creditTransactions: schema.creditTransactions,
        billingSubscriptions: schema.billingSubscriptions,
        organizationSubscriptionAuthorities:
          schema.organizationSubscriptionAuthorities,
        orgRateLimitOverrides: schema.orgRateLimitOverrides,
        organizationConfig: schema.organizationConfig,
        orgStorageQuota: schema.orgStorageQuota,
        organizationPaymentReversalHolds:
          schema.organizationPaymentReversalHolds,
        autoTopUpAttempts: schema.autoTopUpAttempts,
      },
      empty.id,
    ),
  )) {
    const foreignKey = statement.match(/REFERENCES "([a-z_]+)"/);
    if (foreignKey && !SEEDED_TABLES.has(foreignKey[1])) continue;
    await pg().exec(statement.replaceAll('"public".', ""));
  }
  await pg().exec(
    `CREATE TABLE organization_entitlements (${getTableConfig(
      schema.organizationEntitlements,
    )
      .columns.map((column) => `"${column.name}" ${column.getSQLType()}`)
      .join(",")})`,
  );
  for (const table of [
    schema.apiKeys,
    schema.userModerationStatus,
    schema.apps,
    schema.subscriptionGrants,
    schema.subscriptionAllowancePeriods,
  ])
    await createLooseTable(table);
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

type GrantTerm = "lifetime" | "time-limited";

interface Seeded {
  orgId: string;
  apiKey: string;
  session: string;
  grantEndsAt: string | null;
}

/** An organization without a paid subscription whose redeemed grant is its projection. */
async function seedGrantOrganization(term: GrantTerm): Promise<Seeded> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const subject = `subject_grant_${userId}`;
  const keyId = randomUUID();
  const apiKey = `eliza_grant_${keyId}`;
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Grantee',$2,'10')",
    [orgId, `grantee-${orgId}`],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role,is_active) VALUES ($1,$2,$3,'owner',true)",
    [userId, orgId, subject],
  );
  await pg().query(
    "INSERT INTO organization_subscription_authorities(organization_id,state,policy_generation) VALUES ($1,'none',1)",
    [orgId],
  );
  await pg().query(
    `INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, rate_limit, is_active, usage_count, created_at, updated_at, user_created)
     VALUES ($1,'grant',$2,'eliza_gr',$3,$4,1000,true,0,now(),now(),true)`,
    [keyId, createHash("sha256").update(apiKey).digest("hex"), orgId, userId],
  );
  const grantId = randomUUID();
  const startsAt = new Date(Date.now() - 86_400_000);
  const endsAt =
    term === "lifetime" ? null : new Date(Date.now() + 30 * 86_400_000);
  await pg().query(
    `INSERT INTO subscription_grants(id, organization_id, user_id, code_id, family, plan_key, catalog_version, idempotency_key, starts_at, ends_at, created_at, revoked_at)
     VALUES ($1,$2,$3,$4,'launch','plus_monthly','v1',$5,$6,$7,now(),NULL)`,
    [grantId, orgId, userId, randomUUID(), `idem-${grantId}`, startsAt, endsAt],
  );
  await pg().query(
    `INSERT INTO organization_entitlements(organization_id, billing_scope_id, source_grant_id, projection_revision, effective_from, effective_until)
     VALUES ($1,NULL,$2,1,$3,$4)`,
    [orgId, grantId, startsAt, endsAt],
  );
  const { rows } = await pg().query<{ balance_revision: string }>(
    "SELECT balance_revision::text AS balance_revision FROM organizations WHERE id=$1",
    [orgId],
  );
  const hydrated = await gates.getByName(orgId).fetch(
    new Request("https://inference-admission.internal/hydrate", {
      method: "POST",
      body: JSON.stringify({
        balanceUsd: 10,
        balanceRevision: rows[0]?.balance_revision ?? "0",
      }),
    }),
  );
  expect(hydrated.status).toBe(200);
  const issuedAt = Math.floor(Date.now() / 1000);
  const signed = await mintStewardTokenFromClaims(
    { STEWARD_SESSION_SECRET: SESSION_SECRET },
    { userId: subject, issuedAt, expiration: issuedAt + 3600 },
  );
  if (!signed) throw new Error("session signer unavailable");
  return {
    orgId,
    apiKey,
    session: signed.token,
    grantEndsAt: endsAt?.toISOString() ?? null,
  };
}

const PROD: Record<string, unknown> = {};
// wrangler.toml [env.staging.vars].
const STAGING: Record<string, unknown> = {
  INFERENCE_STRONG_REVOCATION_ENABLED: "true",
  INFERENCE_SNAPSHOT_ADMISSION_ENABLED: "true",
};

/** 16 kHz mono 16-bit PCM WAV whose header and data both say one second. */
function oneSecondWav(): Uint8Array<ArrayBuffer> {
  const dataBytes = 16_000 * 2;
  const buf = new Uint8Array(new ArrayBuffer(44 + dataBytes));
  const view = new DataView(buf.buffer);
  const ascii = (offset: number, text: string) =>
    buf.set(new TextEncoder().encode(text), offset);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buf;
}

async function send(
  path: "tts" | "stt",
  credential: string,
  flags: Record<string, unknown>,
  text = "",
): Promise<{ status: number; body: string }> {
  const background: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil(task: Promise<unknown>) {
      background.push(task);
    },
    passThroughOnException() {},
    props: {},
  };
  let body: BodyInit;
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
  };
  if (path === "tts") {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ text });
  } else {
    const form = new FormData();
    form.append(
      "audio",
      new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
    );
    body = form;
  }
  const response = await runWithCloudBindingsAsync(
    {
      INFERENCE_ADMISSION_GATES: gates,
      STEWARD_SESSION_SECRET: SESSION_SECRET,
      ...flags,
    },
    async () =>
      await app.request(
        `/api/v1/voice/${path}`,
        { method: "POST", headers, body },
        { NODE_ENV: "test", STEWARD_SESSION_SECRET: SESSION_SECRET, ...flags },
        executionCtx,
      ),
  );
  const responseBody = await response.text();
  let settled = 0;
  while (settled < background.length) {
    const pending = background.slice(settled);
    settled = background.length;
    await Promise.allSettled(pending);
  }
  return {
    status: response.status,
    body: response.status === 200 ? "" : responseBody,
  };
}

for (const [flagName, flags] of [
  ["PROD", PROD],
  ["STAGING", STAGING],
] as const) {
  for (const term of ["lifetime", "time-limited"] as const) {
    for (const credentialKind of ["apiKey", "session"] as const) {
      test(`${flagName} flags, ${credentialKind}: a ${term} promo grant org gets 200 on Worker STT and TTS`, async () => {
        const org = await seedGrantOrganization(term);
        const credential = org[credentialKind];
        if (flags === STAGING) {
          // A cold auth cache answers a retryable 503 while the decision hydrates.
          const cold = await send("stt", credential, flags);
          expect(cold.status).toBe(503);
          expect(cold.body).toContain("auth_cache_warming");
        }
        const calls = providerCalls.length;
        const leasesBefore = leases.length;
        const text = `Grant ${term} ${credentialKind} ${flagName}.`;

        const stt = await send("stt", credential, flags);
        const tts = await send("tts", credential, flags, text);
        expect({ stt, tts }).toEqual({
          stt: { status: 200, body: "" },
          tts: { status: 200, body: "" },
        });

        // Each request was leased at the gate before its one provider call.
        expect(providerCalls.slice(calls)).toEqual(["stt", `tts:${text}`]);
        expect(leases.length - leasesBefore).toBe(2);

        // The stored projection is a valid admission snapshot carrying the grant's end.
        const snapshot = await loadInferenceAdmissionSnapshot(org.orgId);
        expect(snapshot.authority.source).toBe("promo_grant");
        expect(snapshot.authority.effectiveUntil).toBe(org.grantEndsAt);
        expect(isInferenceAdmissionSnapshot(snapshot)).toBe(true);
      });
    }
  }
}
