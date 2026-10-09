/**
 * Per-key `api_keys.rate_limit` is enforced as a cap under the plan tier
 * (#22958). Exercises the cap resolution and the fail-closed missing-key path
 * against the real policy transaction on PGlite; the Durable Object window is
 * covered by inference-admission-gate.miniflare.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "61000000-0000-4000-8000-000000000009";
const OTHER_ORG = "61000000-0000-4000-8000-000000000001";
const USER = "63000000-0000-4000-8000-000000000001";
const LOW_KEY = "64000000-0000-4000-8000-000000000001";
const DEFAULT_KEY = "64000000-0000-4000-8000-000000000002";
const FOREIGN_KEY = "64000000-0000-4000-8000-000000000003";

let database: typeof import("../../db/client");
let rateLimit: typeof import("./rate-limit");
let admission: typeof import("../services/organization-policy-admission");
let quota: typeof import("../services/organization-quota-policy");

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

beforeAll(async () => {
  database = await import("../../db/client");
  await createBillingSnapshotFixture(exec, "");
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${ORG}', '0', 1, 0, '{}', true, false, 'active')`);
  await exec(`INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, rate_limit, is_active, usage_count, created_at, updated_at, user_created) VALUES
    ('${LOW_KEY}', 'explorer', 'h1', 'p1', '${ORG}', '${USER}', 100, true, 0, now(), now(), false),
    ('${DEFAULT_KEY}', 'default', 'h2', 'p2', '${ORG}', '${USER}', 1000, true, 0, now(), now(), true),
    ('${FOREIGN_KEY}', 'foreign', 'h3', 'p3', '${OTHER_ORG}', '${USER}', 5, true, 0, now(), now(), true)`);
  rateLimit = await import("./rate-limit");
  admission = await import("../services/organization-policy-admission");
  quota = await import("../services/organization-quota-policy");
}, 120_000);

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

async function cap(apiKeyId: string) {
  return admission.withOrganizationPolicyReadAdmission(ORG, undefined, (policy, tx) =>
    rateLimit.readApiKeyRateLimit(tx, ORG, apiKeyId, quota.requireOrganizationRateTier(policy)),
  );
}

describe("per-key rate_limit under the plan tier (#22958)", () => {
  test("a key cap below the plan tier binds; the default never raises or binds", async () => {
    // The pay-as-you-go free tier sums to 195 requests per minute.
    expect(await cap(LOW_KEY)).toEqual({ id: LOW_KEY, maxRequests: 100 });
    expect(await cap(DEFAULT_KEY)).toBeNull();
  });

  test("a key from another organization or a deleted key fails closed", async () => {
    expect(await cap(FOREIGN_KEY)).toBe("missing");
    expect(await cap("64000000-0000-4000-8000-00000000dead")).toBe("missing");
    const response = await rateLimit.enforceOrgRateLimit(ORG, "completions", {
      apiKeyId: FOREIGN_KEY,
    });
    expect(response?.status).toBe(503);
  });
});
