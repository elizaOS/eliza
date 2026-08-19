/**
 * Applies migrations 0262-0263 to real PGlite and proves deterministic backfill,
 * replay safety, immutable retention, and tenant/provider binding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const REQUEST_A = "20000000-0000-4000-8000-000000000001";
const REQUEST_B = "20000000-0000-4000-8000-000000000002";
const schemaMigration = await readFile(
  new URL("./0262_payment_request_receipts.sql", import.meta.url),
  "utf8",
);
const backfillMigration = await readFile(
  new URL("./0263_payment_request_receipt_backfill.sql", import.meta.url),
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
      settlement_proof jsonb,
      provider_intent jsonb NOT NULL DEFAULT '{}'
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
    INSERT INTO organizations(id) VALUES ('${ORG_A}'), ('${ORG_B}');
  `);
  return db;
}

async function seedHistoricalRequest(db: PGlite, proof?: string): Promise<void> {
  const defaultProof = JSON.stringify({
    stripe_event_id: "evt_a",
    stripe_event_type: "checkout.session.completed",
    stripe_session_id: "cs_a",
    stripe_payment_intent_id: "pi_a",
    stripe_amount_total: 2500,
    stripe_currency: "usd",
    stripe_payment_status: "paid",
  });
  await db.exec(`
    INSERT INTO payment_requests (
      id, organization_id, provider, amount_cents, currency, status,
      settled_at, settlement_tx_ref, settlement_proof, provider_intent
    ) VALUES (
      '${REQUEST_A}', '${ORG_A}', 'stripe', 2500, 'usd', 'settled',
      '2026-08-19T08:00:00.000Z', 'pi_a',
      '${proof ?? defaultProof}', '{"stripe_session_id":"cs_a","stripe_payment_intent_id":"pi_a"}'
    );
  `);
}

async function seedHistoricalOxapayRequest(db: PGlite, proof: string): Promise<void> {
  await db.exec(`
    INSERT INTO payment_requests (
      id, organization_id, provider, amount_cents, currency, status,
      settled_at, settlement_tx_ref, settlement_proof, provider_intent
    ) VALUES (
      '${REQUEST_A}', '${ORG_A}', 'oxapay', 2500, 'usd', 'settled',
      '2026-08-19T08:00:00.000Z', 'trk_a', '${proof}', '{"oxapay_track_id":"trk_a"}'
    );
  `);
}

async function seedAuthority(db: PGlite, eventId = "evt_a", digest = "a".repeat(64)) {
  const callback = JSON.stringify({
    name: "PaymentSettled",
    paymentRequestId: REQUEST_A,
    provider: "stripe",
    providerEventId: eventId,
    txRef: "pi_a",
    amountCents: 2500,
    currency: "USD",
    occurredAt: "2026-08-19T08:00:00.000Z",
    raw_webhook: "must-not-copy",
  });
  await db.exec(`
    INSERT INTO payment_request_events (
      payment_request_id, event_name, redacted_payload, provider, provider_event_id,
      provider_tx_ref, provider_disposition, payload_digest, occurred_at
    ) VALUES (
      '${REQUEST_A}', 'webhook.received', '${callback}',
      'stripe', '${eventId}', 'pi_a', 'settled', '${digest}',
      '2026-08-19T08:00:00.000Z'
    );
  `);
}

async function seedOxapayAuthority(db: PGlite): Promise<void> {
  const callback = JSON.stringify({
    name: "PaymentSettled",
    paymentRequestId: REQUEST_A,
    provider: "oxapay",
    providerEventId: "trk_a:paid",
    txRef: "trk_a",
    amountCents: 2500,
    currency: "USD",
    occurredAt: "2026-08-19T08:00:00.000Z",
  });
  await db.exec(`
    INSERT INTO payment_request_events (
      payment_request_id, event_name, redacted_payload, provider, provider_event_id,
      provider_tx_ref, provider_disposition, payload_digest, occurred_at
    ) VALUES (
      '${REQUEST_A}', 'webhook.received', '${callback}', 'oxapay', 'trk_a:paid',
      'trk_a', 'settled', '${"b".repeat(64)}', '2026-08-19T08:00:00.000Z'
    );
  `);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0262-0263 payment request receipts migrations", () => {
  test("backfills one curated receipt and replays without changing it", async () => {
    const db = await database();
    await seedHistoricalRequest(db);
    await seedAuthority(db);
    await db.exec(schemaMigration);
    const [precondition, insert] = backfillMigration.split("--> statement-breakpoint");
    if (!precondition || !insert) throw new Error("0263 migration prefix is incomplete");
    await db.exec(precondition);
    await db.exec(insert);
    // Simulate interruption after insert but before the exact postcondition.
    await db.exec(backfillMigration);
    await db.exec(schemaMigration);
    await db.exec(backfillMigration);

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
          stripe_event_id: "evt_a",
          stripe_event_type: "checkout.session.completed",
          stripe_session_id: "cs_a",
          stripe_payment_intent_id: "pi_a",
          stripe_amount_total: 2500,
          stripe_currency: "usd",
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
    await seedHistoricalRequest(db);
    await seedAuthority(db);
    await db.exec(schemaMigration);
    await db.exec(backfillMigration);

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

  test("rejects missing or ambiguous historical settlement authority", async () => {
    const missing = await database();
    await seedHistoricalRequest(missing);
    await missing.exec(schemaMigration);
    await expect(missing.exec(backfillMigration)).rejects.toThrow(/lacks one curated/i);

    const ambiguous = await database();
    await seedHistoricalRequest(ambiguous);
    await seedAuthority(ambiguous);
    await seedAuthority(ambiguous, "evt_b", "b".repeat(64));
    await ambiguous.exec(schemaMigration);
    await expect(ambiguous.exec(backfillMigration)).rejects.toThrow(/lacks one curated/i);
  });

  test("rejects an uncurated stored proof and a valid-shaped wrong existing row", async () => {
    const uncurated = await database();
    await seedHistoricalRequest(
      uncurated,
      '{"stripe_event_id":"evt_a","stripe_event_type":"checkout.session.completed","stripe_session_id":"cs_a","stripe_payment_intent_id":"pi_a","stripe_amount_total":2500,"stripe_currency":"usd","stripe_payment_status":"paid","raw_webhook":"must-not-copy"}',
    );
    await seedAuthority(uncurated);
    await uncurated.exec(schemaMigration);
    await expect(uncurated.exec(backfillMigration)).rejects.toThrow(/lacks one curated/i);

    const conflicting = await database();
    await seedHistoricalRequest(conflicting);
    await seedAuthority(conflicting);
    await conflicting.exec(schemaMigration);
    await conflicting.exec(`INSERT INTO payment_request_receipts (
      organization_id, payment_request_id, provider, provider_tx_ref,
      provider_event_id, amount_cents, currency, settled_at, payload_digest,
      settlement_proof
    ) VALUES (
      '${ORG_A}', '${REQUEST_A}', 'stripe', 'pi_a', 'evt_a', 2499, 'USD',
      '2026-08-19T08:00:00.000Z', '${"a".repeat(64)}',
      '{"stripe_session_id":"cs_a","stripe_payment_intent_id":"pi_a","stripe_payment_status":"paid"}'
    )`);
    await expect(conflicting.exec(backfillMigration)).rejects.toThrow(/postcondition failed/i);
  });

  test("rejects contradictory provider event, provider, amount, and currency proof", async () => {
    const stripeProof = {
      stripe_event_id: "evt_a",
      stripe_event_type: "checkout.session.completed",
      stripe_session_id: "cs_a",
      stripe_payment_intent_id: "pi_a",
      stripe_amount_total: 2500,
      stripe_currency: "usd",
      stripe_payment_status: "paid",
    };
    const oxapayProof = {
      provider: "oxapay",
      oxapay_track_id: "trk_a",
      oxapay_order_id: REQUEST_A,
      oxapay_status: "paid",
      oxapay_amount_cents: 2500,
      oxapay_currency: "USD",
    };
    const cases: Array<{
      provider: "stripe" | "oxapay";
      proof: Record<string, unknown>;
    }> = [
      { provider: "stripe", proof: { ...stripeProof, stripe_event_id: "evt_wrong" } },
      { provider: "stripe", proof: { ...stripeProof, stripe_amount_total: 2499 } },
      { provider: "stripe", proof: { ...stripeProof, stripe_currency: "EUR" } },
      { provider: "oxapay", proof: { ...oxapayProof, provider: "stripe" } },
      { provider: "oxapay", proof: { ...oxapayProof, oxapay_amount_cents: 2499 } },
      { provider: "oxapay", proof: { ...oxapayProof, oxapay_currency: "EUR" } },
      {
        provider: "oxapay",
        proof: { ...oxapayProof, oxapay_callback_currency: "POL" },
      },
      {
        provider: "oxapay",
        proof: { ...oxapayProof, oxapay_type: "payer@example.invalid" },
      },
    ];

    for (const input of cases) {
      const db = await database();
      if (input.provider === "stripe") {
        await seedHistoricalRequest(db, JSON.stringify(input.proof));
        await seedAuthority(db);
      } else {
        await seedHistoricalOxapayRequest(db, JSON.stringify(input.proof));
        await seedOxapayAuthority(db);
      }
      await db.exec(schemaMigration);
      await expect(db.exec(backfillMigration)).rejects.toThrow(/lacks one curated/i);
      const receipts = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payment_request_receipts",
      );
      expect(receipts.rows).toEqual([{ count: 0 }]);
    }
  });

  test("fails closed instead of accepting a colliding partial table", async () => {
    const db = await database();
    await db.exec("CREATE TABLE payment_request_receipts (id uuid PRIMARY KEY)");
    await expect(db.exec(schemaMigration)).rejects.toThrow();
    const columns = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='payment_request_receipts'
    `);
    expect(columns.rows).toEqual([{ column_name: "id" }]);
  });
});
