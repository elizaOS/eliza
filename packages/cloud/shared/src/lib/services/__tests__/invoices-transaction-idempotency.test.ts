/**
 * Exercises invoice creation against real PGlite to prove caller-transaction
 * reuse and strict unique-key replay validation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-0000000000c1";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000c2";
const PGLITE_TIMEOUT = 60000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let invoicesService: typeof import("../invoices").invoicesService;
let pgliteReady = true;

const invoice = {
  organization_id: ORG_ID,
  stripe_invoice_id: "OXAPAY_PAYMENT_1",
  stripe_customer_id: "OXAPAY_CUSTOMER_1",
  stripe_payment_intent_id: "0xpayment",
  amount_due: "10.00",
  amount_paid: "10.00",
  currency: "usdt",
  status: "paid",
  invoice_type: "crypto_payment",
  credits_added: "10.00",
  metadata: { provider: "oxapay", token: "USDT", transaction_hash: "0xpayment" },
};

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ invoicesService } = await import("../invoices"));
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      stripe_invoice_id text NOT NULL UNIQUE,
      stripe_customer_id text NOT NULL,
      stripe_payment_intent_id text,
      amount_due numeric(10,2) NOT NULL,
      amount_paid numeric(10,2) NOT NULL,
      currency text NOT NULL DEFAULT 'usd',
      status text NOT NULL,
      invoice_type text NOT NULL,
      invoice_number text,
      invoice_pdf text,
      hosted_invoice_url text,
      credits_added numeric(10,2),
      metadata jsonb DEFAULT '{}',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      due_date timestamp,
      paid_at timestamp
    )`);
  } catch {
    // The loud guard below prevents a missing database from becoming a vacuous green.
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

beforeEach(async () => {
  if (pgliteReady) await dbWrite.execute("DELETE FROM invoices");
});

describe("invoice transaction and unique replay", () => {
  test("reuses the caller transaction and returns the same invoice on exact replay", async () => {
    if (!pgliteReady) return;
    await dbWrite.transaction(async (tx) => {
      const first = await invoicesService.create(invoice, tx);
      const replay = await invoicesService.create(invoice, tx);
      expect(replay.id).toBe(first.id);
    });
    const rows = await dbWrite.execute("SELECT count(*)::int AS count FROM invoices");
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });

  test("rejects amount and tenant changes under the same invoice key", async () => {
    if (!pgliteReady) return;
    await invoicesService.create(invoice);
    await expect(invoicesService.create({ ...invoice, amount_paid: "11.00" })).rejects.toThrow(
      "does not match",
    );
    await expect(
      invoicesService.create({ ...invoice, organization_id: OTHER_ORG_ID }),
    ).rejects.toThrow("does not match");
    await expect(
      invoicesService.create({
        ...invoice,
        metadata: { ...invoice.metadata, token: "BTC" },
      }),
    ).rejects.toThrow("does not match");
  });

  test("a later failure rolls back an invoice created on the caller transaction", async () => {
    if (!pgliteReady) return;
    await expect(
      dbWrite.transaction(async (tx) => {
        await invoicesService.create(invoice, tx);
        throw new Error("injected post-invoice failure");
      }),
    ).rejects.toThrow("injected post-invoice failure");
    const rows = await dbWrite.execute("SELECT count(*)::int AS count FROM invoices");
    expect((rows.rows[0] as { count: number }).count).toBe(0);
  });

  test("a deleted projection is rebuilt from the same canonical settlement", async () => {
    if (!pgliteReady) return;
    await invoicesService.create(invoice);
    await dbWrite.execute("DELETE FROM invoices WHERE stripe_invoice_id='OXAPAY_PAYMENT_1'");
    const recovered = await invoicesService.create(invoice);
    expect(recovered.stripe_invoice_id).toBe("OXAPAY_PAYMENT_1");
    expect((recovered.metadata as Record<string, unknown>).settlement_digest).toBeString();
  });
});

test("pglite invoice schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
