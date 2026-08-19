/**
 * Proves unified provider settlement and receipt projection against a real
 * PGlite transaction, including rollback and same-key concurrency.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { sqlRows } from "../../../db/execute-helpers";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const REQUEST_A = "20000000-0000-4000-8000-000000000001";
const REQUEST_B = "20000000-0000-4000-8000-000000000002";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let processPaymentProviderEvent: typeof import("../payment-request-settlement").processPaymentProviderEvent;
let dispatchPaymentCallbacks: typeof import("../payment-request-settlement").dispatchPaymentCallbacks;
let formatUsdFromCents: typeof import("../payment-request-settlement").formatUsdFromCents;
let creditsService: typeof import("../credits").creditsService;

beforeAll(async () => {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  const client = await import("../../../db/client");
  dbWrite = client.dbWrite;
  closeDb = client.closeDatabaseConnectionsForTests;
  ({ dispatchPaymentCallbacks, formatUsdFromCents, processPaymentProviderEvent } = await import(
    "../payment-request-settlement"
  ));
  ({ creditsService } = await import("../credits"));

  const pglite = client.getPgliteClientForTests();
  if (!pglite) throw new Error("PGlite test client was not initialized");
  await pglite.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      credit_balance numeric(12,6) NOT NULL DEFAULT 0,
      settings jsonb DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid,
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}',
      stripe_payment_intent_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz
    );
    CREATE UNIQUE INDEX credit_transactions_stripe_payment_intent_idx
      ON credit_transactions(stripe_payment_intent_id);
    CREATE TABLE payment_requests (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      agent_id uuid,
      app_id uuid,
      provider text NOT NULL,
      amount_cents bigint NOT NULL,
      currency text NOT NULL,
      reason text,
      payment_context jsonb NOT NULL DEFAULT '{"kind":"any_payer"}',
      payer_identity_id text,
      payer_user_id uuid,
      status text NOT NULL,
      hosted_url text,
      callback_url text,
      callback_secret text,
      provider_intent jsonb NOT NULL DEFAULT '{}',
      settled_at timestamptz,
      settlement_tx_ref text,
      settlement_proof jsonb,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE payment_request_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_request_id uuid NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
      event_name text NOT NULL,
      redacted_payload jsonb NOT NULL DEFAULT '{}',
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const migration = await Bun.file(
    new URL("../../../db/migrations/0254_payment_request_provider_settlement.sql", import.meta.url),
  ).text();
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
  const receiptMigration = await Bun.file(
    new URL("../../../db/migrations/0262_payment_request_receipts.sql", import.meta.url),
  ).text();
  for (const statement of receiptMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM payment_request_receipts`);
  await dbWrite.execute(sql`DELETE FROM payment_request_events`);
  await dbWrite.execute(sql`DELETE FROM credit_transactions`);
  await dbWrite.execute(sql`DELETE FROM payment_requests`);
  await dbWrite.execute(sql`DELETE FROM organizations`);
  await dbWrite.execute(
    sql.raw(`
    INSERT INTO organizations (id, name, slug, credit_balance)
    VALUES ('${ORG_A}', 'A', 'a', 0), ('${ORG_B}', 'B', 'b', 0)
  `),
  );
});

async function insertRequest(input?: {
  id?: string;
  orgId?: string;
  provider?: "stripe" | "oxapay";
  amountCents?: number;
  currency?: string;
  status?: string;
  txRef?: string;
}) {
  const id = input?.id ?? REQUEST_A;
  const provider = input?.provider ?? "stripe";
  const providerIntent =
    provider === "stripe"
      ? { stripe_session_id: `cs_${id}`, stripe_payment_intent_id: input?.txRef ?? null }
      : { oxapay_track_id: input?.txRef ?? `trk_${id}` };
  await dbWrite.execute(
    sql.raw(`
    INSERT INTO payment_requests (
      id, organization_id, provider, amount_cents, currency, status,
      provider_intent, expires_at
    ) VALUES (
      '${id}', '${input?.orgId ?? ORG_A}', '${provider}', ${input?.amountCents ?? 2500},
      '${input?.currency ?? "usd"}', '${input?.status ?? "delivered"}',
      '${JSON.stringify(providerIntent)}'::jsonb, now() + interval '1 hour'
    )
  `),
  );
}

function stripeEvent(input?: {
  requestId?: string;
  eventId?: string;
  txRef?: string;
  amountCents?: number;
  currency?: string;
  digest?: string;
  disposition?: "settled" | "failed";
}) {
  const requestId = input?.requestId ?? REQUEST_A;
  const txRef = input?.txRef ?? "pi_a";
  const disposition = input?.disposition ?? "settled";
  return {
    provider: "stripe" as const,
    providerEventId: input?.eventId ?? "evt_a",
    paymentRequestId: requestId,
    disposition,
    providerTxRef: txRef,
    payloadDigest: input?.digest ?? "a".repeat(64),
    amountCents: input?.amountCents ?? 2500,
    currency: input?.currency ?? "usd",
    proof: {
      stripe_session_id: `cs_${requestId}`,
      stripe_payment_intent_id: txRef,
      stripe_payment_status: disposition === "settled" ? "paid" : "unpaid",
    },
    error: disposition === "failed" ? "card failed" : undefined,
  };
}

function oxapayEvent(input?: {
  requestId?: string;
  eventId?: string;
  txRef?: string;
  amountCents?: number;
  digest?: string;
}) {
  const requestId = input?.requestId ?? REQUEST_B;
  const txRef = input?.txRef ?? "trk_b";
  return {
    provider: "oxapay" as const,
    providerEventId: input?.eventId ?? "oxa_evt_b",
    paymentRequestId: requestId,
    disposition: "settled" as const,
    providerTxRef: txRef,
    payloadDigest: input?.digest ?? "b".repeat(64),
    amountCents: input?.amountCents ?? 4301,
    currency: "usd",
    proof: {
      oxapay_track_id: txRef,
      oxapay_order_id: requestId,
      oxapay_status: "paid",
    },
  };
}

async function receiptRows() {
  return sqlRows<{
    organization_id: string;
    payment_request_id: string;
    receipt_type: string;
    provider: string;
    provider_tx_ref: string;
    provider_event_id: string;
    amount_cents: string;
    currency: string;
    payload_digest: string;
    settlement_proof: Record<string, unknown>;
  }>(
    dbWrite,
    sql`SELECT organization_id, payment_request_id, receipt_type, provider,
          provider_tx_ref, provider_event_id, amount_cents::text AS amount_cents,
          currency, payload_digest, settlement_proof
        FROM payment_request_receipts ORDER BY organization_id`,
  );
}

async function moneyRows() {
  const balance = await sqlRows<{ credit_balance: string }>(
    dbWrite,
    sql`SELECT credit_balance FROM organizations WHERE id=${ORG_A}`,
  );
  const credits = await sqlRows<{
    organization_id: string;
    amount: string;
    type: string;
    metadata: Record<string, unknown>;
    stripe_payment_intent_id: string | null;
  }>(
    dbWrite,
    sql`SELECT organization_id, amount, type, metadata, stripe_payment_intent_id
        FROM credit_transactions ORDER BY created_at`,
  );
  const request = await sqlRows<{ status: string; settlement_tx_ref: string | null }>(
    dbWrite,
    sql`SELECT status, settlement_tx_ref FROM payment_requests WHERE id=${REQUEST_A}`,
  );
  return { balance, credits, request };
}

describe("durable payment request settlement", () => {
  test("formats integer cents exactly without a floating-point money conversion", () => {
    expect(formatUsdFromCents(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
  });

  test("concurrent duplicate delivery grants exactly one bound credit", async () => {
    await insertRequest({ txRef: "pi_a" });
    const event = stripeEvent();
    const results = await Promise.all([
      processPaymentProviderEvent(event),
      processPaymentProviderEvent(event),
      processPaymentProviderEvent(event),
    ]);
    expect(results.filter((result) => !result.replay)).toHaveLength(1);
    const distinctStripeEvent = await processPaymentProviderEvent(
      stripeEvent({ eventId: "evt_same_pi_second_object", digest: "f".repeat(64) }),
    );
    expect(distinctStripeEvent.replay).toBe(true);
    const rows = await moneyRows();
    expect(rows.balance[0]?.credit_balance).toBe("25.000000");
    expect(rows.credits).toHaveLength(1);
    expect(rows.credits[0]).toMatchObject({
      organization_id: ORG_A,
      amount: "25.000000",
      type: "credit",
      stripe_payment_intent_id: "pi_a",
    });
    expect(rows.request[0]).toMatchObject({ status: "settled", settlement_tx_ref: "pi_a" });
    const receipts = await receiptRows();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      organization_id: ORG_A,
      payment_request_id: REQUEST_A,
      receipt_type: "provider_payment_receipt",
      provider: "stripe",
      provider_tx_ref: "pi_a",
      provider_event_id: "evt_a",
      amount_cents: "2500",
      currency: "USD",
      payload_digest: "a".repeat(64),
    });
  });

  test("projects Stripe and OxaPay receipts with organization isolation", async () => {
    await insertRequest({ txRef: "pi_a" });
    await insertRequest({
      id: REQUEST_B,
      orgId: ORG_B,
      provider: "oxapay",
      txRef: "trk_b",
      amountCents: 4301,
    });

    await processPaymentProviderEvent(stripeEvent());
    await processPaymentProviderEvent(oxapayEvent());

    expect(await receiptRows()).toEqual([
      expect.objectContaining({
        organization_id: ORG_A,
        payment_request_id: REQUEST_A,
        provider: "stripe",
        provider_tx_ref: "pi_a",
        amount_cents: "2500",
        currency: "USD",
      }),
      expect.objectContaining({
        organization_id: ORG_B,
        payment_request_id: REQUEST_B,
        provider: "oxapay",
        provider_tx_ref: "trk_b",
        amount_cents: "4301",
        currency: "USD",
      }),
    ]);
    const balances = await sqlRows<{ id: string; credit_balance: string }>(
      dbWrite,
      sql`SELECT id, credit_balance FROM organizations ORDER BY id`,
    );
    expect(balances).toEqual([
      { id: ORG_A, credit_balance: "25.000000" },
      { id: ORG_B, credit_balance: "43.010000" },
    ]);
  });

  test("invalidates credit caches only after the settlement transaction commits", async () => {
    await insertRequest({ txRef: "pi_a" });
    const realInvalidate = creditsService.invalidateCreditCaches;
    let observedBalance: string | null = null;
    creditsService.invalidateCreditCaches = async (organizationId: string) => {
      const rows = await sqlRows<{ credit_balance: string }>(
        dbWrite,
        sql`SELECT credit_balance FROM organizations WHERE id=${organizationId}`,
      );
      observedBalance = rows[0]?.credit_balance ?? null;
    };
    try {
      await processPaymentProviderEvent(stripeEvent());
      expect(observedBalance).toBe("25.000000");
    } finally {
      creditsService.invalidateCreditCaches = realInvalidate;
    }
  });

  test("failure after the ledger write rolls back and the same event retries cleanly", async () => {
    await insertRequest({ txRef: "pi_a" });
    const realAddCredits = creditsService.addCredits.bind(creditsService);
    let inject = true;
    creditsService.addCredits = async (params) => {
      const result = await realAddCredits(params);
      if (inject) {
        inject = false;
        throw new Error("injected post-ledger failure");
      }
      return result;
    };
    try {
      await expect(processPaymentProviderEvent(stripeEvent())).rejects.toThrow(
        "injected post-ledger failure",
      );
      let rows = await moneyRows();
      expect(rows.balance[0]?.credit_balance).toBe("0.000000");
      expect(rows.credits).toHaveLength(0);
      expect(rows.request[0]?.status).toBe("delivered");
      expect(await receiptRows()).toHaveLength(0);

      await expect(processPaymentProviderEvent(stripeEvent())).resolves.toMatchObject({
        replay: false,
      });
      rows = await moneyRows();
      expect(rows.balance[0]?.credit_balance).toBe("25.000000");
      expect(rows.credits).toHaveLength(1);
      expect(await receiptRows()).toHaveLength(1);
    } finally {
      creditsService.addCredits = realAddCredits;
    }
  });

  test("a failed event cannot regress settlement and paid may recover after failure", async () => {
    await insertRequest({ txRef: "pi_a" });
    await processPaymentProviderEvent(
      stripeEvent({ eventId: "evt_failed", disposition: "failed", digest: "b".repeat(64) }),
    );
    expect((await moneyRows()).request[0]?.status).toBe("failed");

    await processPaymentProviderEvent(stripeEvent());
    const failureOutbox = await sqlRows<{ callback_state: string }>(
      dbWrite,
      sql`SELECT callback_state FROM payment_request_events
          WHERE provider_event_id='evt_failed'`,
    );
    expect(failureOutbox[0]?.callback_state).toBe("superseded");
    const dispatch = await dispatchPaymentCallbacks({ provider: "stripe", limit: 10 });
    expect(dispatch.claimed).toBe(1);
    await processPaymentProviderEvent(
      stripeEvent({ eventId: "evt_late_failed", disposition: "failed", digest: "c".repeat(64) }),
    );
    const rows = await moneyRows();
    expect(rows.request[0]?.status).toBe("settled");
    expect(rows.credits).toHaveLength(1);
    const lateFailureOutbox = await sqlRows<{ callback_state: string }>(
      dbWrite,
      sql`SELECT callback_state FROM payment_request_events
          WHERE provider_event_id='evt_late_failed'`,
    );
    expect(lateFailureOutbox[0]?.callback_state).toBe("superseded");
    expect(await dispatchPaymentCallbacks({ provider: "stripe", limit: 10 })).toMatchObject({
      claimed: 0,
    });
  });

  test("provider event replay is payload-bound", async () => {
    await insertRequest({ txRef: "pi_a" });
    await processPaymentProviderEvent(stripeEvent());
    await expect(
      processPaymentProviderEvent(stripeEvent({ digest: "d".repeat(64) })),
    ).rejects.toThrow("different payload binding");
    expect((await moneyRows()).credits).toHaveLength(1);
  });

  test("receipt replay conflicts roll back credit fulfillment", async () => {
    await insertRequest({ txRef: "pi_a" });
    await dbWrite.execute(sql`
      INSERT INTO payment_request_receipts (
        organization_id, payment_request_id, provider, provider_tx_ref,
        provider_event_id, amount_cents, currency, settled_at, payload_digest,
        settlement_proof
      ) VALUES (
        ${ORG_A}, ${REQUEST_A}, 'stripe', 'pi_a', 'evt_a', 2499, 'USD', now(),
        ${"a".repeat(64)}, ${stripeEvent().proof}
      )
    `);

    await expect(processPaymentProviderEvent(stripeEvent())).rejects.toThrow(
      "conflicts with immutable settlement metadata",
    );
    const money = await moneyRows();
    expect(money.balance[0]?.credit_balance).toBe("0.000000");
    expect(money.credits).toHaveLength(0);
    expect(money.request[0]?.status).toBe("delivered");
    expect(await receiptRows()).toHaveLength(1);
  });

  test("callback outbox claims once and retries a failed SSRF-safe delivery", async () => {
    await insertRequest({ txRef: "pi_a" });
    await dbWrite.execute(
      sql`UPDATE payment_requests SET callback_url='http://127.0.0.1/private' WHERE id=${REQUEST_A}`,
    );
    await processPaymentProviderEvent(stripeEvent());

    const first = await Promise.all([
      dispatchPaymentCallbacks({ provider: "stripe", providerEventId: "evt_a", limit: 1 }),
      dispatchPaymentCallbacks({ provider: "stripe", providerEventId: "evt_a", limit: 1 }),
    ]);
    expect(first.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(first.reduce((sum, result) => sum + result.failed, 0)).toBe(1);

    await dbWrite.execute(sql`UPDATE payment_requests SET callback_url=NULL WHERE id=${REQUEST_A}`);
    await dbWrite.execute(sql`
      UPDATE payment_request_events
      SET callback_next_attempt_at=now() - interval '1 second'
      WHERE provider='stripe' AND provider_event_id='evt_a'
    `);
    await expect(
      dispatchPaymentCallbacks({ provider: "stripe", providerEventId: "evt_a", limit: 1 }),
    ).resolves.toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    const outbox = await sqlRows<{ callback_state: string; callback_attempts: number }>(
      dbWrite,
      sql`SELECT callback_state, callback_attempts FROM payment_request_events
          WHERE provider='stripe' AND provider_event_id='evt_a'`,
    );
    expect(outbox[0]).toEqual({ callback_state: "dispatched", callback_attempts: 2 });
  });

  test("rejects provider, amount, currency, and provider-transaction cross-binding", async () => {
    await insertRequest({ txRef: "pi_a" });
    await expect(
      processPaymentProviderEvent({ ...stripeEvent(), provider: "oxapay" }),
    ).rejects.toThrow("cannot fulfill");
    await expect(processPaymentProviderEvent(stripeEvent({ amountCents: 2499 }))).rejects.toThrow(
      "amount does not match",
    );
    await expect(processPaymentProviderEvent(stripeEvent({ currency: "eur" }))).rejects.toThrow(
      "requires a USD",
    );
    await dbWrite.execute(sql`UPDATE payment_requests SET currency='jpy' WHERE id=${REQUEST_A}`);
    await expect(
      processPaymentProviderEvent(stripeEvent({ currency: "jpy", digest: "e".repeat(64) })),
    ).rejects.toThrow("requires a USD");
    await dbWrite.execute(sql`UPDATE payment_requests SET currency='usd' WHERE id=${REQUEST_A}`);

    await processPaymentProviderEvent(stripeEvent());
    await insertRequest({ id: REQUEST_B, orgId: ORG_B, txRef: "pi_a" });
    await expect(
      processPaymentProviderEvent(stripeEvent({ requestId: REQUEST_B, eventId: "evt_a" })),
    ).rejects.toThrow("different payload binding");
    await expect(
      processPaymentProviderEvent(
        stripeEvent({
          requestId: REQUEST_B,
          eventId: "evt_b",
          txRef: "pi_a",
          digest: "e".repeat(64),
        }),
      ),
    ).rejects.toThrow();
    const other = await sqlRows<{ credit_balance: string }>(
      dbWrite,
      sql`SELECT credit_balance FROM organizations WHERE id=${ORG_B}`,
    );
    expect(other[0]?.credit_balance).toBe("0.000000");
    expect(
      (await receiptRows()).filter((receipt) => receipt.organization_id === ORG_B),
    ).toHaveLength(0);
  });
});
