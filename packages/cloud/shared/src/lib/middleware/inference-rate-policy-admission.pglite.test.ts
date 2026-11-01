/**
 * Rate-policy admission (`INFERENCE_RATE_POLICY_ADMISSION`) decides a warm
 * request from the cached proof with one Durable Object call and no primary
 * query. Anything other than an allow or a counter denial falls back to the
 * unchanged primary path, which re-reads the tier and key cap under the policy
 * lock. The Durable Object side of the fence is covered by
 * api/__tests__/inference-rate-policy.miniflare.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";
import type { InferenceAdmissionSnapshot } from "../services/inference-auth-cache";
import type { InferenceBudgetPolicy } from "../services/inference-funded-budget-admission";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "61000000-0000-4000-8000-000000000021";
const OTHER_ORG = "61000000-0000-4000-8000-000000000022";
const USER = "63000000-0000-4000-8000-000000000021";
const KEY = "64000000-0000-4000-8000-000000000021";

let database: typeof import("../../db/client");
let rateLimit: typeof import("./rate-limit");
let cloudBindings: typeof import("../runtime/cloud-bindings");
let authCache: typeof import("../services/inference-auth-cache");

interface GateCall {
  name: string;
  path: string;
  body: Record<string, unknown>;
}
type GateReply = (call: GateCall) => Response | Promise<Response>;

let calls: GateCall[] = [];
let primaryArmed = false;
let primaryTouches = 0;

const allowed = () =>
  Response.json({ allowed: true, remaining: 3, resetAt: Date.now() + 60_000 }, { status: 200 });
const denied = () =>
  Response.json(
    { allowed: false, remaining: 0, resetAt: Date.now() + 60_000, retryAfter: 30 },
    { status: 429 },
  );

function namespace(reply: GateReply) {
  return {
    getByName(name: string) {
      return {
        async fetch(request: Request) {
          const call = {
            name,
            path: new URL(request.url).pathname,
            body: (await request.json()) as Record<string, unknown>,
          };
          calls.push(call);
          return reply(call);
        },
      };
    },
  };
}

function policy(overrides: Partial<InferenceBudgetPolicy> = {}): InferenceBudgetPolicy {
  return {
    organizationId: ORG,
    enabled: false,
    rateEnabled: true,
    epoch: "7",
    policyGeneration: "3",
    validUntil: Number.MAX_SAFE_INTEGER,
    rateLimits: { completionsRpm: 60, embeddingsRpm: 60, standardRpm: 60, strictRpm: 15 },
    ...overrides,
  };
}

function proof(overrides: Partial<InferenceBudgetPolicy> = {}) {
  return {
    policy: policy(overrides),
    credential: {
      kind: "api_key" as const,
      credentialId: KEY,
      userId: USER,
      rateLimit: 100,
      expiresAt: null,
    },
  };
}

async function enforce(
  reply: GateReply,
  options: {
    enabled?: boolean;
    ratePolicy?: ReturnType<typeof proof>;
    apiKeyId?: string;
  } = {},
) {
  return cloudBindings.runWithCloudBindingsAsync(
    {
      INFERENCE_RATE_POLICY_ADMISSION: String(options.enabled ?? true),
      INFERENCE_STRONG_REVOCATION_ENABLED: "true",
      INFERENCE_ADMISSION_GATES: namespace(reply),
    },
    () =>
      rateLimit.enforceOrgRateLimit(ORG, "embeddings", {
        cacheOnly: true,
        executionCtx: { waitUntil() {} },
        apiKeyId: options.apiKeyId ?? KEY,
        ratePolicy: "ratePolicy" in options ? options.ratePolicy : proof(),
      }),
  );
}

/** Any primary use while armed throws, so a warm decision cannot hide a query. */
function armPrimaryTripwire() {
  const client = database.getPgliteClientForTests() as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const method of ["query", "exec", "transaction"]) {
    const original = client[method]!.bind(client);
    client[method] = (...args: unknown[]) => {
      if (primaryArmed) {
        primaryTouches += 1;
        throw new Error(`primary ${method} on the warm rate path`);
      }
      return original(...args);
    };
  }
}

