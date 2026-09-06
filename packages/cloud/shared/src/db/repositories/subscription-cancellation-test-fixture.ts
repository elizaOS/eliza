/** Seeds migrated primary cancellation authority and a pinned Stripe response for service and HTTP integration tests. Only unrelated identity columns are fixture-defined. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";
export async function installCancellationTestSchema(execute: (query: string) => Promise<unknown>) {
  await execute(`CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_deletion_request_id uuid);
    CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id),role text NOT NULL DEFAULT 'member',
      is_active boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,deleted_at timestamp,expires_at timestamp);`);
  await installOrganizationPolicyTestSchema(execute);
  for (const name of [
    "0382_subscription_notice_intents.sql",
    "0383_subscription_cancellation_result.sql",
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await execute(statement);
  }
}
export async function seedCancellationTestAccount(
  queryOverride?: (text: string, values: unknown[]) => Promise<unknown>,
) {
  const { getPgliteClientForTests } = await import("../client");
  const query =
    queryOverride ??
    ((text: string, values: unknown[]) => getPgliteClientForTests().query(text, values));
  const { subscriptionAuthorityRepository } = await import("./subscription-authority");
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");
  const organizationId = randomUUID(),
    actorId = randomUUID(),
    subscriptionId = randomUUID();
  const suffix = subscriptionId.replaceAll("-", "");
  const now = Math.floor(Date.now() / 1000);
  const source = {
    provider: "stripe" as const,
    provider_environment: "test" as const,
    stripe_customer_id: `cus_${suffix}`,
    stripe_subscription_id: `sub_${suffix}`,
    stripe_subscription_item_id: `si_${suffix}`,
    plan_key: "plus_monthly" as const,
    catalog_version: "v1",
    status: "active" as const,
    current_period_start: new Date((now - 86400) * 1000),
    current_period_end: new Date((now + 86400) * 1000),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    dunning_started_at: null,
    grace_expires_at: null,
    pending_plan_key: null,
    last_provider_event_id: null,
    last_provider_event_created_at: null,
    provider_object_digest: "a".repeat(64),
  };
  await query("INSERT INTO organizations(id,stripe_customer_id) VALUES($1,$2)", [
    organizationId,
    source.stripe_customer_id,
  ]);
  await query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
    actorId,
    organizationId,
  ]);
  await subscriptionAuthorityRepository.create(
    { ...source, id: subscriptionId, organization_id: organizationId },
    "checkout",
    null,
  );
  await subscriptionEntitlementsRepository.rebuild({
    organizationId,
    sourceSubscriptionId: subscriptionId,
    sourceSubscriptionRevision: 1,
    expectedProjectionRevision: 0,
  });
  return {
    input: {
      organizationId,
      actorId,
      subscriptionId,
      expectedSubscriptionRevision: 1,
      idempotencyKey: randomUUID(),
    },
    source,
    provider: {
      id: source.stripe_subscription_id,
      object: "subscription",
      livemode: false,
      customer: source.stripe_customer_id,
      status: "active",
      current_period_start: now - 86400,
      current_period_end: now + 86400,
      cancel_at_period_end: false,
      cancel_at: null as number | null,
      canceled_at: null as number | null,
      ended_at: null,
      trial_start: null,
      trial_end: null,
      on_behalf_of: null,
      transfer_data: null,
      application_fee_percent: null,
      schedule: null,
      pending_update: null,
      pause_collection: null,
      items: {
        has_more: false,
        data: [
          {
            id: source.stripe_subscription_item_id,
            object: "subscription_item",
            quantity: 1,
            price: {
              id: "price_plus",
              product: "prod_plus",
              livemode: false,
              currency: "usd",
              unit_amount: 3000,
              type: "recurring",
              billing_scheme: "per_unit",
              transform_quantity: null,
              recurring: {
                interval: "month",
                interval_count: 1,
                usage_type: "licensed",
                trial_period_days: null,
              },
            },
          },
        ],
      },
    },
  };
}
