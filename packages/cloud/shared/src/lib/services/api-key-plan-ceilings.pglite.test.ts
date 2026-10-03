/**
 * API keys are free and their count is plan-limited (#22958): pay-as-you-go 5,
 * Plus 10, Pro 25. Exercises the real key service, organization policy and
 * subscription migrations on PGlite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PLUS_ORG = "61000000-0000-4000-8000-000000000001";
const PLUS_SUB = "62000000-0000-4000-8000-000000000001";
const PAYG_ORG = "61000000-0000-4000-8000-000000000002";
const OTHER_ORG = "61000000-0000-4000-8000-000000000003";
const USER = "63000000-0000-4000-8000-000000000001";

let database: typeof import("../../db/client");
let service: typeof import("./api-keys").apiKeysService;
let ApiKeyLimitExceededError: typeof import("./api-keys").ApiKeyLimitExceededError;

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}

function create(organizationId: string, name: string) {
  return service.createUserManaged({
    name,
    organization_id: organizationId,
    user_id: USER,
    is_active: true,
  });
}

beforeAll(async () => {
  database = await import("../../db/client");
  await createBillingSnapshotFixture(exec, "");
  for (const org of [PAYG_ORG, OTHER_ORG]) {
    await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
      VALUES ('${org}', '0', 1, 0, '{}', true, false, 'active')`);
  }
  ({ apiKeysService: service, ApiKeyLimitExceededError } = await import("./api-keys"));
}, 120_000);

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("API-key plan ceilings (#22958)", () => {
  test("required audit failure rolls back a plan-limited key creation", async () => {
    let observedCreatedKey = false;
    await expect(
      service.createUserManaged(
        { name: "audited", organization_id: OTHER_ORG, user_id: USER, is_active: true },
        async (tx, created) => {
          const result = await tx.execute(sql`SELECT id FROM api_keys WHERE id = ${created.id}`);
          observedCreatedKey = result.rows.length === 1;
          throw new Error("audit unavailable");
        },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(observedCreatedKey).toBe(true);
    expect((await service.getUsage(OTHER_ORG)).used).toBe(0);
  });

  test("the catalogue pins pay-as-you-go 5, Plus 10 and Pro 25", async () => {
    const { API_KEY_CEILINGS, FREE_RESOURCE_CEILINGS, resolveSubscriptionPlanDefinition } =
      await import("./subscription-catalog");
    expect(API_KEY_CEILINGS).toEqual({ free: 5, plus_monthly: 10, pro_monthly: 25 });
    expect(FREE_RESOURCE_CEILINGS.apiKeys).toBe(5);
    expect(resolveSubscriptionPlanDefinition("plus_monthly", "v1").resourceCeilings.apiKeys).toBe(
      10,
    );
    expect(resolveSubscriptionPlanDefinition("pro_monthly", "v1").resourceCeilings.apiKeys).toBe(
      25,
    );
  });

  test("pay-as-you-go admits five user keys, refuses the sixth, and frees a slot on delete", async () => {
    // System-provisioned credentials never count toward the ceiling.
    await exec(`INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, rate_limit, is_active, usage_count, created_at, updated_at, user_created)
      VALUES (gen_random_uuid(), 'Default API Key', 'hash-default', 'eliza_def', '${PAYG_ORG}', '${USER}', 1000, true, 0, now(), now(), false)`);
    for (let index = 1; index <= 5; index += 1) {
      const created = await create(PAYG_ORG, `key ${index}`);
      expect(created.apiKey.user_created).toBe(true);
      expect(created.usage).toEqual({ used: index, limit: 5, remaining: 5 - index });
    }
    const refused = await create(PAYG_ORG, "key 6").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiKeyLimitExceededError);
    expect(refused).toMatchObject({
      code: "API_KEY_LIMIT_EXCEEDED",
      used: 5,
      limit: 5,
      organizationId: PAYG_ORG,
    });
    expect(await service.getUsage(PAYG_ORG)).toEqual({ used: 5, limit: 5, remaining: 0 });

    // A deactivated key still counts; only deletion frees the slot.
    await exec(
      `UPDATE api_keys SET is_active = false WHERE organization_id = '${PAYG_ORG}' AND name = 'key 1'`,
    );
    await expect(create(PAYG_ORG, "key 6")).rejects.toBeInstanceOf(ApiKeyLimitExceededError);
    await exec(
      `UPDATE api_keys SET deleted_at = now() WHERE organization_id = '${PAYG_ORG}' AND name = 'key 1'`,
    );
    expect((await create(PAYG_ORG, "key 6")).usage).toEqual({ used: 5, limit: 5, remaining: 0 });

    // Another organization's keys are counted separately.
    expect((await service.getUsage(OTHER_ORG)).used).toBe(0);
  });

  test("concurrent creates at the ceiling admit exactly one key", async () => {
    for (let index = 1; index <= 4; index += 1) await create(OTHER_ORG, `seed ${index}`);
    const outcomes = await Promise.allSettled([
      create(OTHER_ORG, "race a"),
      create(OTHER_ORG, "race b"),
      create(OTHER_ORG, "race c"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(2);
    for (const outcome of rejected) expect(outcome.reason).toBeInstanceOf(ApiKeyLimitExceededError);
    expect(await service.getUsage(OTHER_ORG)).toEqual({ used: 5, limit: 5, remaining: 0 });
  });

  test("an active Plus subscriber gets ten keys", async () => {
    const { subscriptionAuthorityRepository } = await import(
      "../../db/repositories/subscription-authority"
    );
    const { subscriptionEntitlementsRepository } = await import(
      "../../db/repositories/subscription-entitlements"
    );
    const current = await subscriptionAuthorityRepository.findById(PLUS_ORG, PLUS_SUB);
    if (!current) throw new Error("Expected the Plus subscription fixture");
    const {
      id: _id,
      organization_id: _org,
      lifecycle_revision: _revision,
      created_at: _created,
      updated_at: _updated,
      ...values
    } = current;
    const advanced = await subscriptionAuthorityRepository.advance({
      organizationId: PLUS_ORG,
      subscriptionId: PLUS_SUB,
      expectedRevision: 1,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: {
        ...values,
        current_period_start: new Date(Date.now() - 86_400_000),
        current_period_end: new Date(Date.now() + 86_400_000),
        provider_object_digest: "c".repeat(64),
      },
    });
    await subscriptionEntitlementsRepository.rebuild({
      organizationId: PLUS_ORG,
      sourceSubscriptionId: PLUS_SUB,
      sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
      expectedProjectionRevision: 1,
    });

    for (let index = 1; index <= 10; index += 1) await create(PLUS_ORG, `plus ${index}`);
    await expect(create(PLUS_ORG, "plus 11")).rejects.toMatchObject({
      code: "API_KEY_LIMIT_EXCEEDED",
      limit: 10,
    });
  });
});
