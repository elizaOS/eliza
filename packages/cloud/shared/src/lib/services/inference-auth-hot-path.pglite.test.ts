/**
 * The inference hot path is decided by one combined-cache read plus the
 * organization Durable Objects, and never queries Postgres: not on a warm
 * hit, not on a stale entry, not on a first-ever miss. Suspension and
 * revocation are found by the off-response refresh, which rewrites the entry
 * so the NEXT request fails (one stale allow is accepted).
 *
 * Every "zero queries" claim runs with a primary tripwire armed: any PGlite
 * statement throws and is counted. A control test proves the tripwire fires.
 * Background work (`waitUntil`) runs only after the request returned and the
 * tripwire was disarmed.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
setDefaultTimeout(120_000);

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../db/client";
import { apiKeys } from "../../db/schemas/api-keys";
import { userModerationStatus } from "../../db/schemas/moderation-violations";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import {
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceAdmissionSnapshot,
  type InferenceAuthContext,
  invalidateInferenceAuthContextByKeyHash,
} from "./inference-auth-cache";
import {
  __clearInferenceApiKeyHydrations,
  AUTH_CONTEXT_REFRESH_AFTER_MS,
  type InferenceAuthResolution,
  resolveInferenceAuthContext,
} from "./inference-auth-context";

const ORG = "91000000-0000-4000-8000-000000000001";
const OTHER_ORG = "91000000-0000-4000-8000-000000000002";
const USER = "92000000-0000-4000-8000-000000000001";

let primaryArmed = false;
let primaryTouches = 0;

/** Any primary use while armed throws, so a decision cannot hide a query. */
function armPrimaryTripwire() {
  const client = getPgliteClientForTests() as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const method of ["query", "exec", "transaction"]) {
    const original = client[method]!.bind(client);
    client[method] = (...args: unknown[]) => {
      if (primaryArmed) {
        primaryTouches += 1;
        throw new Error(`primary ${method} on the inference hot path`);
      }
      return original(...args);
    };
  }
}

async function createTable(table: PgTable): Promise<void> {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const type = "enumValues" in column && column.enumValues ? "text" : column.getSQLType();
    return `"${column.name}" ${type}`;
  });
  await getPgliteClientForTests().exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}

let sequence = 0;
async function seedKey(): Promise<{ rawKey: string; keyHash: string; id: string }> {
  sequence += 1;
  const rawKey = `eliza_hot_path_key_${sequence}_${Date.now()}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const id = crypto.randomUUID();
  await getPgliteClientForTests().query(
    `INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, is_active,
       usage_count, rate_limit, created_at, updated_at)
     VALUES ($1, $2, $3, 'eliza_ho', $4, $5, true, 0, 1000, now(), now())`,
    [id, `hot-path-${sequence}`, keyHash, ORG, USER],
  );
  return { rawKey, keyHash, id };
}

function admission(): InferenceAdmissionSnapshot {
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
    rateLimits: { completionsRpm: 60, embeddingsRpm: 60, standardRpm: 60, strictRpm: 15 },
    billingHold: false,
  };
}

/** Seed the decision exactly as the hydration projection would have written it. */
async function seedPositiveEntry(
  key: { keyHash: string; id: string },
  overrides: Partial<InferenceAuthContext> = {},
): Promise<void> {
  const ctx: InferenceAuthContext = {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    userId: USER,
    orgId: ORG,
    apiKeyId: key.id,
    apiKeyRateLimit: 1000,
    apiKeyExpiresAt: null,
    keyHash: key.keyHash,
    appScopeId: null,
    admission: admission(),
    ...overrides,
  };
  const outcome = await cache.setWithOutcome(
    CacheKeys.inference.authContext(key.keyHash),
    ctx,
    CacheTTL.inference.authContext,
    { keyClass: "inference_auth" },
  );
  expect(outcome.kind).toBe("written");
}

interface HotPathCall {
  resolution: InferenceAuthResolution;
  /** Primary statements issued before the request returned. */
  touches: number;
  background: Promise<unknown>[];
}

/** One Worker request with the tripwire armed, then its background work. */
async function workerRequest(rawKey: string): Promise<HotPathCall> {
  const background: Promise<unknown>[] = [];
  primaryArmed = true;
  primaryTouches = 0;
  let resolution: InferenceAuthResolution;
  try {
    resolution = await resolveInferenceAuthContext(
      new Request("https://api.eliza.app/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}` },
      }),
      {
        cacheOnly: true,
        executionCtx: {
          waitUntil(task) {
            background.push(task);
          },
        },
      },
    );
  } finally {
    primaryArmed = false;
  }
  return { resolution, touches: primaryTouches, background };
}

async function settle(call: HotPathCall): Promise<void> {
  await Promise.allSettled(call.background);
}

beforeAll(async () => {
  await createTable(organizations);
  await createTable(users);
  await createTable(apiKeys);
  await createTable(userModerationStatus);
  const db = getPgliteClientForTests();
  await db.query(
    `INSERT INTO organizations(id, name, slug, credit_balance, is_active)
     VALUES ($1, 'Hot path org', 'hot-path-org', '5.000000', true)`,
    [ORG],
  );
  await db.query(`INSERT INTO users(id, organization_id, is_active) VALUES ($1, $2, true)`, [
    USER,
    ORG,
  ]);
  armPrimaryTripwire();
});

