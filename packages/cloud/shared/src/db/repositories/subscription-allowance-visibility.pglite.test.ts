/** Compares actual primary billing snapshots with actual allowance reservation under the same canonical source, ledger and organization fences. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
let database: typeof import("../client");
const org = "61000000-0000-4000-8000-000000000001";
const sub = "62000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  database = await import("../client");
  await createBillingSnapshotFixture((query) => database.getPgliteClientForTests().exec(query), "");
}, 120000);
afterAll(async () => {
  await database.closeDatabaseConnectionsForTests();
});
async function advance(
  changes: Partial<import("../schemas/billing-subscriptions").BillingSubscription>,
) {
  const { subscriptionAuthorityRepository: authority } = await import("./subscription-authority");
  const { subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  );
  const current = await authority.findById(org, sub);
  if (!current) throw new Error("Missing source fixture");
  const { id, organization_id, lifecycle_revision, created_at, updated_at, ...values } = current;
  const projection = await entitlements.find(org);
  const next = await authority.advance({
    organizationId: org,
    subscriptionId: sub,
    expectedRevision: lifecycle_revision,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...values,
      ...changes,
      provider_object_digest: randomUUID().replaceAll("-", "").repeat(2),
    },
  });
  await entitlements.rebuild({
    organizationId: org,
    sourceSubscriptionId: sub,
    sourceSubscriptionRevision: next.subscription.lifecycle_revision,
    expectedProjectionRevision: projection?.projection_revision ?? null,
  });
  return next.subscription;
}
async function snapshot() {
  const { readPrimaryAccountBillingSnapshot } = await import("./account-billing-snapshot");
  const { buildOrganizationSubscriptionSnapshot } = await import(
    "../../lib/services/account-subscription-snapshot"
  );
  const primary = await readPrimaryAccountBillingSnapshot(org);
  const projected = buildOrganizationSubscriptionSnapshot(
    primary.subscription,
    primary.observedAt,
    primary.allowanceFunding,
  );
  if (projected.status !== "available" || projected.value.allowance.status !== "available")
    throw new Error("Ledger observation unexpectedly unavailable");
  return projected.value.allowance.value;
}
async function reserve(amount = "1.000000") {
  const { subscriptionFundingService } = await import("../../lib/services/subscription-funding");
  return subscriptionFundingService.reserve({
    organizationId: org,
    logicalOperationId: `visibility:${randomUUID()}`,
    operation: "ai_inference",
    amount,
    description: "visibility admission",
    reservationTtlMs: 60000,
  });
}
test("funding and primary snapshot agree on positive, denied and exhausted allowance without rewriting ledger values", async () => {
  const current = await advance({
    current_period_start: new Date(Date.now() - 86400000),
    current_period_end: new Date(Date.now() + 86400000),
  });
  await database
    .getPgliteClientForTests()
    .query(
      `UPDATE subscription_allowance_periods SET subscription_revision=$1,period_start=$2,period_end=$3,expires_at=$3 WHERE organization_id=$4`,
      [current.lifecycle_revision, current.current_period_start, current.current_period_end, org],
    );
  expect((await snapshot()).effectiveRemaining).toMatchObject({
    status: "available",
    value: "25.000001",
  });
  await reserve();
  expect((await snapshot()).effectiveRemaining).toMatchObject({
    status: "available",
    value: "24.000001",
  });
  await advance({ cancel_at_period_end: true, canceled_at: new Date() });
  await reserve();
  await advance({ cancel_at_period_end: false });
  expect((await snapshot()).effectiveRemaining).toMatchObject({
    status: "available",
    value: "23.000001",
  });
  for (const statement of [
    `UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id='${org}'`,
    `UPDATE subscription_allowance_periods SET provider_environment='live' WHERE organization_id='${org}'`,
    `UPDATE subscription_allowance_periods SET subscription_revision=1 WHERE organization_id='${org}'`,
  ]) {
    await database.getPgliteClientForTests().exec(statement);
    const before = await snapshot();
    expect(before.unreserved).toBe("23.000001");
    expect(before.effectiveRemaining.status).toBe("unavailable");
    await expect(reserve()).rejects.toMatchObject({
      code: "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
    });
    expect((await snapshot()).unreserved).toBe(before.unreserved);
    await database
      .getPgliteClientForTests()
      .query(`UPDATE organizations SET paid_work_fenced_at=NULL WHERE id=$1;`, [org]);
    await database
      .getPgliteClientForTests()
      .query(
        `UPDATE subscription_allowance_periods SET provider_environment='test',subscription_revision=$1 WHERE organization_id=$2`,
        [current.lifecycle_revision, org],
      );
  }
  const originalItem = current.stripe_subscription_item_id;
  await advance({ stripe_subscription_item_id: "si_changedvisibility" });
  expect((await snapshot()).effectiveRemaining.status).toBe("unavailable");
  await expect(reserve()).rejects.toMatchObject({
    code: "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
  });
  await advance({ stripe_subscription_item_id: originalItem });
  const overlap = randomUUID();
  const historicalSource = randomUUID();
  await database.getPgliteClientForTests().query(
    `INSERT INTO billing_subscriptions(id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest,canceled_at,ended_at)
    SELECT $1,organization_id,provider_environment,stripe_customer_id,'sub_historicalvisibility','si_historicalvisibility',plan_key,catalog_version,'canceled',current_period_start,current_period_end,2,provider_object_digest,clock_timestamp(),clock_timestamp() FROM billing_subscriptions WHERE id=$2`,
    [historicalSource, sub],
  );
  await database.getPgliteClientForTests().query(
    `INSERT INTO billing_subscription_revisions(organization_id,subscription_id,revision,source,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,cancel_at_period_end,provider_object_digest)
    SELECT organization_id,id,1,'webhook',provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,'active',current_period_start,current_period_end,false,provider_object_digest FROM billing_subscriptions WHERE id=$1`,
    [historicalSource],
  );

  await database.getPgliteClientForTests().query(
    `INSERT INTO subscription_allowance_periods(id,organization_id,subscription_id,subscription_revision,provider,provider_environment,stripe_invoice_id,plan_key,catalog_version,period_start,period_end,expires_at,granted_amount,available_amount)
    SELECT $1,organization_id,$3,1,provider,provider_environment,'in_overlapvisibility',plan_key,catalog_version,period_start + interval '1 second',period_end,expires_at,1,1 FROM subscription_allowance_periods WHERE organization_id=$2`,
    [overlap, org, historicalSource],
  );
  expect((await snapshot()).effectiveRemaining.status).toBe("unavailable");
  await expect(reserve()).rejects.toMatchObject({
    code: "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
  });
  await database
    .getPgliteClientForTests()
    .query("DELETE FROM subscription_allowance_periods WHERE id=$1", [overlap]);
  const exhausted = await reserve("23.000001");
  expect((await snapshot()).effectiveRemaining).toMatchObject({
    status: "available",
    value: "0.000000",
  });
  const { subscriptionFundingService } = await import("../../lib/services/subscription-funding");
  await subscriptionFundingService.settle({
    organizationId: org,
    logicalOperationId: exhausted.reservation.logical_operation_id,
    operation: "ai_inference",
    actualAmount: "0.000000",
    occurredAt: new Date(),
  });
  // Reserved funds remain an auditable balance when current authority terminates.
  await advance({ status: "canceled", canceled_at: new Date(), ended_at: new Date() });
  const terminal = await snapshot();
  expect(terminal.reserved).toBe("2.000000");
  expect(terminal.unreserved).toBe("23.000001");
  expect(terminal.effectiveRemaining.status).toBe("unavailable");
  await expect(reserve()).rejects.toMatchObject({
    code: "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
  });
}, 120000);

test("legacy purchased-only organization retains an observable balance and no subscription", async () => {
  const legacy = randomUUID();
  await database
    .getPgliteClientForTests()
    .query(
      `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state) VALUES($1,10,1,0,'{}',true,false,'active')`,
      [legacy],
    );
  const { readPrimaryAccountBillingSnapshot } = await import("./account-billing-snapshot");
  const { buildOrganizationSubscriptionSnapshot } = await import(
    "../../lib/services/account-subscription-snapshot"
  );
  const read = await readPrimaryAccountBillingSnapshot(legacy);
  expect(read.organization.creditBalance).toBe("10.000000");
  expect(read.allowanceFunding).toEqual({ status: "available", period: undefined });
  expect(
    buildOrganizationSubscriptionSnapshot(
      read.subscription,
      read.observedAt,
      read.allowanceFunding,
    ),
  ).toMatchObject({ status: "not_applicable", reason: "no_organization_subscription" });
}, 120000);
