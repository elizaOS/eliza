/** Applies the app billing migration extension to isolated subscription repository test databases. */
import { readFile } from "node:fs/promises";

export async function applyAppBillingTestMigrations(
  execute: (statement: string) => Promise<unknown>,
  organizationCommandsInstalled = false,
): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS apps(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved')`,
  );
  await execute(
    `CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);`,
  );
  for (const tag of [
    ...(organizationCommandsInstalled
      ? []
      : ["0383_subscription_cancellation_result", "0384_subscription_cancellation_undo"]),
    "0435_app_billing_applied_revision",
    "0397_app_billing_catalog",
    "0398_app_billing_scope_records",
    "0399_app_billing_registration_constraints",
    "0400_subscription_app_scope_columns",
    "0401_subscription_app_scope_constraints",
    "0402_subscription_app_scope_guards",
    "0403_subscription_app_source_guards",
    "0404_app_delegations",
    "0424_app_billing_return_destination",
    "0405_app_billing_command_intents",
    "0406_app_billing_command_guards",
    "0407_app_billing_update_quotes",
    "0408_app_billing_merchant_identity",
    "0410_app_billing_notification_endpoints",
    "0411_app_subscription_outbox_delivery",
    "0412_app_billing_webhook_recovery",
    "0413_app_billing_checkout_expiry",
    "0414_app_billing_membership_authority",
    "0421_app_billing_administrators",
    "0425_billing_identity_anchors",
    "0426_billing_identity_backfill",
    "0427_billing_identity_references",
  ]) {
    const migration = await readFile(new URL(`../migrations/${tag}.sql`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) {
        const scoped = statement.replaceAll('"public".', "");
        await execute(
          scoped.trim().startsWith('ALTER TABLE "billing_subscription_commands" ADD COLUMN')
            ? scoped.replace(/ADD COLUMN(?! IF NOT EXISTS)/, "ADD COLUMN IF NOT EXISTS")
            : scoped,
        );
      }
  }
}
