/**
 * The guarded paid proxy defers the strong credential check into the one
 * combined admission (the gate's /lease-dispatched-authorized). Its deferred
 * credential guard runs the standalone /credential/check on disposal only when
 * the request ends before admission. The guard must stay in scope for the
 * whole dispatch: disposed early, every credentialed request paid for an extra
 * standalone check, and when that check failed the route answered a retryable
 * 503 while the detached dispatch still reached the provider and charged, so a
 * retry charged twice.
 *
 * GET /api/v1/chain/nfts/:chain/:address runs through the real route, guarded
 * paid proxy, proxy engine, admission, gate client, the real gate class on
 * in-memory storage and the real credits service on PGlite. Caller resolution
 * (the flag-gated credential the real auth layer returns), the chain-data
 * provider and usage records are replaced. No network is used.
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
import { loadInferenceAdmissionSnapshot } from "@elizaos/cloud-shared/lib/services/inference-admission-snapshot";
import { isInferenceStrongRevocationEnabled } from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";
import { isInferenceAuthCacheEnabled } from "@elizaos/cloud-shared/lib/services/inference-hot-path-caches";
import * as chainData from "@elizaos/cloud-shared/lib/services/proxy/chain-data";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import { InferenceAdmissionGate } from "../src/inference-admission-gate";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
// The Worker lane shared by production and staging.
process.env.INFERENCE_DEFERRED_ADMISSION = "true";
process.env.INFERENCE_OPTIMISTIC_BILLING = "true";
process.env.INFERENCE_BILLING_LEDGER = "db";
const savedFlags = {
  INFERENCE_AUTH_CACHE_ENABLED: process.env.INFERENCE_AUTH_CACHE_ENABLED,
  INFERENCE_STRONG_REVOCATION_ENABLED:
    process.env.INFERENCE_STRONG_REVOCATION_ENABLED,
};
setDefaultTimeout(60_000);

const COST_USD = 0.001;
const NFTS_PATH =
  "/api/v1/chain/nfts/ethereum/0x000000000000000000000000000000000000dEaD";
/** Gate paths that check the request's API key against its revocations. */
const CREDENTIAL_CHECK_PATHS = new Set([
  "/credential/check",
  "/lease-authorized",
  "/lease-dispatched-authorized",
]);

