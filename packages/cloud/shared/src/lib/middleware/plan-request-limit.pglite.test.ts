/**
 * Plan burst and sustained buckets on the real organization rate limit
 * (AlphaCompute/alphaphone#410). Admitted completions still run the locked
 * policy transaction; a refused one returns 429 before it, so a refusal stays
 * available while the billing database is down.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "61000000-0000-4000-8000-00000000a410";
const USER = "63000000-0000-4000-8000-00000000a410";
const OTHER_USER = "63000000-0000-4000-8000-00000000b410";

let database: typeof import("../../db/client");
let rateLimit: typeof import("./rate-limit");
let snapshots: typeof import("../services/inference-admission-snapshot");
let limiter: typeof import("../services/plan-request-limiter");

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

beforeAll(async () => {
  database = await import("../../db/client");
  await createBillingSnapshotFixture(exec, "");
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '0', 1, 0, '{}', true, false, 'active')`);
  rateLimit = await import("./rate-limit");
  snapshots = await import("../services/inference-admission-snapshot");
  limiter = await import("../services/plan-request-limiter");
}, 120_000);

afterAll(async () => {
  delete process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS;
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("plan request buckets before the policy transaction (#410)", () => {
  test("the snapshot plan keys the buckets; refusal is a 429 with retry data", async () => {
    const snapshot = await snapshots.loadInferenceAdmissionSnapshot(ORG);
    const config = snapshots.inferenceRateLimitConfig(snapshot, "completions");
    expect(config?.planKey).toBe(snapshot.planKey);
    expect(typeof snapshot.planKey).toBe("string");

    limiter.resetPlanRequestLimiterForTests();
    process.env.ELIZA_CLOUD_PLAN_RATE_LIMITS = JSON.stringify({
      selected: false,
      plans: {
        default: {
          burst: { capacity: 1, refillPerSecond: 0.001 },
          sustained: { capacity: 10, refillPerSecond: 0.001 },
        },
        [snapshot.planKey as string]: {
          burst: { capacity: 2, refillPerSecond: 0.001 },
          sustained: { capacity: 10, refillPerSecond: 0.001 },
        },
      },
    });
    const call = (userId: string) =>
      rateLimit.enforceOrgRateLimit(ORG, "completions", { config, userId });

    expect(await call(USER)).toBeNull();
    expect(await call(USER)).toBeNull();
    const refused = await call(USER);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("X-RateLimit-Policy")).toBe("plan-token-bucket");
    const body = (await refused?.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: "rate_limited",
      plan: { id: snapshot.planKey },
      limit: { bucket: "burst", capacity: 2, selected: false },
    });
    expect(Number(refused?.headers.get("Retry-After"))).toBe(
      body.error.retryAfterSeconds as number,
    );
    // Another account on the same organization has its own buckets.
    expect(await call(OTHER_USER)).toBeNull();
    // Other endpoint types never consume plan request buckets.
    expect(await rateLimit.enforceOrgRateLimit(ORG, "embeddings", { config })).toBeNull();
  });

  test("a cache miss uses the default limits, and a refusal needs no database", async () => {
    // No snapshot config: the default plan (burst capacity 1) applies.
    expect(await rateLimit.enforceOrgRateLimit(ORG, "completions", { userId: USER })).toBeNull();
    await database.closeDatabaseConnectionsForTests();
    const refused = await rateLimit.enforceOrgRateLimit(ORG, "completions", { userId: USER });
    if (!refused) throw new Error("expected a plan bucket refusal");
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: { plan: { id: string } } };
    expect(body.error.plan.id).toBe("default");
  });
});