afterEach(async () => {
  primaryArmed = false;
  primaryTouches = 0;
  __clearInferenceApiKeyHydrations();
  await getPgliteClientForTests().query("DELETE FROM user_moderation_status");
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("primary tripwire", () => {
  test("fires on the authoritative (non-Worker) path, so it can prove the hot path avoids it", async () => {
    const key = await seedKey();
    primaryArmed = true;
    primaryTouches = 0;
    await expect(
      resolveInferenceAuthContext(
        new Request("https://api.eliza.app/api/v1/chat/completions", {
          headers: { Authorization: `Bearer ${key.rawKey}` },
        }),
      ),
    ).rejects.toThrow();
    primaryArmed = false;
    expect(primaryTouches).toBeGreaterThan(0);
  });
});

describe("hosts without a cache backend", () => {
  test("keep the authoritative path, because a miss there could never hydrate", async () => {
    const key = await seedKey();
    const configured = spyOn(cache, "isBackendConfigured").mockReturnValue(false);
    let touched = 0;
    try {
      await workerRequest(key.rawKey);
    } catch {
      // error-policy:J3 the armed tripwire rejects the authoritative read;
      // reaching it is exactly what this test asserts below.
    } finally {
      touched = primaryTouches;
      configured.mockRestore();
    }
    expect(touched).toBeGreaterThan(0);
    const deployed = await workerRequest(key.rawKey);
    expect(deployed.touches).toBe(0);
    await settle(deployed);
  });
});

describe("Worker inference auth never queries Postgres", () => {
  test("a warm entry authorizes with zero primary queries and no refresh", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key);
    const call = await workerRequest(key.rawKey);
    expect(call.touches).toBe(0);
    expect(call.resolution).toMatchObject({
      kind: "authorized",
      source: "cache",
      ctx: { orgId: ORG, userId: USER, apiKeyId: key.id },
    });
    // Only the debounced usage bookkeeping is scheduled off-response.
    expect(call.background).toHaveLength(1);
    await settle(call);
  });

  test("a stale entry is still served with zero primary queries and refreshes off-response", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key, { cachedAt: Date.now() - AUTH_CONTEXT_REFRESH_AFTER_MS * 100 });
    const call = await workerRequest(key.rawKey);
    expect(call.touches).toBe(0);
    expect(call.resolution).toMatchObject({ kind: "authorized", source: "cache" });
    // Usage bookkeeping plus the authoritative refresh and its projection.
    expect(call.background.length).toBeGreaterThan(1);
    await settle(call);
  });

  test("a first-ever miss returns warming with zero primary queries and hydrates under waitUntil", async () => {
    const key = await seedKey();
    // The key is revoked in the primary, so the hydrated decision is a denial
    // this minimal schema can project without admission tables.
    await getPgliteClientForTests().query("UPDATE api_keys SET deleted_at = now() WHERE id = $1", [
      key.id,
    ]);
    const cold = await workerRequest(key.rawKey);
    expect(cold.touches).toBe(0);
    expect(cold.resolution.kind).toBe("warming");
    expect(cold.background.length).toBeGreaterThan(0);
    await settle(cold);

    const next = await workerRequest(key.rawKey);
    expect(next.touches).toBe(0);
    expect(next.resolution).toEqual({
      kind: "rejected",
      status: 401,
      reason: "credential_invalid",
    });
  });

  test("a suspension found by the async refresh makes the next request fail", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key, { cachedAt: Date.now() - AUTH_CONTEXT_REFRESH_AFTER_MS * 2 });
    await getPgliteClientForTests().query(
      `INSERT INTO user_moderation_status(id, user_id, status, total_violations, risk_score, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'banned', 0, 0, now(), now())`,
      [USER],
    );
    // The suspension has not reached the cache yet: one stale allow.
    const stale = await workerRequest(key.rawKey);
    expect(stale.touches).toBe(0);
    expect(stale.resolution.kind).toBe("authorized");
    await settle(stale);

    const next = await workerRequest(key.rawKey);
    expect(next.touches).toBe(0);
    expect(next.resolution).toMatchObject({ kind: "suspended", reason: "moderation_blocked" });
  });

  test("a revocation found by the async refresh makes the next request fail", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key, { cachedAt: Date.now() - AUTH_CONTEXT_REFRESH_AFTER_MS * 2 });
    // A lost writer invalidation: the primary row changes, the cache does not.
    await getPgliteClientForTests().query("UPDATE api_keys SET is_active = false WHERE id = $1", [
      key.id,
    ]);
    const stale = await workerRequest(key.rawKey);
    expect(stale.touches).toBe(0);
    expect(stale.resolution.kind).toBe("authorized");
    await settle(stale);

    const next = await workerRequest(key.rawKey);
    expect(next.touches).toBe(0);
    expect(next.resolution).toEqual({
      kind: "rejected",
      status: 403,
      reason: "credential_inactive",
    });
  });

  test("a stale denial is served without the primary and refreshes back to the current decision", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key, { cachedAt: Date.now() - AUTH_CONTEXT_REFRESH_AFTER_MS * 2 });
    await getPgliteClientForTests().query(
      `INSERT INTO user_moderation_status(id, user_id, status, total_violations, risk_score, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'banned', 0, 0, now(), now())`,
      [USER],
    );
    await settle(await workerRequest(key.rawKey));
    const denied = await workerRequest(key.rawKey);
    expect(denied.touches).toBe(0);
    expect(denied.resolution.kind).toBe("suspended");
    // A fresh denial is not re-authorized on every request.
    expect(denied.background).toHaveLength(0);
  });

  test("writer invalidation turns the next request into warming, never a stale allow", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key);
    expect(await invalidateInferenceAuthContextByKeyHash(key.keyHash)).toBe(true);
    const call = await workerRequest(key.rawKey);
    expect(call.touches).toBe(0);
    expect(call.resolution.kind).toBe("warming");
    await settle(call);
  });

  test("a cached key expiry denies locally with zero primary queries", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key, { apiKeyExpiresAt: Date.now() - 1_000 });
    const call = await workerRequest(key.rawKey);
    expect(call.touches).toBe(0);
    expect(call.resolution).toEqual({
      kind: "rejected",
      status: 401,
      reason: "credential_invalid",
    });
    await settle(call);
  });

  test("an entry is bound to its credential hash: another key's entry never authorizes", async () => {
    const key = await seedKey();
    const other = await seedKey();
    // An entry stored under this key's slot but carrying another key's hash
    // (or org) is malformed and denied as a miss, not served.
    await cache.setWithOutcome(
      CacheKeys.inference.authContext(key.keyHash),
      {
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: USER,
        orgId: OTHER_ORG,
        apiKeyId: other.id,
        apiKeyRateLimit: 1000,
        apiKeyExpiresAt: null,
        keyHash: other.keyHash,
        appScopeId: null,
        admission: admission(),
      } satisfies InferenceAuthContext,
      CacheTTL.inference.authContext,
      { keyClass: "inference_auth" },
    );
    const call = await workerRequest(key.rawKey);
    expect(call.touches).toBe(0);
    expect(call.resolution.kind).toBe("warming");
    await settle(call);
  });
});