let orgId = "";
let userId = "";
let providerCalls = 0;
/** Gate paths called for the organization, in order. */
const gateCalls: string[] = [];
/** The next this many credential checks lose their transport. */
let credentialCheckTransportFailures = 0;
/** Gate paths whose transport stays lost. */
const lostPaths = new Set<string>();

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  // The auth layer defers a strong credential proof to admission only with
  // the auth cache and strong revocation both enabled.
  requireGenerativeRouteCaller: async () => ({
    user: { id: userId, organization_id: orgId },
    apiKeyId: null,
    authSource: "api_key",
    appScopeId: null,
    admissionSnapshot: await loadInferenceAdmissionSnapshot(orgId),
    credential:
      isInferenceAuthCacheEnabled() && isInferenceStrongRevocationEnabled()
        ? { kind: "api_key", credentialId: `key-${orgId}`, userId }
        : undefined,
  }),
}));
const realChainData = { ...chainData };
mock.module("@elizaos/cloud-shared/lib/services/proxy/chain-data", () => ({
  ...realChainData,
  chainDataHandler: async () => {
    providerCalls++;
    return { response: Response.json({ ownedNfts: [], totalCount: 0 }) };
  },
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
  servicePricing,
} = await import("@elizaos/cloud-shared/db/schemas");
const { default: nftsRoute } = await import(
  "../v1/chain/nfts/[chain]/[address]/route"
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
  "service_pricing",
]);
const app = new Hono();
app.route("/api/v1/chain/nfts/:chain/:address", nftsRoute);

/** Durable Object storage in memory: one transaction runs at a time. */
class MemoryStorage {
  readonly values = new Map<string, unknown>();
  private alarm: number | null = null;
  readonly kv = {
    get: <T>(key: string): T | undefined =>
      this.values.has(key)
        ? (structuredClone(this.values.get(key)) as T)
        : undefined,
    put: (key: string, value: unknown) => {
      this.values.set(key, structuredClone(value));
    },
  };
  async get<T>(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) {
      const out = new Map<string, T>();
      for (const k of key)
        if (this.values.has(k))
          out.set(k, structuredClone(this.values.get(k)) as T);
      return out;
    }
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let n = 0;
      for (const k of key) if (this.values.delete(k)) n++;
      return n;
    }
    return this.values.delete(key);
  }
  async list<T>(options: {
    prefix?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of [...this.values.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (options.prefix && !k.startsWith(options.prefix)) continue;
      out.set(k, structuredClone(v) as T);
      if (options.limit && out.size >= options.limit) break;
    }
    return out;
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

const gateInstances = new Map<string, InferenceAdmissionGate>();
function gateFor(name: string): InferenceAdmissionGate {
  let gate = gateInstances.get(name);
  if (!gate) {
    gate = new InferenceAdmissionGate(
      { storage: new MemoryStorage() } as unknown as DurableObjectState,
      {} as never,
    );
    gateInstances.set(name, gate);
  }
  return gate;
}
const gates = {
  getByName: (name: string) => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      gateCalls.push(path);
      if (
        CREDENTIAL_CHECK_PATHS.has(path) &&
        credentialCheckTransportFailures > 0
      ) {
        credentialCheckTransportFailures--;
        throw new Error("Network connection lost.");
      }
      if (lostPaths.has(path)) throw new Error("Network connection lost.");
      return await gateFor(name).fetch(request);
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
        servicePricing,
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
    "INSERT INTO service_pricing(service_id,method,cost) VALUES ('chain-data','getNFTsForOwner',$1)",
    [String(COST_USD)],
  );
});
beforeEach(async () => {
  orgId = randomUUID();
  userId = randomUUID();
  providerCalls = 0;
  gateCalls.length = 0;
  credentialCheckTransportFailures = 0;
  lostPaths.clear();
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Proxy',$2,'10')",
    [orgId, `proxy-${orgId}`],
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
  const hydrated = await gateFor(orgId).fetch(
    new Request("https://inference-admission.internal/hydrate", {
      method: "POST",
      body: JSON.stringify({
        balanceUsd: 10,
        balanceRevision: rows[0]?.balance_revision ?? "0",
      }),
    }),
  );
  expect(hydrated.status).toBe(200);
});
afterAll(async () => {
  for (const [name, value] of Object.entries(savedFlags)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await closeDatabaseConnectionsForTests();
});

function useFlags(lane: "production" | "staging"): void {
  process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";
  process.env.INFERENCE_STRONG_REVOCATION_ENABLED =
    lane === "staging" ? "true" : "false";
}

async function money(): Promise<{ balance: number; charges: number }> {
  const balance = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [orgId],
  );
  const charges = await pg().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id=$1",
    [orgId],
  );
  return {
    balance: Number(balance.rows[0]?.credit_balance),
    charges: Number(charges.rows[0]?.n),
  };
}

/** One Worker request: answers, then every waitUntil task has finished. */
async function getNfts(
  path = NFTS_PATH,
): Promise<{ status: number; code?: string }> {
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
        path,
        { headers: { Authorization: "Bearer test-key" } },
        { NODE_ENV: "test" },
        executionCtx,
      ),
  );
  const body = (await response.json()) as { code?: string };
  let settled = 0;
  while (settled < background.length) {
    const pending = background.slice(settled);
    settled = background.length;
    await Promise.allSettled(pending);
  }
  return { status: response.status, code: body.code };
}

/** Anything still running after the response has had time to finish. */
const afterResponse = () => new Promise((resolve) => setTimeout(resolve, 1500));

test("staging: a lost credential check answers 503, never reaches the provider or the balance, and its retry charges once", async () => {
  useFlags("staging");
  // The outage outlasts the Worker's three attempts at the dispatch lease
  // that carries the credential check.
  credentialCheckTransportFailures = 3;

  const refused = await getNfts();
  expect(refused.status).toBe(503);
  expect(providerCalls).toBe(0);
  expect(await money()).toEqual({ balance: 10, charges: 0 });

  await afterResponse();
  expect(providerCalls).toBe(0);
  expect(await money()).toEqual({ balance: 10, charges: 0 });

  const retried = await getNfts();
  expect(retried.status).toBe(200);
  expect(providerCalls).toBe(1);
  expect(await money()).toEqual({ balance: 10 - COST_USD, charges: 1 });
});

