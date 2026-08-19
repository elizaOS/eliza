/**
 * Applies migration 0261 to real PGlite for shape, replay, collision, and tenant-binding proof.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const USER_A = "20000000-0000-4000-8000-000000000001";
const PACK_A = "30000000-0000-4000-8000-000000000001";
const ORDER_A = "40000000-0000-4000-8000-000000000001";
const migration = await readFile(
  new URL("./0261_stripe_checkout_orders.sql", import.meta.url),
  "utf8",
);
const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE credit_packs (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      stripe_payment_intent_id text
    );
    INSERT INTO organizations(id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users(id) VALUES ('${USER_A}');
    INSERT INTO credit_packs(id) VALUES ('${PACK_A}');
  `);
  return db;
}

function customOrderSql(id = ORDER_A, org = ORG_A, requestKey = "request-key-a"): string {
  return `INSERT INTO stripe_checkout_orders (
    id, organization_id, initiated_by_user_id, client_request_key, request_digest,
    purchase_type, credits_to_grant, charge_amount_cents, currency, stripe_customer_id
  ) VALUES (
    '${id}', '${org}', '${USER_A}', '${requestKey}', '${"a".repeat(64)}',
    'custom_amount', 25, 500, 'usd', 'cus_a'
  )`;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0261 Stripe Checkout orders migration", () => {
  test("creates the authority shape and replays without changing it", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(migration);
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stripe_checkout_orders' ORDER BY ordinal_position
    `);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "organization_id",
      "initiated_by_user_id",
      "client_request_key",
      "request_digest",
      "purchase_type",
      "credit_pack_id",
      "credits_to_grant",
      "charge_amount_cents",
      "currency",
      "stripe_customer_id",
      "stripe_checkout_session_id",
      "stripe_payment_intent_id",
      "credit_transaction_id",
      "status",
      "provider_error_code",
      "metadata",
      "created_at",
      "updated_at",
      "settled_at",
    ]);
    const trigger = await db.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname = 'stripe_checkout_order_binding_guard' AND NOT tgisinternal
    `);
    expect(trigger.rows).toEqual([{ count: 1 }]);
    const quarantine = await db.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_name = 'stripe_checkout_legacy_quarantine'
    `);
    expect(quarantine.rows).toEqual([{ count: 1 }]);
  });

  test("fails closed instead of accepting a colliding partial table", async () => {
    const db = await database();
    await db.exec("CREATE TABLE stripe_checkout_orders (id uuid PRIMARY KEY)");
    await expect(db.exec(migration)).rejects.toThrow();
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stripe_checkout_orders'
    `);
    expect(columns.rows).toEqual([{ column_name: "id" }]);
  });

  test("enforces quote shape, tenant request uniqueness, and immutable transitions", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(customOrderSql());
    await expect(db.exec(customOrderSql("40000000-0000-4000-8000-000000000002"))).rejects.toThrow();
    await db.exec(customOrderSql("40000000-0000-4000-8000-000000000003", ORG_B));
    await expect(
      db.exec(`UPDATE stripe_checkout_orders SET credits_to_grant = 9999 WHERE id = '${ORDER_A}'`),
    ).rejects.toThrow(/immutable authority/i);
    await expect(
      db.exec(`UPDATE stripe_checkout_orders SET status = 'delivered' WHERE id = '${ORDER_A}'`),
    ).rejects.toThrow(/invalid status transition/i);
    await expect(
      db.exec(`INSERT INTO stripe_checkout_orders (
        organization_id, initiated_by_user_id, client_request_key, request_digest,
        purchase_type, credits_to_grant, charge_amount_cents, currency, stripe_customer_id
      ) VALUES (
        '${ORG_A}', '${USER_A}', 'request-key-b', '${"b".repeat(64)}',
        'credit_pack', 25, 500, 'USD', 'cus_a'
      )`),
    ).rejects.toThrow();
  });

  test("rejects cross-tenant ledger linkage and accepts one exact settlement", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(customOrderSql());
    await db.exec(`
      UPDATE stripe_checkout_orders SET status = 'provider_started' WHERE id = '${ORDER_A}';
      UPDATE stripe_checkout_orders
        SET status = 'delivered', stripe_checkout_session_id = 'cs_a'
        WHERE id = '${ORDER_A}';
      INSERT INTO credit_transactions(
        id, organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        '50000000-0000-4000-8000-000000000001', '${ORG_B}', 25, 'credit',
        '{"checkout_order_id":"${ORDER_A}"}', 'pi_a'
      );
    `);
    await expect(
      db.exec(`UPDATE stripe_checkout_orders SET
        status = 'settled', stripe_payment_intent_id = 'pi_a',
        credit_transaction_id = '50000000-0000-4000-8000-000000000001', settled_at = now()
        WHERE id = '${ORDER_A}'`),
    ).rejects.toThrow(/credit transaction binding mismatch/i);
    await db.exec(`INSERT INTO credit_transactions(
      id, organization_id, amount, type, metadata, stripe_payment_intent_id
    ) VALUES (
      '50000000-0000-4000-8000-000000000002', '${ORG_A}', 25, 'credit',
      '{"checkout_order_id":"${ORDER_A}"}', 'pi_a'
    )`);
    await db.exec(`UPDATE stripe_checkout_orders SET
      status = 'settled', stripe_payment_intent_id = 'pi_a',
      credit_transaction_id = '50000000-0000-4000-8000-000000000002', settled_at = now()
      WHERE id = '${ORDER_A}'`);
    await expect(
      db.exec(`UPDATE stripe_checkout_orders SET stripe_payment_intent_id = 'pi_other'
        WHERE id = '${ORDER_A}'`),
    ).rejects.toThrow(/immutable authority/i);
  });

  test("rejects NULL payment-intent and metadata ledger bindings", async () => {
    const db = await database();
    await db.exec(migration);
    for (const [suffix, paymentIntent, metadata] of [
      ["1", "NULL", `'{"checkout_order_id":"${ORDER_A}"}'`],
      ["2", "'pi_a'", "'{}'"],
    ] as const) {
      await db.exec(`DELETE FROM stripe_checkout_orders; DELETE FROM credit_transactions;`);
      await db.exec(customOrderSql());
      await db.exec(`
        UPDATE stripe_checkout_orders SET status = 'provider_started' WHERE id = '${ORDER_A}';
        UPDATE stripe_checkout_orders
          SET status = 'delivered', stripe_checkout_session_id = 'cs_a'
          WHERE id = '${ORDER_A}';
        INSERT INTO credit_transactions(
          id, organization_id, amount, type, metadata, stripe_payment_intent_id
        ) VALUES (
          '50000000-0000-4000-8000-00000000000${suffix}', '${ORG_A}', 25, 'credit',
          ${metadata}, ${paymentIntent}
        );
      `);
      await expect(
        db.exec(`UPDATE stripe_checkout_orders SET
          status = 'settled', stripe_payment_intent_id = 'pi_a',
          credit_transaction_id = '50000000-0000-4000-8000-00000000000${suffix}', settled_at = now()
          WHERE id = '${ORDER_A}'`),
      ).rejects.toThrow(/credit transaction binding mismatch/i);
    }
  });
});
