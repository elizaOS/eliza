/** Creates a disposable billing schema using the production billing migrations and minimal external owner tables. */
import { readFile } from "node:fs/promises";
import type { Client } from "pg";
export async function initializeBillingSandboxDatabase(db: Client) {
  await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
    CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric NOT NULL DEFAULT 0);
      CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,organization_id uuid,role text NOT NULL DEFAULT 'member',expires_at timestamptz,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz);
      CREATE TABLE account_deletion_requests(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,request_digest text,lifecycle_revision bigint,irreversible_at timestamp,status text);
      CREATE TABLE account_deletion_phase_receipts(id uuid PRIMARY KEY,request_id uuid REFERENCES account_deletion_requests(id),phase text,lease_generation bigint,lease_expires_at timestamp,status text);
      CREATE TABLE apps(id uuid PRIMARY KEY,name text NOT NULL DEFAULT 'Independent app',app_url text NOT NULL DEFAULT 'https://app.example',allowed_origins jsonb NOT NULL DEFAULT '["https://app.example"]',organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved');
      CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));
    `);
  for (const tag of [
    "0373_subscription_authority",
    "0374_subscription_funding_transaction_uniqueness",
    "0379_subscription_account_authority",
    "0380_app_billing_catalog",
    "0381_app_billing_scope_records",
    "0382_app_billing_registration_constraints",
    "0383_subscription_app_scope_columns",
    "0384_subscription_app_scope_constraints",
    "0385_subscription_app_scope_guards",
    "0386_subscription_app_source_guards",
    "0387_app_delegations",
    "0390_app_billing_command_intents",
    "0391_app_billing_command_guards",
    "0392_app_billing_update_quotes",
    "0394_app_billing_merchant_identity",
    "0396_app_billing_notification_endpoints",
    "0397_app_subscription_outbox_delivery",
    "0398_app_billing_webhook_recovery",
    "0399_app_billing_checkout_expiry",
    "0400_app_billing_membership_authority",
    "0403_app_billing_import_commands",
    "0404_app_billing_import_guards",
    "0405_app_billing_import_allowance",
    "0413_app_billing_payment_expiry",
    "0415_app_billing_sales_fence",
    "0416_app_billing_refund_commands",
    "0417_app_billing_return_destination",
    "0414_app_billing_administrators",
    "0418_billing_identity_anchors",
    "0419_billing_identity_backfill",
    "0420_billing_identity_references",
    "0426_app_billing_resume_payment_progress",
    "0427_app_billing_paid_resume_progress",
  ]) {
    const migration = await readFile(
      new URL(`../src/db/migrations/${tag}.sql`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.query(statement.replaceAll('"public".', ""));
  }
}
