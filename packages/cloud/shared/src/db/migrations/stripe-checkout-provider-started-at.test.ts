/** First dispatch is write-once; migration never invents historical authority. */
import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
afterAll(async () => db.close());

test("0559 preserves unknown historical dispatch and enforces write-once new dispatch", async () => {
  await db.exec(`
    CREATE TABLE organizations(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY, organization_id uuid);
    CREATE TABLE credit_packs(id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions(id uuid PRIMARY KEY, organization_id uuid, type text,
      amount numeric, stripe_payment_intent_id text, metadata jsonb);
    INSERT INTO organizations VALUES ('10000000-0000-4000-8000-000000000001');
    INSERT INTO users VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
  `);
  await db.exec(
    await readFile(new URL("./0261_stripe_checkout_orders.sql", import.meta.url), "utf8"),
  );
  const insert = (
    key: string,
  ) => `INSERT INTO stripe_checkout_orders(organization_id,initiated_by_user_id,
    client_request_key,request_digest,purchase_type,credits_to_grant,charge_amount_cents,currency,stripe_customer_id)
    VALUES('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
      '${key}','${"a".repeat(64)}','custom_amount',5,500,'usd','cus_test')`;
  await db.exec(insert("historical-order"));
  await db.exec(
    "UPDATE stripe_checkout_orders SET status='provider_started'; UPDATE stripe_checkout_orders SET status='provider_ambiguous'",
  );
  const migration = await readFile(
    new URL("./0559_stripe_checkout_provider_started_at.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  expect((await db.query("SELECT provider_started_at FROM stripe_checkout_orders")).rows).toEqual([
    { provider_started_at: null },
  ]);
  await expect(
    db.exec(
      "UPDATE stripe_checkout_orders SET status='provider_started',provider_started_at=now() WHERE client_request_key='historical-order'",
    ),
  ).rejects.toThrow("legacy dispatch time cannot be fabricated");
  await db.exec(insert("new-order-request"));
  await db.exec(
    "UPDATE stripe_checkout_orders SET status='provider_started',provider_started_at='2026-01-01Z' WHERE client_request_key='new-order-request'",
  );
  await db.exec(
    "UPDATE stripe_checkout_orders SET status='provider_ambiguous',updated_at=now() WHERE client_request_key='new-order-request'",
  );
  await db.exec(
    "UPDATE stripe_checkout_orders SET status='provider_started',updated_at=now() WHERE client_request_key='new-order-request'",
  );
  await expect(
    db.exec(
      "UPDATE stripe_checkout_orders SET provider_started_at=provider_started_at + interval '1 hour' WHERE client_request_key='new-order-request'",
    ),
  ).rejects.toThrow("first dispatch is immutable");
  await expect(
    db.exec(
      "UPDATE stripe_checkout_orders SET provider_started_at=NULL WHERE client_request_key='new-order-request'",
    ),
  ).rejects.toThrow("first dispatch is immutable");
  expect(
    (
      await db.query<{ stamp: string }>(
        "SELECT provider_started_at::text AS stamp FROM stripe_checkout_orders WHERE client_request_key='new-order-request'",
      )
    ).rows[0]?.stamp,
  ).toBe("2026-01-01 00:00:00+00");
}, 30_000);