beforeAll(async () => {
  database = await import("../../db/client");
  const exec = async (query: string) => {
    await database.getPgliteClientForTests().exec(query);
  };
  await createBillingSnapshotFixture(exec, "");
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '0', 1, 0, '{}', true, false, 'active')`);
  await exec(`INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, rate_limit, is_active, usage_count, created_at, updated_at, user_created) VALUES
    ('${KEY}', 'capped', 'rp-h1', 'rp-p1', '${ORG}', '${USER}', 100, true, 0, now(), now(), false)`);
  rateLimit = await import("./rate-limit");
  cloudBindings = await import("../runtime/cloud-bindings");
  authCache = await import("../services/inference-auth-cache");
  armPrimaryTripwire();
}, 120_000);

afterEach(() => {
  calls = [];
  primaryArmed = false;
  primaryTouches = 0;
});

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("warm rate-policy admission", () => {
  test("the tripwire catches the primary path, so it can prove the warm path avoids it", async () => {
    primaryArmed = true;
    await expect(enforce(allowed, { enabled: false })).rejects.toThrow("primary");
    expect(primaryTouches).toBeGreaterThan(0);
  });

  test("an allow is one organization-object call and zero primary queries", async () => {
    primaryArmed = true;
    expect(await enforce(allowed)).toBeNull();
    expect(primaryTouches).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: ORG,
      path: "/rate-policy/rate",
      body: {
        organizationId: ORG,
        endpointType: "embeddings",
        policyEpoch: "7",
        policyGeneration: "3",
        credential: { kind: "api_key", credentialId: KEY, userId: USER, rateLimit: 100 },
      },
    });
  });

  test("a counter denial is returned without the primary", async () => {
    primaryArmed = true;
    const response = await enforce(denied);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(primaryTouches).toBe(0);
  });
});

describe("fallback to the primary path", () => {
  // The primary path's own counter call; it receives the locked primary tier and key cap.
  const primaryCounter: GateReply = (call) =>
    call.path === "/rate-policy/rate"
      ? Response.json({ error: "Credential policy proof is stale" }, { status: 503 })
      : allowed();

  for (const [reason, reply] of [
    ["stale epoch, pending mutation or revoked key", primaryCounter],
    [
      "revoked credential",
      (call: GateCall) =>
        call.path === "/rate-policy/rate"
          ? Response.json({ error: "revoked" }, { status: 403 })
          : allowed(),
    ],
    [
      "unreachable organization object",
      (call: GateCall) => {
        if (call.path === "/rate-policy/rate") throw new Error("connection reset");
        return allowed();
      },
    ],
  ] as const) {
    test(`${reason} re-decides on the primary path`, async () => {
      expect(await enforce(reply)).toBeNull();
      expect(calls.map((call) => call.path)).toEqual(["/rate-policy/rate", "/rate-limit"]);
      // Free-tier embeddings from the locked primary; the 100/min key cap is
      // read again rather than taken from the refused proof.
      expect(calls[1]).toMatchObject({
        name: `rate-limit:v2:${ORG}`,
        body: {
          endpointType: "embeddings",
          maxRequests: 100,
          apiKey: { id: KEY, maxRequests: 100 },
        },
      });
    });
  }

  test("a primary-path denial after fallback still denies", async () => {
    const response = await enforce((call) =>
      call.path === "/rate-policy/rate"
        ? Response.json({ error: "pending" }, { status: 503 })
        : denied(),
    );
    expect(response?.status).toBe(429);
  });

  for (const [reason, options] of [
    ["another tenant's policy", { ratePolicy: proof({ organizationId: OTHER_ORG }) }],
    ["a different presenting key", { apiKeyId: "64000000-0000-4000-8000-0000000000ff" }],
    ["a disabled rate policy", { ratePolicy: proof({ rateEnabled: false }) }],
    ["an expired policy deadline", { ratePolicy: proof({ validUntil: Date.now() - 1 }) }],
    ["the flag off", { enabled: false }],
    ["no proof", { ratePolicy: undefined }],
  ] as const) {
    test(`${reason} never reaches the rate-policy object`, async () => {
      const response = await enforce(allowed, options);
      expect(calls.some((call) => call.path === "/rate-policy/rate")).toBe(false);
      if (reason === "a different presenting key") {
        // The unknown key is refused by the primary path, exactly as before.
        expect(response?.status).toBe(503);
      } else {
        expect(response).toBeNull();
        expect(calls.map((call) => call.path)).toEqual(["/rate-limit"]);
      }
    });
  }
});

describe("proof construction", () => {
  const snapshot = (ratePolicy?: InferenceBudgetPolicy) =>
    ({ ratePolicy }) as unknown as InferenceAdmissionSnapshot;
  const ctx = {
    orgId: ORG,
    userId: USER,
    apiKeyId: KEY,
    apiKeyRateLimit: 100,
    apiKeyExpiresAt: null,
    admission: { ratePolicy: policy() },
  };

  test("only a complete API-key context of the same organization yields a proof", () => {
    expect(rateLimit.inferenceRatePolicyProof(ctx)).toEqual(proof());
    expect(rateLimit.inferenceRatePolicyProof({ ...ctx, orgId: OTHER_ORG })).toBeUndefined();
    expect(rateLimit.inferenceRatePolicyProof({ ...ctx, apiKeyId: null })).toBeUndefined();
    expect(
      rateLimit.inferenceRatePolicyProof({ ...ctx, apiKeyRateLimit: undefined }),
    ).toBeUndefined();
    expect(
      rateLimit.inferenceRatePolicyProof({ ...ctx, apiKeyExpiresAt: undefined }),
    ).toBeUndefined();
    expect(
      rateLimit.inferenceRatePolicyProof({
        ...ctx,
        admission: { ratePolicy: policy({ rateEnabled: false }) },
      }),
    ).toBeUndefined();
  });

  test("a cache write keeps the proof only when the epoch matches the key-cap read", () => {
    const fresh = snapshot(policy());
    expect(authCache.withCoherentRatePolicy(snapshot(policy()), fresh)).toBe(fresh);
    expect(
      authCache.withCoherentRatePolicy(snapshot(policy({ epoch: "6" })), fresh).ratePolicy,
    ).toBeUndefined();
    expect(authCache.withCoherentRatePolicy(snapshot(), fresh).ratePolicy).toBeUndefined();
    expect(authCache.withCoherentRatePolicy(undefined, fresh).ratePolicy).toBeUndefined();
  });
});
