/** Applies the app billing migration extension to isolated subscription repository test databases. */
import { readFile } from "node:fs/promises";

export async function applyAppBillingTestMigrations(
  execute: (statement: string) => Promise<unknown>,
): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS apps(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved')`,
  );
  await execute(
    `CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);`,
  );
  for (const tag of [
    "0380_app_billing_catalog",
    "0381_app_billing_scope_records",
    "0382_app_billing_registration_constraints",
    "0383_subscription_app_scope_columns",
    "0384_subscription_app_scope_constraints",
    "0385_subscription_app_scope_guards",
    "0386_subscription_app_source_guards",
    "0387_app_delegations",
    "0417_app_billing_return_destination",
    "0390_app_billing_command_intents",
    "0391_app_billing_command_guards",
    "0392_app_billing_update_quotes",
    "0394_app_billing_merchant_identity",
    "0396_app_billing_notification_endpoints",
    "0397_app_subscription_outbox_delivery",
    "0398_app_billing_webhook_recovery",
    "0399_app_billing_checkout_expiry",
    "0400_app_billing_membership_authority",
    "0414_app_billing_administrators",
    "0418_billing_identity_anchors",
    "0419_billing_identity_backfill",
    "0420_billing_identity_references",
  ]) {
    const migration = await readFile(new URL(`../migrations/${tag}.sql`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await execute(statement.replaceAll('"public".', ""));
  }
}