test("staging: a lost standalone credential check does not refuse a credentialed request", async () => {
  useFlags("staging");
  lostPaths.add("/credential/check");

  const served = await getNfts();
  expect(served.status).toBe(200);
  expect(providerCalls).toBe(1);
  expect(await money()).toEqual({ balance: 10 - COST_USD, charges: 1 });

  await afterResponse();
  expect(providerCalls).toBe(1);
  expect(await money()).toEqual({ balance: 10 - COST_USD, charges: 1 });
});

test("staging: a credentialed request checks the key inside the dispatch lease, calls the provider once and charges once", async () => {
  useFlags("staging");

  const served = await getNfts();
  expect(served.status).toBe(200);
  expect(gateCalls.filter((path) => CREDENTIAL_CHECK_PATHS.has(path))).toEqual([
    "/lease-dispatched-authorized",
  ]);
  expect(providerCalls).toBe(1);
  expect(await money()).toEqual({ balance: 10 - COST_USD, charges: 1 });

  await afterResponse();
  expect(gateCalls).not.toContain("/credential/check");
  expect(providerCalls).toBe(1);
  expect(await money()).toEqual({ balance: 10 - COST_USD, charges: 1 });
});

test("staging: a revoked key is refused before the provider", async () => {
  useFlags("staging");
  const revoked = await gateFor(orgId).fetch(
    new Request("https://inference-admission.internal/credential/revoke", {
      method: "POST",
      body: JSON.stringify({
        organizationId: orgId,
        kind: "api_key",
        credentialId: `key-${orgId}`,
      }),
    }),
  );
  expect(revoked.status).toBe(200);

  const refused = await getNfts();
  expect(refused.status).toBe(401);
  expect(refused.code).toBe("authentication_required");
  expect(providerCalls).toBe(0);
  expect(await money()).toEqual({ balance: 10, charges: 0 });

  await afterResponse();
  expect(providerCalls).toBe(0);
  expect(await money()).toEqual({ balance: 10, charges: 0 });
});

test("staging: a request that ends before admission still runs the standalone credential check", async () => {
  useFlags("staging");

  const invalid = await getNfts(
    "/api/v1/chain/nfts/not-a-chain/0x000000000000000000000000000000000000dEaD",
  );
  expect(invalid.status).toBe(400);
  expect(gateCalls).toEqual(["/credential/check"]);
  expect(providerCalls).toBe(0);
  expect(await money()).toEqual({ balance: 10, charges: 0 });
});

test("production: a request without a deferred credential calls the provider once and charges once", async () => {
  useFlags("production");

  const served = await getNfts();
  expect(served.status).toBe(200);
  expect(gateCalls.filter((path) => CREDENTIAL_CHECK_PATHS.has(path))).toEqual(
    [],
  );
  expect(gateCalls).toContain("/lease-dispatched");
  expect(providerCalls).toBe(1);
  expect(await money()).toEqual({ balance: 10 - COST_USD, charges: 1 });

  await afterResponse();
  expect(providerCalls).toBe(1);
  expect(await money()).toEqual({ balance: 10 - COST_USD, charges: 1 });
});

test("production: a lost dispatch lease answers 503 and never reaches the provider or the balance", async () => {
  useFlags("production");
  lostPaths.add("/lease-dispatched");

  const refused = await getNfts();
  expect(refused.status).toBe(503);
  expect(providerCalls).toBe(0);
  expect(await money()).toEqual({ balance: 10, charges: 0 });

  await afterResponse();
  expect(providerCalls).toBe(0);
  expect(await money()).toEqual({ balance: 10, charges: 0 });
});

test("production: invalid input answers 400 without any gate call", async () => {
  useFlags("production");

  const invalid = await getNfts(
    "/api/v1/chain/nfts/not-a-chain/0x000000000000000000000000000000000000dEaD",
  );
  expect(invalid.status).toBe(400);
  expect(gateCalls).toEqual([]);
  expect(providerCalls).toBe(0);
});
