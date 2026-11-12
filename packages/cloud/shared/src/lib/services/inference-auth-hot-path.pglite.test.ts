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
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { BillingHoldActiveError } from "./billing-hold";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
setDefaultTimeout(120_000);

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../db/client";
import { apiKeys } from "../../db/schemas/api-keys";
import { mobileAppAuthGrants } from "../../db/schemas/mobile-app-auth-grants";
import { userModerationStatus } from "../../db/schemas/moderation-violations";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import { apiKeysService } from "./api-keys";
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
/** Count primary statements without failing them (cold-fill assertions). */
let primaryCounting = false;
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
      if (primaryCounting) primaryTouches += 1;
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
const qualifiedBindings = {
  INFERENCE_ADMISSION_GATES: {
    getByName() {
      return {
        async fetch() {
          return Response.json({ allowed: true, committed: true });
        },
      };
    },
  },
};

async function workerRequest(
  rawKey: string,
  bindings: Record<string, unknown> = qualifiedBindings,
  primary: "trip" | "count" = "trip",
): Promise<HotPathCall> {
  const background: Promise<unknown>[] = [];
  primaryArmed = primary === "trip";
  primaryCounting = primary === "count";
  primaryTouches = 0;
  let resolution: InferenceAuthResolution;
  try {
    resolution = await runWithCloudBindingsAsync(bindings, () =>
      resolveInferenceAuthContext(
        new Request("https://api.eliza.app/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${rawKey}` },
        }),
        {
          executionCtx: {
            waitUntil(task) {
              background.push(task);
            },
          },
        },
      ),
    );
  } finally {
    primaryArmed = false;
    primaryCounting = false;
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
  // Mobile revocation reads the credential's sign-in session from its grant.
  await createTable(mobileAppAuthGrants);
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

describe("hosts without the organization gate", () => {
  test("read the primary and never consult or write the authorization cache", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key);
    await getPgliteClientForTests().query("UPDATE api_keys SET is_active = false WHERE id = $1", [
      key.id,
    ]);
    let trace: import("./inference-auth-context").InferenceAuthTelemetry | undefined;
    await expect(
      runWithCloudBindingsAsync({}, () =>
        resolveInferenceAuthContext(
          new Request("https://api.eliza.app/api/v1/chat/completions", {
            headers: { Authorization: `Bearer ${key.rawKey}` },
          }),
          {
            executionCtx: { waitUntil() {} },
            onTelemetry(value) {
              trace = value;
            },
          },
        ),
      ),
    ).rejects.toThrow();
    expect(trace?.cacheRead).toBe("not_run");
    expect(trace?.authoritative).toBe("rejected");
    expect(trace?.cacheWrite).toBe("not_run");
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

  test("a first-ever miss is decided by the primary once and its decision is projected under waitUntil", async () => {
    const key = await seedKey();
    // The key is revoked in the primary, so the hydrated decision is a denial
    // this minimal schema can project without admission tables.
    await getPgliteClientForTests().query("UPDATE api_keys SET deleted_at = now() WHERE id = $1", [
      key.id,
    ]);
    const cold = await workerRequest(key.rawKey, qualifiedBindings, "count");
    expect(cold.touches).toBeGreaterThan(0);
    expect(cold.resolution).toEqual({
      kind: "rejected",
      status: 401,
      reason: "credential_invalid",
    });
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

  test("writer invalidation sends the next request to the primary, never a stale allow", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key);
    await getPgliteClientForTests().query("UPDATE api_keys SET is_active = false WHERE id = $1", [
      key.id,
    ]);
    expect(await invalidateInferenceAuthContextByKeyHash(key.keyHash)).toBe(true);
    const call = await workerRequest(key.rawKey, qualifiedBindings, "count");
    expect(call.touches).toBeGreaterThan(0);
    expect(call.resolution).toEqual({
      kind: "rejected",
      status: 403,
      reason: "credential_inactive",
    });
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
    // The primary decides instead: this key is revoked there.
    await getPgliteClientForTests().query("UPDATE api_keys SET deleted_at = now() WHERE id = $1", [
      key.id,
    ]);
    const call = await workerRequest(key.rawKey, qualifiedBindings, "count");
    expect(call.touches).toBeGreaterThan(0);
    expect(call.resolution).toMatchObject({ kind: "rejected", status: 401 });
    await settle(call);
  });
});

describe("Worker credential checks include cold gate routing", () => {
  for (const allowed of [true, false]) {
    test(`a cold gate reply remains authoritative when allowed=${allowed}`, async () => {
      const key = await seedKey();
      await seedPositiveEntry(key);
      const bindings = {
        INFERENCE_ADMISSION_GATES: {
          getByName() {
            return {
              async fetch(request: Request) {
                expect(new URL(request.url).pathname).toBe("/credential/check");
                // Production routing took about two seconds before the gate
                // handler ran; the authorization reply still decides the result.
                await new Promise<void>((resolve, reject) => {
                  const abort = () => {
                    clearTimeout(timer);
                    reject(request.signal.reason);
                  };
                  const timer = setTimeout(() => {
                    request.signal.removeEventListener("abort", abort);
                    resolve();
                  }, 2_000);
                  request.signal.addEventListener("abort", abort, { once: true });
                  if (request.signal.aborted) abort();
                });
                return allowed
                  ? Response.json({ allowed: true })
                  : Response.json(
                      { allowed: false, reason: "credential_revoked" },
                      { status: 403 },
                    );
              },
            };
          },
        },
      };
      const result = await workerRequest(key.rawKey, bindings);
      expect(result.touches).toBe(0);
      expect(result.resolution).toMatchObject(
        allowed
          ? { kind: "authorized" }
          : { kind: "rejected", status: 401, reason: "credential_inactive" },
      );
      await settle(result);
    });
  }

  test("an unresponsive gate still fails closed without a primary fallback", async () => {
    const key = await seedKey();
    await seedPositiveEntry(key);
    const bindings = {
      INFERENCE_ADMISSION_GATES: {
        getByName: () => ({
          fetch: (request: Request) =>
            new Promise<Response>((_resolve, reject) => {
              const abort = () => reject(request.signal.reason);
              request.signal.addEventListener("abort", abort, { once: true });
              if (request.signal.aborted) abort();
            }),
        }),
      },
    };
    await expect(workerRequest(key.rawKey, bindings)).rejects.toMatchObject({
      name: "InferenceCredentialRevocationUnavailableError",
      statusCode: 503,
    });
    expect(primaryTouches).toBe(0);
  }, 10_000);
});

describe("Worker billing admits from the snapshot and the organization gate only", () => {
  const admit = async (
    snapshot: InferenceAdmissionSnapshot,
    gate: (path: string) => Response,
    background: Promise<unknown>[] = [],
  ) => {
    const { admitOrganizationInference } = await import("./organization-inference-admission");
    return runWithCloudBindingsAsync(
      {
        INFERENCE_ADMISSION_GATES: {
          getByName() {
            return {
              async fetch(request: Request) {
                return gate(new URL(request.url).pathname);
              },
            };
          },
        },
      },
      () =>
        admitOrganizationInference({
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
          executionCtx: {
            waitUntil(task) {
              background.push(task);
            },
          },
          admissionSnapshot: snapshot,
        }),
    );
  };

  test("a cached hold refuses paid admission without a primary read", async () => {
    primaryArmed = true;
    primaryTouches = 0;
    try {
      await expect(
        admit({ ...admission(), billingHold: true }, () => Response.json({ admitted: true })),
      ).rejects.toThrow(BillingHoldActiveError);
      expect(primaryTouches).toBe(0);
    } finally {
      primaryArmed = false;
    }
  });

  test("a cached clear hold is admitted by the gate lease without a primary read", async () => {
    primaryArmed = true;
    primaryTouches = 0;
    const paths: string[] = [];
    try {
      const result = await admit(admission(), (path) => {
        paths.push(path);
        return Response.json({ admitted: true, availableUsd: 9.9, requiredUsd: 0.1 });
      });
      expect(result.mode).toBe("durable_object_debit");
      expect(paths[0]).toMatch(/^\/lease/);
      expect(primaryTouches).toBe(0);
    } finally {
      primaryArmed = false;
    }
  });

  /** A snapshot far older than the shared projection lifetime. */
  const aged = (overrides: Partial<InferenceAdmissionSnapshot> = {}) => ({
    ...admission(),
    balance: { balanceUsd: 10, balanceAt: Date.now() - 10 * 60_000, balanceRevision: "1" },
    ...overrides,
  });

  // The tripwire stays armed through the scheduled refresh: every primary
  // statement throws, so a request that still returns its decision did not
  // wait for the primary, and the counted statement is the refresh's own.
  test("an aged snapshot decides its request and is refreshed from the primary off the response", async () => {
    const background: Promise<unknown>[] = [];
    primaryArmed = true;
    primaryTouches = 0;
    try {
      const result = await admit(
        aged(),
        () => Response.json({ admitted: true, availableUsd: 9.9, requiredUsd: 0.1 }),
        background,
      );
      expect(result.mode).toBe("durable_object_debit");
      expect(background).toHaveLength(1);
      await Promise.allSettled(background);
      expect(primaryTouches).toBeGreaterThan(0);
    } finally {
      primaryArmed = false;
    }
  });

  test("a fresh snapshot schedules no refresh", async () => {
    const background: Promise<unknown>[] = [];
    await admit(
      admission(),
      () => Response.json({ admitted: true, availableUsd: 9.9, requiredUsd: 0.1 }),
      background,
    );
    expect(background).toHaveLength(0);
  });

  test("an aged hold refusal stands for its request and is refreshed off the response", async () => {
    const background: Promise<unknown>[] = [];
    primaryArmed = true;
    primaryTouches = 0;
    try {
      await expect(
        admit(aged({ billingHold: true }), () => Response.json({ admitted: true }), background),
      ).rejects.toThrow(BillingHoldActiveError);
      expect(background.length).toBeGreaterThan(0);
      await Promise.allSettled(background);
      expect(primaryTouches).toBeGreaterThan(0);
    } finally {
      primaryArmed = false;
    }
  });

  // The auth entry keeps carrying the held snapshot until its own refresh;
  // the refill that the first refusal scheduled is what later requests use.
  test("a carried hold yields to the newer published snapshot without a primary read", async () => {
    const { resetInferenceAdmissionMemoryCacheForTests } = await import(
      "./inference-admission-snapshot"
    );
    const key = CacheKeys.inference.orgAdmission(ORG);
    resetInferenceAdmissionMemoryCacheForTests();
    await cache.setWithOutcome(key, admission(), CacheTTL.inference.orgAdmission);
    primaryArmed = true;
    primaryTouches = 0;
    try {
      const result = await admit(aged({ billingHold: true }), () =>
        Response.json({ admitted: true, availableUsd: 9.9, requiredUsd: 0.1 }),
      );
      expect(result.mode).toBe("durable_object_debit");
      expect(primaryTouches).toBe(0);
    } finally {
      primaryArmed = false;
      await cache.del(key);
      resetInferenceAdmissionMemoryCacheForTests();
    }
  });
});

describe("mobile lifecycle cache fences", () => {
  for (const method of ["presented", "account", "exact"] as const) {
    test(`${method} revocation rejects a retained positive entry without a primary read in the qualified cache lane`, async () => {
      const rawKey = `eliza_mobile_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
      const key = {
        rawKey,
        keyHash: createHash("sha256").update(rawKey).digest("hex"),
        id: crypto.randomUUID(),
      };
      const app = "93000000-0000-4000-8000-000000000001";
      await getPgliteClientForTests().query(
        `INSERT INTO api_keys(id,name,key_hash,key_prefix,organization_id,user_id,is_active,
           usage_count,rate_limit,source_app_id,expires_at,created_at,updated_at)
         VALUES ($1,'mobile-cache-fence',$2,'eliza_mobile_',$3,$4,true,0,1000,$5,now()+interval '1 hour',now(),now())`,
        [key.id, key.keyHash, ORG, USER, app],
      );
      await seedPositiveEntry(key);
      const revoked = new Set<string>();
      const calls: string[] = [];
      let unavailable = false;
      const bindings = {
        VOICE_SPEECH_RELAY_ENABLED: "false",
        INFERENCE_ADMISSION_GATES: {
          getByName(organizationId: string) {
            expect(organizationId).toBe(ORG);
            return {
              async fetch(request: Request) {
                if (unavailable) throw new Error("fixture boundary unavailable");
                const body = (await request.json()) as { credentialId: string };
                const path = new URL(request.url).pathname;
                calls.push(path);
                if (path === "/credential/revoke") {
                  revoked.add(body.credentialId);
                  return Response.json({ committed: true });
                }
                expect(path).toBe("/credential/check");
                return revoked.has(body.credentialId)
                  ? Response.json({ allowed: false, reason: "credential_revoked" }, { status: 403 })
                  : Response.json({ allowed: true });
              },
            };
          },
        },
      };
      await runWithCloudBindingsAsync(bindings, async () => {
        const before = await workerRequest(rawKey, bindings);
        expect(before.resolution.kind).toBe("authorized");
        expect(before.touches).toBe(0);
        await settle(before);
        const revoke = () =>
          method === "presented"
            ? apiKeysService.revokePresentedMobileCredential(rawKey)
            : method === "account"
              ? apiKeysService.revokeMobileCredentialForAccount(key.id, USER, ORG)
              : apiKeysService.revokeExactMobileCredential({
                  id: key.id,
                  key_hash: key.keyHash,
                  source_app_id: app,
                });
        const first = await revoke();
        expect(first?.revokedNow).toBe(true);
        const rows = await getPgliteClientForTests().query<{
          is_active: boolean;
          deleted_at: Date | null;
        }>("SELECT is_active,deleted_at FROM api_keys WHERE id=$1", [key.id]);
        expect(rows.rows[0]?.is_active).toBe(false);
        expect(rows.rows[0]?.deleted_at).not.toBeNull();
        // An independent location can retain a positive cache value after deletion
        // or an earlier hydration can refill it. Neither may override the fence.
        await seedPositiveEntry(key);
        const after = await workerRequest(rawKey, bindings);
        expect(after.resolution).toMatchObject({
          kind: "rejected",
          status: 401,
          reason: "credential_inactive",
        });
        expect(after.touches).toBe(0);
        await settle(after);
        const retry = await revoke();
        expect(retry?.revokedNow).toBe(false);
        expect(retry?.receipt).toEqual(first?.receipt);
        expect(calls.filter((path) => path === "/credential/revoke")).toHaveLength(2);
        await seedPositiveEntry(key);
        unavailable = true;
        await expect(workerRequest(rawKey, bindings)).rejects.toThrow(
          "revocation boundary is unavailable",
        );
        expect(primaryTouches).toBe(0);
      });
    });
  }
});
