/** Applies subscription operation migrations to real PGlite and proves tenant and replay fences. */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
  billingSubscriptionIncidents,
  subscriptionBillingFences,
} from "../schemas/subscription-billing-operations";

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";
const USER = "11000000-0000-4000-8000-000000000001";
const SUBSCRIPTION = "20000000-0000-4000-8000-000000000001";
const OTHER_SUBSCRIPTION = "20000000-0000-4000-8000-000000000002";
const COMMAND = "30000000-0000-4000-8000-000000000001";
const RECEIPT = "40000000-0000-4000-8000-000000000001";
const DIGEST = "a".repeat(64);
const migrationNames = [
  "0275_subscription_lifecycle_authority.sql",
  "0283_billing_subscription_commands.sql",
  "0284_subscription_billing_fences.sql",
  "0285_billing_subscription_event_receipts.sql",
  "0286_billing_subscription_incidents.sql",
] as const;
const migrations = await Promise.all(
  migrationNames.map((name) => readFile(new URL(name, import.meta.url), "utf8")),
);
const databases: PGlite[] = [];

setDefaultTimeout(120_000);

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${ORG}'), ('${OTHER_ORG}');
    INSERT INTO users (id) VALUES ('${USER}');
  `);
  for (const migration of migrations) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.exec(statement);
    }
  }
  await db.exec(`
    INSERT INTO billing_subscriptions (
      id, organization_id, stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_version, provider_object_digest
    ) VALUES
      ('${SUBSCRIPTION}', '${ORG}', 'sub_main1', 'si_main1', 'plus_monthly', 'v1',
       'active', '2026-01-01Z', '2026-02-01Z', 1, 1, '${DIGEST}'),
      ('${OTHER_SUBSCRIPTION}', '${OTHER_ORG}', 'sub_other1', 'si_other1', 'plus_monthly',
       'v1', 'active', '2026-01-01Z', '2026-02-01Z', 1, 1, '${DIGEST}');
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_version, provider_object_digest
    ) VALUES ('${ORG}', '${SUBSCRIPTION}', 1, 'webhook', 'sub_main1', 'si_main1',
      'plus_monthly', 'v1', 'active', '2026-01-01Z', '2026-02-01Z', false, 1, '${DIGEST}');
  `);
  return db;
}

async function seedCommand(db: PGlite): Promise<void> {
  await db.exec(`INSERT INTO billing_subscription_commands (
    id, organization_id, subscription_id, requested_by_user_id, kind, target_plan_key,
    expected_subscription_revision, idempotency_key, stripe_idempotency_key, request_digest
  ) VALUES ('${COMMAND}', '${ORG}', '${SUBSCRIPTION}', '${USER}', 'upgrade', 'pro_monthly',
    1, 'command:one', 'subscription-command-one', '${DIGEST}')`);
}

async function seedReceipt(db: PGlite): Promise<void> {
  await db.exec(`INSERT INTO billing_subscription_event_receipts (
    id, organization_id, subscription_id, stripe_event_id, event_type,
    stripe_object_type, stripe_object_id, livemode, event_created_at, payload_digest
  ) VALUES ('${RECEIPT}', '${ORG}', '${SUBSCRIPTION}', 'evt_event1',
    'invoice.paid', 'invoice', 'in_invoice1', false, '2026-01-02Z', '${DIGEST}')`);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0277-0280 subscription billing operation migrations", () => {
  test("are journaled in dependency order and match the Drizzle columns", async () => {
    const db = await database();
    for (const table of [
      billingSubscriptionCommands,
      subscriptionBillingFences,
      billingSubscriptionEventReceipts,
      billingSubscriptionIncidents,
    ]) {
      const config = getTableConfig(table);
      const columns = await db.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${config.name}'
        ORDER BY ordinal_position
      `);
      expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
        config.columns.map(({ name }) => name),
      );
    }
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.slice(-4).map(({ idx, tag }) => ({ idx, tag }))).toEqual(
      migrationNames
        .slice(1)
        .map((name, offset) => ({ idx: 276 + offset, tag: name.slice(0, -4) })),
    );
  });

  test("rejects cross-tenant commands and immutable idempotency intent changes", async () => {
    const db = await database();
    await expect(
      db.exec(`INSERT INTO billing_subscription_commands (
        organization_id, subscription_id, requested_by_user_id, kind,
        expected_subscription_revision, idempotency_key, stripe_idempotency_key, request_digest
      ) VALUES ('${OTHER_ORG}', '${SUBSCRIPTION}', '${USER}', 'cancel', 1,
        'command:cross', 'subscription-command-cross', '${DIGEST}')`),
    ).rejects.toThrow(/subscription_tenant_fk|foreign key/i);
    await seedCommand(db);
    await expect(
      db.exec(`INSERT INTO billing_subscription_commands (
        organization_id, subscription_id, requested_by_user_id, kind, target_plan_key,
        expected_subscription_revision, idempotency_key, stripe_idempotency_key, request_digest
      ) VALUES ('${ORG}', '${SUBSCRIPTION}', '${USER}', 'upgrade', 'pro_monthly', 1,
        'command:one', 'subscription-command-two', '${DIGEST}')`),
    ).rejects.toThrow(/org_idempotency|unique/i);
    await expect(
      db.exec(`UPDATE billing_subscription_commands SET target_plan_key = 'plus_monthly'
        WHERE id = '${COMMAND}'`),
    ).rejects.toThrow(/intent_immutable|immutable/i);
  });

  test("enforces deletion-fence monotonicity and event receipt replay identity", async () => {
    const db = await database();
    await db.exec(`INSERT INTO subscription_billing_fences (
      organization_id, subscription_id, provider_object_version, provider_object_digest
    ) VALUES ('${ORG}', '${SUBSCRIPTION}', 1, '${DIGEST}')`);
    await expect(
      db.exec(`UPDATE subscription_billing_fences SET state = 'deletion_requested',
        deletion_requested_at = now() WHERE subscription_id = '${SUBSCRIPTION}'`),
    ).rejects.toThrow(/monotonic/i);
    await expect(
      db.exec(`UPDATE subscription_billing_fences SET state = 'provider_deleted',
        deletion_requested_at = now(), provider_deleted_at = now(), fence_revision = 2
        WHERE subscription_id = '${SUBSCRIPTION}'`),
    ).rejects.toThrow(/state_transition|transition/i);
    await db.exec(`UPDATE subscription_billing_fences SET state = 'deletion_requested',
      deletion_requested_at = now(), fence_revision = 2
      WHERE subscription_id = '${SUBSCRIPTION}'`);
    await seedReceipt(db);
    await expect(
      db.exec(`INSERT INTO billing_subscription_event_receipts (
        organization_id, subscription_id, stripe_event_id, event_type, stripe_object_type,
        stripe_object_id, livemode, event_created_at, payload_digest
      ) VALUES ('${ORG}', '${SUBSCRIPTION}', 'evt_event1', 'invoice.paid', 'invoice',
        'in_invoice1', false, '2026-01-02Z', '${DIGEST}')`),
    ).rejects.toThrow(/event_idx|unique/i);
    await expect(
      db.exec(`UPDATE billing_subscription_event_receipts SET payload_digest = '${"b".repeat(64)}'
        WHERE id = '${RECEIPT}'`),
    ).rejects.toThrow(/identity_immutable|immutable/i);
  });

  test("tenant-fences incident evidence and deduplicates open fingerprints", async () => {
    const db = await database();
    await seedCommand(db);
    await seedReceipt(db);
    await expect(
      db.exec(`INSERT INTO billing_subscription_incidents (
        organization_id, subscription_id, command_id, kind, severity, fingerprint, context
      ) VALUES ('${OTHER_ORG}', '${OTHER_SUBSCRIPTION}', '${COMMAND}', 'provider_timeout',
        'error', '${DIGEST}', '{}')`),
    ).rejects.toThrow(/command_tenant_fk|foreign key/i);
    await db.exec(`INSERT INTO billing_subscription_incidents (
      organization_id, subscription_id, command_id, event_receipt_id, kind, severity,
      fingerprint, context
    ) VALUES ('${ORG}', '${SUBSCRIPTION}', '${COMMAND}', '${RECEIPT}',
      'provider_timeout', 'error', '${DIGEST}', '{}')`);
    await expect(
      db.exec(`INSERT INTO billing_subscription_incidents (
        organization_id, subscription_id, kind, severity, fingerprint, context
      ) VALUES ('${ORG}', '${SUBSCRIPTION}', 'reconciliation', 'warning', '${DIGEST}', '{}')`),
    ).rejects.toThrow(/open_fingerprint|unique/i);
  });
});
