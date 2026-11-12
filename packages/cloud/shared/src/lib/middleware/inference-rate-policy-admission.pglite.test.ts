/**
 * A Worker inference request is rate-limited from the cached admission
 * snapshot alone: the tier and key cap carried by the combined auth decision,
 * counted in this isolate's request windows. No Durable Object call and no
 * primary query precedes the provider, whatever the organization's cached
 * rate or budget policy says and whichever admission flags are set. The
 * Durable Object side of the rate-policy fence is covered by
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

/** The combined auth decision's admission snapshot: free-tier limits at generation 3. */
function admissionSnapshot(
  overrides: Partial<InferenceAdmissionSnapshot> = {},
): InferenceAdmissionSnapshot {
  return {
    authority: {
      generation: "3",
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
    rateLimits: { completionsRpm: 60, embeddingsRpm: 100, standardRpm: 60, strictRpm: 15 },
    billingHold: false,
    ...overrides,
  };
}

async function enforce(
  reply: GateReply,
  options: {
    ratePolicyFlag?: boolean;
    fundedBudgetFlag?: boolean;
    snapshot?: InferenceAdmissionSnapshot;
    apiKeyId?: string;
    cacheOnly?: boolean;
  } = {},
) {
  return cloudBindings.runWithCloudBindingsAsync(
    {
      INFERENCE_RATE_POLICY_ADMISSION: String(options.ratePolicyFlag ?? true),
      INFERENCE_FUNDED_BUDGET_ADMISSION: String(options.fundedBudgetFlag ?? false),
      INFERENCE_ADMISSION_GATES: namespace(reply),
    },
    () =>
      rateLimit.enforceOrgRateLimit(ORG, "embeddings", {
        cacheOnly: options.cacheOnly ?? true,
        executionCtx: { waitUntil() {} },
        apiKeyId: options.apiKeyId ?? KEY,
        apiKeyRateLimit: 100,
        admissionSnapshot: options.snapshot ?? admissionSnapshot({ ratePolicy: policy() }),
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
  rateLimit.__clearIsolateRateWindows();
  calls = [];
  primaryArmed = false;
  primaryTouches = 0;
});

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("Worker rate admission", () => {
  test("the tripwire catches the primary path, so it can prove the warm path avoids it", async () => {
    primaryArmed = true;
    // Only a non-Worker caller still runs the locked primary policy path.
    await expect(enforce(allowed, { ratePolicyFlag: false, cacheOnly: false })).rejects.toThrow(
      "primary",
    );
    expect(primaryTouches).toBeGreaterThan(0);
  });

  for (const [name, options] of [
    ["a cached rate policy with its flag on", {}],
    ["the rate-policy flag off", { ratePolicyFlag: false }],
    ["no cached rate policy", { snapshot: admissionSnapshot() }],
    [
      "a funded budget with INFERENCE_FUNDED_BUDGET_ADMISSION on",
      {
        fundedBudgetFlag: true,
        snapshot: admissionSnapshot({
          fundedBudget: policy({ enabled: true }),
          ratePolicy: policy({ enabled: true }),
        }),
      },
    ],
    ["a different presenting key", { apiKeyId: "64000000-0000-4000-8000-0000000000ff" }],
  ] as const) {
    test(`${name} is admitted with no organization-object call and no primary query`, async () => {
      primaryArmed = true;
      expect(await enforce(allowed, options)).toBeNull();
      expect(calls).toEqual([]);
      expect(primaryTouches).toBe(0);
    });
  }

  test("the cached key cap denies in the isolate window", async () => {
    primaryArmed = true;
    // Embeddings tier and the 100/min key cap come from the cached auth decision.
    for (let sent = 1; sent <= 100; sent += 1) expect(await enforce(allowed)).toBeNull();
    const response = await enforce(allowed);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response?.headers.get("X-RateLimit-Policy")).toBe("in-memory");
    expect(calls).toEqual([]);
    expect(primaryTouches).toBe(0);
  });
});

describe("cached rate policy", () => {
  const snapshot = (ratePolicy?: InferenceBudgetPolicy) =>
    ({ ratePolicy }) as unknown as InferenceAdmissionSnapshot;

  test("a cache write keeps the policy only when the epoch matches the key-cap read", () => {
    const fresh = snapshot(policy());
    expect(authCache.withCoherentRatePolicy(snapshot(policy()), fresh)).toBe(fresh);
    expect(
      authCache.withCoherentRatePolicy(snapshot(policy({ epoch: "6" })), fresh).ratePolicy,
    ).toBeUndefined();
    expect(authCache.withCoherentRatePolicy(snapshot(), fresh).ratePolicy).toBeUndefined();
    expect(authCache.withCoherentRatePolicy(undefined, fresh).ratePolicy).toBeUndefined();
  });
});
