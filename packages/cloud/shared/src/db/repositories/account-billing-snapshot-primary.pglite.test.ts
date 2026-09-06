/** Exercises the production primary snapshot against migrated PGlite rows; independent PostgreSQL sessions own concurrent-commit coverage. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
let database: typeof import("../client");
beforeAll(async () => {
  database = await import("../client");
  const pglite = database.getPgliteClientForTests();
  // PGlite has no independent backend sessions. The shared fixture retains
  // identical migrated rows while its pause function returns immediately.
  await createBillingSnapshotFixture((query) => pglite.exec(query), "");
}, 120_000);
afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});
test("the full primary reader and public projection preserve source and exact amounts", async () => {
  const { readPrimaryAccountBillingSnapshot } = await import("./account-billing-snapshot");
  const { buildOrganizationSubscriptionSnapshot } = await import(
    "../../lib/services/account-subscription-snapshot"
  );
  const snapshot = await readPrimaryAccountBillingSnapshot("61000000-0000-4000-8000-000000000001");
  expect(snapshot.organization).toMatchObject({ creditBalance: "10.000001", balanceRevision: "1" });
  expect(
    buildOrganizationSubscriptionSnapshot(snapshot.subscription, snapshot.observedAt),
  ).toMatchObject({
    status: "available",
    value: {
      lifecycleRevision: "1",
      cancelAtPeriodEnd: false,
      allowance: { status: "available", value: { unreserved: "25.000001" } },
    },
  });
}, 120_000);

test("paid snapshot uses admitted policy and preserves null ceilings across balance changes", async () => {
  const { subscriptionAuthorityRepository } = await import("./subscription-authority");
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");
  const { readPrimaryAccountBillingSnapshot } = await import("./account-billing-snapshot");
  const { readOrganizationQuotaPolicy } = await import(
    "../../lib/services/organization-quota-policy"
  );
  const org = "61000000-0000-4000-8000-000000000001";
  const sub = "62000000-0000-4000-8000-000000000001";
  const current = await subscriptionAuthorityRepository.findById(org, sub);
  if (!current) throw new Error("Expected real subscription fixture");
  const {
    id: _id,
    organization_id: _org,
    lifecycle_revision: _revision,
    created_at: _created,
    updated_at: _updated,
    ...values
  } = current;
  const advanced = await subscriptionAuthorityRepository.advance({
    organizationId: org,
    subscriptionId: sub,
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
    organizationId: org,
    sourceSubscriptionId: sub,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: 1,
  });
  const admitted = await readOrganizationQuotaPolicy(org);
  const before = await readPrimaryAccountBillingSnapshot(org);
  expect(before.policyLimits).toEqual(admitted.limits);
  expect(before.configuredTier).toMatchObject({
    status: "available",
    tier: admitted.tier.status === "available" ? admitted.tier.value : undefined,
    tierSourceCreditTotal: null,
  });
  expect(before.policyLimits).toMatchObject({
    characters: { status: "unavailable" },
    sandboxes: { status: "unavailable" },
    nonEagerSandboxes: { status: "unavailable" },
    containers: { status: "unavailable" },
    apps: { status: "unavailable" },
    storage: { status: "unavailable" },
  });
  await database
    .getPgliteClientForTests()
    .exec(
      `UPDATE organizations SET credit_balance='0.000001', balance_revision=2 WHERE id='${org}'`,
    );
  const after = await readPrimaryAccountBillingSnapshot(org);
  expect(after.organization.creditBalance).toBe("0.000001");
  expect(after.policyLimits).toEqual(before.policyLimits);
  expect(after.configuredTier).toEqual(before.configuredTier);
  await database
    .getPgliteClientForTests()
    .exec(
      `UPDATE billing_subscriptions SET lifecycle_revision=lifecycle_revision+1 WHERE id='${sub}'`,
    );
  const stale = await readPrimaryAccountBillingSnapshot(org);
  expect(stale.policyLimits).toMatchObject({
    status: "unavailable",
    code: "ORGANIZATION_POLICY_UNAVAILABLE",
  });
  expect(stale.configuredTier.status).toBe("unavailable");
}, 120_000);
