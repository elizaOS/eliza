/** Exercises subscription snapshot reads and public projection against real migrated PGlite rows. */

import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { observeSubscriptionAllowanceEligibility } from "./subscription-allowance-eligibility";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);
const ORG_A = "51000000-0000-4000-8000-000000000001";
const ORG_B = "51000000-0000-4000-8000-000000000002";
const USER = "52000000-0000-4000-8000-000000000001";
const SUB_A = "53000000-0000-4000-8000-000000000001";
const SUB_B = "53000000-0000-4000-8000-000000000002";

const DIGEST_A = "a".repeat(64);
let client: typeof import("../client");
let entitlements: import("./subscription-entitlements").SubscriptionEntitlementsRepository;

function getPgliteClientForTests() {
  return client.getPgliteClientForTests();
}
beforeAll(async () => {
  client = await import("../client");
  ({ subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  ));

  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, account_lifecycle_state text NOT NULL DEFAULT 'active', paid_work_fenced_at timestamptz, stripe_customer_id text);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE org_storage_quota (organization_id uuid PRIMARY KEY REFERENCES organizations(id), bytes_used bigint NOT NULL DEFAULT 0, bytes_limit bigint NOT NULL DEFAULT 5368709120);
    CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id));
    CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id));
  `);
  await getPgliteClientForTests().exec(`
    ALTER TABLE organizations ADD COLUMN is_active boolean NOT NULL DEFAULT true, ADD COLUMN account_deletion_request_id uuid, ADD COLUMN credit_balance numeric(16,6) NOT NULL DEFAULT 0, ADD COLUMN balance_revision bigint NOT NULL DEFAULT 0, ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE org_storage_quota ADD COLUMN created_at timestamp DEFAULT now(), ADD COLUMN updated_at timestamp DEFAULT now(), ADD COLUMN native_catalog_reconciled_at timestamptz;
    ALTER TABLE credit_transactions ADD COLUMN amount numeric(16,6), ADD COLUMN type text, ADD COLUMN metadata jsonb;
    CREATE TABLE organization_config(organization_id uuid PRIMARY KEY, settings jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE org_rate_limit_overrides(id uuid PRIMARY KEY,organization_id uuid,completions_rpm integer,embeddings_rpm integer,standard_rpm integer,strict_rpm integer);
  `);
  const migration = await readFile(
    new URL("../migrations/0373_subscription_authority.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
  const eraseMigration = await readFile(
    new URL("../migrations/0374_subscription_funding_transaction_uniqueness.sql", import.meta.url),
    "utf8",
  );
  for (const statement of eraseMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
  const identityMigration = await readFile(
    new URL("../migrations/0379_subscription_account_authority.sql", import.meta.url),
    "utf8",
  );
  for (const statement of identityMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
  await getPgliteClientForTests().exec(
    await readFile(
      new URL("../migrations/0380_organization_policy_authority.sql", import.meta.url),
      "utf8",
    ),
  );
});
beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    ALTER TABLE billing_subscription_revisions DISABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions DISABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    TRUNCATE TABLE billing_subscriptions, users, organizations CASCADE;
    ALTER TABLE billing_subscription_revisions ENABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions ENABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users (id) VALUES ('${USER}');
    INSERT INTO billing_subscriptions (
      id, organization_id, provider_environment, stripe_customer_id,
      stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_digest
    ) VALUES
      ('${SUB_A}', '${ORG_A}', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, '${DIGEST_A}'),
      ('${SUB_B}', '${ORG_B}', 'test', 'cus_repob', 'sub_repob', 'si_repob', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, '${DIGEST_A}');
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, provider_environment,
      stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_digest
    ) VALUES ('${ORG_A}', '${SUB_A}', 1, 'webhook', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa',
      'plus_monthly', 'v1', 'active', '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z', false, '${DIGEST_A}');
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_A}', state = 'current' WHERE organization_id = '${ORG_A}';
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_B}', state = 'current' WHERE organization_id = '${ORG_B}';
  `);
});

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
const request = {
  organizationId: ORG_A,
  sourceSubscriptionId: SUB_A,
  sourceSubscriptionRevision: 1,
  expectedProjectionRevision: 0,
};

