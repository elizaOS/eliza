/** Shared real-database fixture for auto-top-up recovery and lock-order tests. */
import { readFile } from "node:fs/promises";

export async function installAutoTopUpTestSchema(
  execute: (query: string) => Promise<unknown>,
): Promise<void> {
  await execute(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      credit_balance numeric(12,6) NOT NULL DEFAULT 0,
      balance_revision bigint NOT NULL DEFAULT 0,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_customer_id text,
      stripe_default_payment_method text,
      auto_top_up_enabled boolean NOT NULL DEFAULT false,
      auto_top_up_threshold numeric(10,2),
      auto_top_up_amount numeric(10,2),
      is_active boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid,
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_payment_intent_id text,
      created_at timestamp NOT NULL DEFAULT now(),
      settled_at timestamp
    );
    CREATE UNIQUE INDEX credit_transactions_stripe_payment_intent_idx
      ON credit_transactions (stripe_payment_intent_id);
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX organizations_stripe_customer_authority_unique
      ON organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
  `);
  const migrations = await Promise.all([
    readFile(
      new URL("../../migrations/0213_auto_top_up_organization_fence.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../migrations/0214_backfill_auto_top_up_organization_fence.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../migrations/0215_auto_top_up_attempts.sql", import.meta.url), "utf8"),
    readFile(
      new URL("../../migrations/0216_auto_top_up_cutover_control.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../migrations/0217_guard_auto_top_up_cutover_lifecycle.sql", import.meta.url),
      "utf8",
    ),
  ]);
  await execute(migrations.join("\n"));
  const customerAuthorityMigration = await readFile(
    new URL("../../migrations/0267_stripe_customer_attempts.sql", import.meta.url),
    "utf8",
  );
  for (const statement of customerAuthorityMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await execute(statement);
  }
}
