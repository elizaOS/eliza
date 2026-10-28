/** Keeps missing configured schedule proof fail-closed during quota admission. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
const { getPgliteClientForTests, closeDatabaseConnectionsForTests } = await import("../client");
const { readOrganizationQuotaPolicy } = await import(
  "../../lib/services/organization-quota-policy"
);
beforeAll(async () => {
  await createBillingSnapshotFixture((q) => getPgliteClientForTests().exec(q), "");
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { billingSubscriptionCommands } = await import(
    "../schemas/subscription-billing-operations"
  );
  for (const c of getTableConfig(billingSubscriptionCommands).columns) {
    const type = "enumValues" in c && c.enumValues ? "text" : c.getSQLType();
    await getPgliteClientForTests().exec(
      `ALTER TABLE billing_subscription_commands ADD COLUMN IF NOT EXISTS "${c.name}" ${type}`,
    );
  }
}, 120000);
afterAll(closeDatabaseConnectionsForTests);
test("quota admission retains configured schedule proof requirement", async () => {
  const { subscriptionAuthorityRepository } = await import("./subscription-authority");
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");

  const org = "61000000-0000-4000-8000-000000000001",
    sub = "62000000-0000-4000-8000-000000000001";
  const current = await subscriptionAuthorityRepository.findById(org, sub);
  if (!current) throw new Error("missing fixture");
  const {
    id: _id,
    organization_id: _org,
    lifecycle_revision,
    created_at: _created,
    updated_at: _updated,
    ...values
  } = current;
  const advanced = await subscriptionAuthorityRepository.advance({
    organizationId: org,
    subscriptionId: sub,
    expectedRevision: lifecycle_revision,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...values,
      current_period_start: new Date(Date.now() - 86400000),
      current_period_end: new Date(Date.now() + 86400000),
      pending_plan_key: current.plan_key === "plus_monthly" ? "pro_monthly" : "plus_monthly",
      provider_object_digest: "d".repeat(64),
    },
  });
  await subscriptionEntitlementsRepository.rebuild({
    organizationId: org,
    sourceSubscriptionId: sub,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: 1,
  });
  await expect(readOrganizationQuotaPolicy(org)).rejects.toMatchObject({
    code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
    context: { reason: "original_scheduled_target_missing" },
  });
}, 120000);