const { readPrimaryOrganizationSubscription } = await import(
  "./account-billing-snapshot-subscription"
);
const { buildOrganizationSubscriptionSnapshot } = await import(
  "../../lib/services/account-subscription-snapshot"
);
async function snapshot(organizationId = ORG_A, observedAt = "2026-08-20T12:00:00.000Z") {
  return client.dbRead.transaction(
    async (tx) =>
      buildOrganizationSubscriptionSnapshot(
        await readPrimaryOrganizationSubscription(tx, organizationId),
        observedAt,
        await observeSubscriptionAllowanceEligibility(tx, organizationId, new Date(observedAt)),
      ),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
async function publish() {
  await entitlements.rebuild(request);
}
async function allowance() {
  await getPgliteClientForTests().exec(`INSERT INTO subscription_allowance_periods
    (organization_id, subscription_id, subscription_revision, provider_environment, stripe_invoice_id, plan_key, catalog_version, period_start, period_end, expires_at, granted_amount, available_amount, reserved_amount, settled_amount)
    VALUES ('${ORG_A}', '${SUB_A}', 1, 'test', 'in_snapshotsecret', 'plus_monthly', 'v1', '2026-08-01Z', '2026-09-01Z', '2026-09-01Z', '9999999999.999999', '9999999998.999998', '0.000001', '1.000000');`);
}
test("current-source read preserves exact allowance and strips all provider authority", async () => {
  await publish();
  await allowance();
  const actual = await snapshot();
  expect(actual).toMatchObject({
    status: "available",
    observedAt: "2026-08-20T12:00:00.000Z",
    value: {
      lifecycleRevision: "1",
      cancellationNotice: { status: "not_applicable", reason: "no_current_cancellation_notice" },
      cancelAtPeriodEnd: false,
      allowance: {
        status: "available",
        value: {
          granted: "9999999999.999999",
          effectiveRemaining: { status: "available", value: "9999999998.999998" },
          reserved: "0.000001",
          settled: "1.000000",
        },
      },
    },
  });
  const json = JSON.stringify(actual);
  for (const value of [
    "cus_repoa",
    "sub_repoa",
    "si_repoa",
    "in_snapshotsecret",
    SUB_A,
    ORG_A,
    DIGEST_A,
  ])
    expect(json).not.toContain(value);
  expect(await snapshot(ORG_B)).toMatchObject({
    status: "unavailable",
    error: { code: "subscription_projection_out_of_date" },
  });
});
test("only explicit canonical none becomes no-subscription", async () => {
  await getPgliteClientForTests().exec(
    `INSERT INTO organizations(id) VALUES ('51000000-0000-4000-8000-000000000003');`,
  );
  expect(await snapshot("51000000-0000-4000-8000-000000000003")).toMatchObject({
    status: "not_applicable",
    reason: "no_organization_subscription",
  });
  await getPgliteClientForTests().exec(
    `DELETE FROM organization_subscription_authorities WHERE organization_id = '${ORG_A}';`,
  );
  expect(await snapshot()).toMatchObject({ status: "unavailable" });
  await getPgliteClientForTests().exec(
    `UPDATE organization_subscription_authorities SET state = 'none', subscription_id = NULL WHERE organization_id = '${ORG_B}';`,
  );
  expect(await snapshot(ORG_B)).toMatchObject({
    status: "unavailable",
    error: { code: "subscription_authority_conflict" },
  });
});
test("ambiguous association and missing grant are explicit unavailable observations", async () => {
  await publish();
  expect(await snapshot()).toMatchObject({
    status: "available",
    value: { allowance: { status: "unavailable" } },
  });
  await getPgliteClientForTests().exec(
    `UPDATE organization_subscription_authorities SET state = 'unavailable', subscription_id = NULL WHERE organization_id = '${ORG_A}';`,
  );
  expect(await snapshot()).toMatchObject({ status: "unavailable" });
});
test("lifecycle advancement with stale projection cannot produce a coherent-looking snapshot", async () => {
  await publish();
  await getPgliteClientForTests().exec(
    `UPDATE billing_subscriptions SET lifecycle_revision = 2 WHERE id = '${SUB_A}';`,
  );
  expect(await snapshot()).toMatchObject({
    status: "unavailable",
    error: { code: "subscription_projection_out_of_date" },
  });
});
test("lifecycle values must agree with immutable revision, not merely revision number", async () => {
  await publish();
  await getPgliteClientForTests().exec(
    `UPDATE billing_subscriptions SET cancel_at_period_end = true WHERE id = '${SUB_A}';`,
  );
  expect(await snapshot()).toMatchObject({
    status: "unavailable",
    error: { code: "subscription_revision_conflict" },
  });
});
test("observed expiry makes allowance unavailable to spend without pretending the sweeper ran", async () => {
  await publish();
  await allowance();
  expect(await snapshot(ORG_A, "2026-09-01T00:00:00.000Z")).toMatchObject({
    status: "available",
    value: {
      allowance: {
        status: "available",
        value: {
          state: "open",
          unreserved: "9999999998.999998",
          effectiveRemaining: { status: "unavailable" },
        },
      },
    },
  });
});
