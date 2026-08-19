/**
 * Applies migration 0262 to real PGlite and proves deterministic backfill,
 * replay safety, immutable retention, and tenant/provider binding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const REQUEST_A = "20000000-0000-4000-8000-000000000001";
const REQUEST_B = "20000000-0000-4000-8000-000000000002";
const migration = await readFile(
  new URL("./0262_payment_request_receipts.sql", import.meta.url),
  "utf8",
);
const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE payment_requests (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      provider text NOT NULL,
      amount_cents bigint NOT NULL,
      currency text NOT NULL,
      status text NOT NULL,
      settled_at timestamptz,
      settlement_tx_ref text,
      settlement_proof jsonb
    );
    CREATE TABLE payment_request_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_request_id uuid NOT NULL REFERENCES payment_requests(id),
      event_name text NOT NULL,
      redacted_payload jsonb NOT NULL DEFAULT '{}',
      provider text,
      provider_event_id text,
      provider_tx_ref text,
      provider_disposition text,
      payload_digest text,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX payment_request_events_settled_provider_tx_unique
      ON payment_request_events(provider, provider_tx_ref)
      WHERE event_name='webhook.received' AND provider_disposition='settled';
    INSERT INTO organizations(id) VALUES ('${ORG_A}'), ('${ORG_B}');
  `);
  return db;
}

async function seedHistoricalSettlement(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO payment_requests (
      id, organization_id, provider, amount_cents, currency, status,
      settled_at, settlement_tx_ref, settlement_proof
    ) VALUES (
      '${REQUEST_A}', '${ORG_A}', 'stripe', 2500, 'usd', 'settled',
      '2026-08-19T08:00:00.000Z', 'pi_a',
      '{"stripe_session_id":"cs_a","stripe_payment_intent_id":"pi_a","stripe_payment_status":"paid"}'
    );
    INSERT INTO payment_request_events (
      payment_request_id, event_name, redacted_payload, provider, provider_event_id,
      provider_tx_ref, provider_disposition, payload_digest, occurred_at
    ) VALUES (
      '${REQUEST_A}', 'webhook.received', '{"raw_webhook":"must-not-copy"}',
      'stripe', 'evt_a', 'pi_a', 'settled', '${"a".repeat(64)}',
      '2026-08-19T08:00:00.000Z'
    );
  `);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0262 payment request receipts migration", () => {
  test("backfills one curated receipt and replays without changing it", async () => {
    const db = await database();
    await seedHistoricalSettlement(db);
    await db.exec(migration);
    await db.exec(migration);

    const receipts = await db.query<{
      organization_id: string;
      payment_request_id: string;
      provider: string;
      provider_event_id: string;
      amount_cents: string;
      currency: string;
      payload_digest: string;
      settlement_proof: Record<string, unknown>;
    }>(`SELECT organization_id::text, payment_request_id::text, provider,
        provider_event_id, amount_cents::text, currency, payload_digest, settlement_proof
      FROM payment_request_receipts`);
    expect(receipts.rows).toEqual([
      {
        organization_id: ORG_A,
        payment_request_id: REQUEST_A,
        provider: "stripe",
        provider_event_id: "evt_a",
        amount_cents: "2500",
        currency: "USD",
        payload_digest: "a".repeat(64),
        settlement_proof: {
          stripe_session_id: "cs_a",
          stripe_payment_intent_id: "pi_a",
          stripe_payment_status: "paid",
        },
      },
    ]);
    expect(JSON.stringify(receipts.rows)).not.toContain("must-not-copy");

    const triggers = await db.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname IN (
        'payment_request_receipts_immutable',
        'payment_request_receipts_truncate_guard'
      ) AND NOT tgisinternal
    `);
    expect(triggers.rows).toEqual([{ count: 2 }]);
  });

  test("rejects mutation, deletion, truncation, and cross-authority inserts", async () => {
    const db = await database();
    await seedHistoricalSettlement(db);
    await db.exec(migration);

    await expect(db.exec("UPDATE payment_request_receipts SET amount_cents=1")).rejects.toThrow(
      /immutable/i,
    );
    await expect(db.exec("DELETE FROM payment_request_receipts")).rejects.toThrow(/immutable/i);
    await expect(db.exec("TRUNCATE payment_request_receipts")).rejects.toThrow(/immutable/i);

    await db.exec(`INSERT INTO payment_requests (
      id, organization_id, provider, amount_cents, currency, status
    ) VALUES ('${REQUEST_B}', '${ORG_A}', 'stripe', 100, 'usd', 'delivered')`);
    for (const [requestId, organizationId, provider, txRef] of [
      [REQUEST_A, ORG_B, "stripe", "pi_cross_tenant"],
      [REQUEST_B, ORG_A, "oxapay", "trk_cross_provider"],
    ]) {
      await expect(
        db.exec(`INSERT INTO payment_request_receipts (
          organization_id, payment_request_id, provider, provider_tx_ref,
          provider_event_id, amount_cents, currency, settled_at, payload_digest,
          settlement_proof
        ) VALUES (
          '${organizationId}', '${requestId}', '${provider}', '${txRef}', 'evt_cross',
          100, 'USD', now(), '${"b".repeat(64)}', '{}'
        )`),
      ).rejects.toThrow();
    }
  });

  test("fails closed instead of accepting a colliding partial table", async () => {
    const db = await database();
    await db.exec("CREATE TABLE payment_request_receipts (id uuid PRIMARY KEY)");
    await expect(db.exec(migration)).rejects.toThrow();
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='payment_request_receipts'
    `);
    expect(columns.rows).toEqual([{ column_name: "id" }]);
  });
});
