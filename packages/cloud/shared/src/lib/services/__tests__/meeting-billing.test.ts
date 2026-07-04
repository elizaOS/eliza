/**
 * PGlite-backed coverage for meeting transcription billing.
 *
 * These tests drive the real org credit reservation ledger, not a fake ledger:
 * launch windows create debit reservations, finalization settles those rows, and
 * balances are read back from the database so the cloud-money path is observable
 * without reading the implementation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-0000-0000-000000001427";
const USER_ID = "00000000-0000-0000-0000-000000001527";
const PGLITE_TIMEOUT = 60_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let createMeetingCreditBillingSession: typeof import("../meeting-billing").createMeetingCreditBillingSession;
let MeetingCloudBillingError: typeof import("../meeting-billing").MeetingCloudBillingError;

async function seedOrg(balance: string): Promise<void> {
  await dbWrite.execute(`DELETE FROM credit_transactions WHERE organization_id = '${ORG_ID}';`);
  await dbWrite.execute(`DELETE FROM organizations WHERE id = '${ORG_ID}';`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', '${balance}');`,
  );
}

async function balance(): Promise<number> {
  const result = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${ORG_ID}';`,
  );
  return Number((result.rows[0] as { credit_balance: string }).credit_balance);
}

async function transactions(): Promise<
  Array<{
    id: string;
    amount: string;
    type: string;
    settled_at: string | null;
    metadata: Record<string, unknown>;
  }>
> {
  const result = await dbWrite.execute(
    `SELECT id, amount, type, settled_at, metadata
     FROM credit_transactions
     WHERE organization_id = '${ORG_ID}'
     ORDER BY created_at ASC, id ASC;`,
  );
  return result.rows as Array<{
    id: string;
    amount: string;
    type: string;
    settled_at: string | null;
    metadata: Record<string, unknown>;
  }>;
}

function session(options: { maxDurationMs?: number; sessionId?: string } = {}) {
  return createMeetingCreditBillingSession({
    organizationId: ORG_ID,
    userId: USER_ID,
    sessionId: options.sessionId ?? "meeting-session-1",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    maxDurationMs: options.maxDurationMs ?? 60_000,
    usdPerMinute: 0.6,
    initialWindowMs: 10_000,
    chunkWindowMs: 10_000,
  });
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ createMeetingCreditBillingSession, MeetingCloudBillingError } = await import(
    "../meeting-billing"
  ));

  const ddl = [
    `CREATE TABLE IF NOT EXISTS organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL DEFAULT 'test-org',
      slug text NOT NULL DEFAULT 'test-org',
      credit_balance numeric(20,6) NOT NULL DEFAULT '0' CHECK (credit_balance >= 0),
      settings jsonb DEFAULT '{}',
      stripe_customer_id text,
      billing_email text,
      stripe_payment_method_id text,
      stripe_default_payment_method text,
      auto_top_up_enabled boolean DEFAULT false,
      auto_top_up_threshold numeric(12,6),
      auto_top_up_amount numeric(12,6),
      pay_as_you_go_from_earnings boolean NOT NULL DEFAULT true,
      steward_tenant_id text,
      steward_tenant_api_key text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      user_id uuid,
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}',
      stripe_payment_intent_id text,
      created_at timestamp NOT NULL DEFAULT now(),
      settled_at timestamp
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
      ON credit_transactions (stripe_payment_intent_id)`,
  ];
  for (const statement of ddl) {
    await dbWrite.execute(statement);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("MeetingCreditBillingSession", () => {
  beforeEach(async () => {
    await seedOrg("1.00");
  });

  test(
    "reserves the initial launch window before the bot starts",
    async () => {
      const billing = session();

      await billing.reserveInitial();

      expect(billing.state.reservedMs).toBe(10_000);
      expect(billing.state.consumedMs).toBe(0);
      expect(billing.state.reservationIds?.length).toBe(1);
      expect(await balance()).toBeCloseTo(0.9, 6);
      const rows = await transactions();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("debit");
      expect(Number(rows[0]?.amount)).toBeCloseTo(-0.1, 6);
      expect(rows[0]?.settled_at).toBeNull();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "extends in bounded chunks as transcription usage accrues",
    async () => {
      const billing = session();
      await billing.reserveInitial();

      await billing.ensureTranscriptionWindow(25_000);
      await billing.reconcile("normal_completion");

      expect(billing.state.reservedMs).toBe(25_000);
      expect(billing.state.consumedMs).toBe(25_000);
      expect(billing.state.status).toBe("reconciled");
      expect(await balance()).toBeCloseTo(0.75, 6);
      const rows = await transactions();
      expect(rows.filter((row) => row.type === "debit")).toHaveLength(2);
      expect(rows.filter((row) => row.type === "refund")).toHaveLength(0);
      expect(rows.every((row) => row.type !== "debit" || row.settled_at !== null)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "refunds the unused tail on normal reconciliation",
    async () => {
      const billing = session();
      await billing.reserveInitial();

      await billing.ensureTranscriptionWindow(5_000);
      await billing.reconcile("requested_stop");

      expect(await balance()).toBeCloseTo(0.95, 6);
      const rows = await transactions();
      expect(rows.filter((row) => row.type === "debit")).toHaveLength(1);
      const refunds = rows.filter((row) => row.type === "refund");
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0]?.amount)).toBeCloseTo(0.05, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "fails before launch when the initial reservation cannot be funded",
    async () => {
      await seedOrg("0.05");
      const billing = session();

      await expect(billing.reserveInitial()).rejects.toBeInstanceOf(MeetingCloudBillingError);
      expect(billing.state.status).toBe("spend_cap_reached");
      expect(await balance()).toBeCloseTo(0.05, 6);
      expect(await transactions()).toHaveLength(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "refuses a transcription window beyond the session cap before ASR spend continues",
    async () => {
      const billing = session({ maxDurationMs: 15_000 });
      await billing.reserveInitial();

      await expect(billing.ensureTranscriptionWindow(16_000)).rejects.toBeInstanceOf(
        MeetingCloudBillingError,
      );

      expect(billing.state.status).toBe("spend_cap_reached");
      expect(billing.state.consumedMs).toBe(0);
      expect(billing.state.reservedMs).toBe(10_000);
      await billing.reconcile("ended_due_to_spend_cap");
      expect(await balance()).toBeCloseTo(1.0, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "reconciles exactly once when multiple exit paths race",
    async () => {
      const billing = session();
      await billing.reserveInitial();
      await billing.ensureTranscriptionWindow(5_000);

      await Promise.all([
        billing.reconcile("requested_stop"),
        billing.reconcile("normal_completion"),
        billing.reconcile("error"),
      ]);

      const rows = await transactions();
      expect(rows.filter((row) => row.type === "refund")).toHaveLength(1);
      expect(await balance()).toBeCloseTo(0.95, 6);
    },
    PGLITE_TIMEOUT,
  );
});
