import { readFile } from "node:fs/promises";

/** Historical order shared by billing integration fixtures; do not sort. */
export const BILLING_CATALOG_FIXTURE_MIGRATIONS = [
  "0374_subscription_funding_transaction_uniqueness",
  "0379_subscription_account_authority",
  "0400_app_billing_catalog",
  "0401_app_billing_scope_records",
  "0402_app_billing_registration_constraints",
  "0403_subscription_app_scope_columns",
  "0404_subscription_app_scope_constraints",
  "0405_subscription_app_scope_guards",
  "0406_subscription_app_source_guards",
  "0407_app_delegations",
  "0408_app_billing_command_intents",
  "0409_app_billing_command_guards",
  "0410_app_billing_update_quotes",
  "0411_app_billing_merchant_identity",
  "0413_app_billing_notification_endpoints",
  "0508_app_notification_secret_envelope_v2",
  "0414_app_subscription_outbox_delivery",
  "0415_app_billing_webhook_recovery",
  "0416_app_billing_checkout_expiry",
  "0417_app_billing_membership_authority",
] as const;

/** Apply selected production migrations in a caller-owned isolated schema. */
export async function applyBillingFixtureMigrations(
  db: { query(statement: string): Promise<unknown> },
  tags: readonly string[],
): Promise<void> {
  for (const tag of tags) {
    const migration = await readFile(
      new URL(`../db/migrations/${tag}.sql`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.query(statement.replaceAll('"public".', ""));
    }
  }
  if (tags.includes("0512_organization_upgrade_dispatch"))
    await installBillingCommandEvidenceTestColumns((statement) => db.query(statement));
}

/** Add shared command projection columns without installing unrelated organization lifecycle guards. */
export async function installBillingCommandEvidenceTestColumns(
  execute: (statement: string) => Promise<unknown>,
): Promise<void> {
  for (const tag of [
    "0518_organization_upgrade_historical_settlement",
    "0519_organization_upgrade_void_result",
    "0524_organization_schedule_compensation_result",
    "0525_organization_schedule_configured_result",
    "0526_organization_schedule_configured_snapshot",
  ]) {
    const migration = await readFile(
      new URL(`../db/migrations/${tag}.sql`, import.meta.url),
      "utf8",
    );
    await execute(
      migration
        .split("--> statement-breakpoint")[0]!
        .replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS"),
    );
  }
}

/**
 * Installs the subscription-grant tables and columns (0542) once in a fixture
 * built from selected billing migrations, so Drizzle reads of the shared
 * entitlement and allowance tables see the production column set.
 */
export async function installSubscriptionGrantTestSchema(
  execute: (statement: string) => Promise<unknown>,
): Promise<void> {
  const migration = (
    await Promise.all(
      [
        "0542_subscription_grant_codes.sql",
        "0546_lifetime_subscription_grants.sql",
        "0547_subscription_grant_calendar_terms.sql",
      ].map((name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8")),
    )
  ).join("\n--> statement-breakpoint\n");
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `EXECUTE $grant_statement$${statement}$grant_statement$;`);
  await execute(
    // Check only the fixture's own schema: a search_path fallback to a
    // migrated public schema must not skip installing the columns here.
    `DO $install_grants$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = 'subscription_grants') THEN ${statements.join("\n")} END IF; END $install_grants$`,
  );
}
