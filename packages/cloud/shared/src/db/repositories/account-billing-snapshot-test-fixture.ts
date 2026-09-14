/** Builds real subscription migrations and empty infrastructure fixtures for production snapshot integration tests. */
import { readFile } from "node:fs/promises";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const ORG = "61000000-0000-4000-8000-000000000001";
const SUB = "62000000-0000-4000-8000-000000000001";
const DIGEST = "b".repeat(64);
/** Only empty infrastructure fixtures use schema-derived column types; no billing constraints are replaced. */
async function emptyTable(execute: (query: string) => Promise<unknown>, table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns
    .filter(
      (column) =>
        column.name !== "limit_override_authorized" && column.name !== "quota_admission_scope",
    )
    .map((column) => {
      const type = "enumValues" in column && column.enumValues ? "text" : column.getSQLType();
      return `"${column.name}" ${type}`;
    });
  await execute(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}

export async function createBillingSnapshotFixture(
  execute: (query: string) => Promise<unknown>,
  pauseStatement: string,
): Promise<void> {
  const schema = await import("../schemas");
  await emptyTable(execute, schema.organizations);
  await execute(`ALTER TABLE organizations ADD PRIMARY KEY(id);
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE credit_transactions(id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id), amount numeric(16,6), type text, metadata jsonb, UNIQUE(id,organization_id));`);
  for (const name of [
    "0373_subscription_authority.sql",
    "0374_subscription_funding_transaction_uniqueness.sql",
    "0379_subscription_account_authority.sql",
    "0382_subscription_notice_intents.sql",
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await execute(statement);
    }
  }
  for (const table of [
    schema.userCharacters,
    schema.agentSandboxes,
    schema.containers,
    schema.organizationConfig,
    schema.apps,
    schema.apiKeys,
    schema.orgStorageQuota,
    schema.autoTopUpControl,
    schema.autoTopUpAttempts,
    schema.autoTopUpLegacyPaymentQuarantine,
    schema.computeBillingRateSegments,
  ]) {
    await emptyTable(execute, table);
  }
  await execute(
    await readFile(
      new URL("../migrations/0380_organization_policy_authority.sql", import.meta.url),
      "utf8",
    ),
  );
  // A server-side lock gives the test an observable pause in the real reader,
  // without replacing its DB adapter, transaction configuration or selectors.
  await execute(`CREATE FUNCTION snapshot_pause() RETURNS integer LANGUAGE plpgsql VOLATILE AS $$ BEGIN ${pauseStatement} RETURN NULL; END $$;
      CREATE VIEW org_rate_limit_overrides AS SELECT '${ORG}'::uuid id, '${ORG}'::uuid organization_id, NULL::text note, now()::timestamp created_at, now()::timestamp updated_at, snapshot_pause() completions_rpm, NULL::integer embeddings_rpm, NULL::integer standard_rpm, NULL::integer strict_rpm;
      INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state) VALUES ('${ORG}', '10.000001', 1, 0, '{}', true, false, 'active');
      INSERT INTO billing_subscriptions(id, organization_id, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, lifecycle_revision, provider_object_digest)
      VALUES('${SUB}', '${ORG}', 'test', 'cus_snapshot', 'sub_snapshot', 'si_snapshot', 'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z', 1, '${DIGEST}');
      INSERT INTO billing_subscription_revisions(organization_id, subscription_id, revision, source, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, cancel_at_period_end, provider_object_digest)
      VALUES('${ORG}', '${SUB}', 1, 'webhook', 'test', 'cus_snapshot', 'sub_snapshot', 'si_snapshot', 'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z', false, '${DIGEST}');
      UPDATE organization_subscription_authorities SET subscription_id = '${SUB}', state = 'current' WHERE organization_id = '${ORG}';
      UPDATE organization_entitlements SET plan_key = 'plus_monthly', state = 'active', source_subscription_id = '${SUB}', source_subscription_revision = 1, projection_revision = 1 WHERE organization_id = '${ORG}';
      INSERT INTO subscription_allowance_periods(organization_id, subscription_id, subscription_revision, provider_environment, stripe_invoice_id, plan_key, catalog_version, period_start, period_end, expires_at, granted_amount, available_amount)
      VALUES('${ORG}', '${SUB}', 1, 'test', 'in_snapshot', 'plus_monthly', 'v1', '2026-08-01Z', '2026-09-01Z', '2026-09-01Z', '25.000001', '25.000001');`);
}