describe("Worker billing admission never queries Postgres", () => {
  const leases: string[] = [];
  const gates = {
    getByName(name: string) {
      return {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          leases.push(`${name}${path}`);
          return Response.json({ admitted: true, availableUsd: 10, requiredUsd: 0.1 });
        },
      };
    },
  };
  const bindings = {
    INFERENCE_DEFERRED_ADMISSION: "true",
    INFERENCE_OPTIMISTIC_BILLING: "true",
    INFERENCE_SNAPSHOT_ADMISSION_ENABLED: "false",
    INFERENCE_ADMISSION_GATES: gates,
  };
  const params = (snapshot: InferenceAdmissionSnapshot | undefined) => ({
    context: {
      organizationId: ORG,
      userId: USER,
      model: "openai/gpt-5-mini",
      provider: "openai",
      billingSource: "openai",
      requestId: crypto.randomUUID(),
    },
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    flatCost: { totalCost: 0.1, baseTotalCost: 0.1, platformMarkup: 0 },
    executionCtx: { waitUntil() {} },
    admissionSnapshot: snapshot,
  });

  async function admit(snapshot: InferenceAdmissionSnapshot | undefined) {
    const { admitOrganizationInference } = await import("./organization-inference-admission");
    primaryArmed = true;
    primaryTouches = 0;
    try {
      return await runWithCloudBindingsAsync(bindings, () =>
        admitOrganizationInference(params(snapshot)),
      );
    } finally {
      primaryArmed = false;
    }
  }

  test("a cached snapshot leases from the Durable Object with zero primary queries, even with snapshot admission off", async () => {
    leases.length = 0;
    // An hour-old balance observation is still admitted: the gate fences it.
    const snapshot = admission();
    snapshot.balance.balanceAt = Date.now() - 60 * 60 * 1_000;
    const admitted = await admit(snapshot);
    expect(primaryTouches).toBe(0);
    expect(admitted.mode).toBe("durable_object_debit");
    expect(leases).toEqual([`${ORG}/lease`]);
  });

  test("an active billing hold in the snapshot refuses without the primary", async () => {
    await expect(admit({ ...admission(), billingHold: true })).rejects.toMatchObject({
      name: "BillingHoldActiveError",
    });
    expect(primaryTouches).toBe(0);
  });

  test("no usable snapshot is a retryable warming error, never a primary fallback", async () => {
    await expect(admit(undefined)).rejects.toMatchObject({
      name: "InferenceAdmissionSnapshotWarmingError",
    });
    expect(primaryTouches).toBe(0);
    await expect(admit({ ...admission(), billingHold: undefined })).rejects.toMatchObject({
      name: "InferenceAdmissionSnapshotWarmingError",
    });
    expect(primaryTouches).toBe(0);
  });
});
