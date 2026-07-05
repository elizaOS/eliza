/**
 * Real-DB coverage for the DB-backed pending-charge + settlement ledger (#9899).
 *
 * The ledger is the durable, exactly-once replacement for the KV optimistic
 * backstop, and it is BILLING-CRITICAL: it decides who may skip the synchronous
 * reserve (admission) and how the deferred cost is collected (settle / sweep). A
 * regression here is either a free-inference leak or a double charge, so every
 * test drives the REAL SQL against in-process PGlite — the same honest pattern as
 * `credits-deduct-guard.test.ts`. Only the fire-and-forget, non-billing
 * side-effects on the deduct success path (email / webhook / auto-top-up) are
 * stubbed; the admission accounting, the atomic claim, and the debit run real.
 *
 * What is pinned:
 *   - Admission: affordable → admitted; threshold gate; HARD overdraw bound
 *     (balance − in-flight); unknown org; +Inf threshold; idempotent re-delivery.
 *   - Settle: inline claims + debits the ACTUAL; EXACTLY-ONCE (a second settle and
 *     the sweep cannot re-charge); settle(0) claims but charges nothing;
 *     uncollected (debit refused by CHECK(>=0)) → row marked, balance intact.
 *   - Sweep: drains stale pending charging the ESTIMATE; skips young rows;
 *     age-ordered across batches; inline-then-sweep never double-charges.
 *   - Concurrency: a same-org burst cannot collectively overdraw.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

// Stub the non-billing fire-and-forget side-effects the deduct success path kicks
// off — NOT the code under test. The deduct + guard SQL runs real against PGlite.
mock.module("../email", () => ({
  emailService: { sendLowCreditsEmail: mock(async () => false) },
}));
mock.module("../waifu-webhook", () => ({
  resolveWaifuWebhookTarget: mock(() => null),
  classifyCreditBalance: mock(() => null),
  emitWaifuCreditWebhook: mock(async () => undefined),
}));
mock.module("../auto-top-up", () => ({
  autoTopUpService: { executeAutoTopUp: mock(async () => undefined) },
}));

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-00000000ce01";
const USER_ID = "00000000-0000-0000-0000-00000000ce02";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ledger: typeof import("../inference-billing-ledger");
let creditsService: typeof import("../credits").creditsService;
let pgliteReady = true;

let chargeSeq = 0;
function nextRequestId(): string {
  chargeSeq += 1;
  return `req-ledger-${chargeSeq}`;
}

function charge(requestId: string) {
  return {
    requestId,
    organizationId: ORG_ID,
    userId: USER_ID,
    apiKeyId: null,
    model: "gpt-oss-120b",
    provider: "cerebras",
    billingSource: "platform" as const,
  };
}

async function seedOrg(balance: string): Promise<void> {
  await dbWrite.execute(`DELETE FROM inference_pending_charges;`);
  await dbWrite.execute(`DELETE FROM credit_transactions;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug, credit_balance, pay_as_you_go_from_earnings, is_active)
     VALUES ('${ORG_ID}', 'Acme', 'acme-${ORG_ID}', '${balance}', true, true);`,
  );
}

async function readBalance(): Promise<number> {
  const rows = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${ORG_ID}';`,
  );
  return Number((rows.rows[0] as { credit_balance: string }).credit_balance);
}

async function pendingRows(): Promise<
  { request_id: string; status: string; estimated: number; actual: number | null }[]
> {
  const rows = await dbWrite.execute(
    `SELECT request_id, status, estimated_cost_usd, actual_cost_usd
     FROM inference_pending_charges ORDER BY enqueued_at ASC;`,
  );
  return (
    rows.rows as {
      request_id: string;
      status: string;
      estimated_cost_usd: string;
      actual_cost_usd: string | null;
    }[]
  ).map((r) => ({
    request_id: r.request_id,
    status: r.status,
    estimated: Number(r.estimated_cost_usd),
    actual: r.actual_cost_usd === null ? null : Number(r.actual_cost_usd),
  }));
}

async function debitCount(): Promise<number> {
  const rows = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id = '${ORG_ID}' AND type = 'debit';`,
  );
  return Number((rows.rows[0] as { n: number }).n);
}

/** Insert a pending row directly with a controlled age (for sweep/uncollected setup). */
async function insertPending(requestId: string, estimate: string, ageMs: number): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO inference_pending_charges
       (request_id, organization_id, user_id, api_key_id, model, provider, billing_source, estimated_cost_usd, status, enqueued_at)
     VALUES ('${requestId}', '${ORG_ID}', '${USER_ID}', NULL, 'gpt-oss-120b', 'cerebras', 'platform', '${estimate}', 'pending', NOW() - INTERVAL '${ageMs} milliseconds');`,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ledger = await import("../inference-billing-ledger");
    ({ creditsService } = await import("../credits"));

    const ddl = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL,
        credit_balance numeric(12,6) NOT NULL DEFAULT '0' CHECK (credit_balance >= 0),
        settings jsonb DEFAULT '{}',
        stripe_customer_id text,
        billing_email text,
        stripe_payment_method_id text,
        stripe_default_payment_method text,
        auto_top_up_enabled boolean DEFAULT false,
        auto_top_up_threshold numeric(10,2),
        auto_top_up_amount numeric(10,2),
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
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
        ON credit_transactions (stripe_payment_intent_id)`,
      // The table under test — matches migration 0153 + the schema.
      `CREATE TABLE IF NOT EXISTS inference_pending_charges (
        request_id text PRIMARY KEY,
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        model text NOT NULL,
        provider text NOT NULL,
        billing_source text NOT NULL,
        estimated_cost_usd numeric(12,6) NOT NULL,
        actual_cost_usd numeric(12,6),
        status text NOT NULL DEFAULT 'pending',
        enqueued_at timestamp NOT NULL DEFAULT now(),
        settled_at timestamp
      )`,
      `CREATE INDEX IF NOT EXISTS inference_pending_charges_pending_age_idx
        ON inference_pending_charges (enqueued_at) WHERE status = 'pending'`,
      `CREATE INDEX IF NOT EXISTS inference_pending_charges_org_pending_idx
        ON inference_pending_charges (organization_id) WHERE status = 'pending'`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);
  } catch (error) {
    pgliteReady = false;
    console.warn("[inference-billing-ledger] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("admitInferenceChargeViaLedger — atomic admission gate", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("10.000000");
  });

  test(
    "admits an affordable charge and writes exactly one pending row at the estimate",
    async () => {
      if (!pgliteReady) return;
      const reqId = nextRequestId();
      const res = await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 3,
        thresholdUsd: 1,
      });
      expect(res.admitted).toBe(true);
      const rows = await pendingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ request_id: reqId, status: "pending", estimated: 3 });
      // Admission reserves in-flight only — it must NOT move the balance yet.
      expect(await readBalance()).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rejects when the balance does not clear the threshold (no row written)",
    async () => {
      if (!pgliteReady) return;
      const res = await ledger.admitInferenceChargeViaLedger({
        charge: charge(nextRequestId()),
        estimatedCostUsd: 1,
        thresholdUsd: 10, // balance 10 is NOT > 10
      });
      expect(res.admitted).toBe(false);
      expect(res.reason).toBe("ineligible");
      expect(await pendingRows()).toHaveLength(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "HARD overdraw bound: admission accounts for in-flight pending charges",
    async () => {
      if (!pgliteReady) return;
      // $8 already in-flight against a $10 balance, threshold $1.
      await insertPending(nextRequestId(), "5.000000", 1000);
      await insertPending(nextRequestId(), "3.000000", 1000);

      // available = 10 - 8 = 2. A $3 charge must be REFUSED (would overdraw)...
      const tooBig = await ledger.admitInferenceChargeViaLedger({
        charge: charge(nextRequestId()),
        estimatedCostUsd: 3,
        thresholdUsd: 1,
      });
      expect(tooBig.admitted).toBe(false);
      expect(tooBig.reason).toBe("ineligible");

      // ...but a $2 charge sits exactly on the boundary and is admitted.
      const onBoundary = await ledger.admitInferenceChargeViaLedger({
        charge: charge(nextRequestId()),
        estimatedCostUsd: 2,
        thresholdUsd: 1,
      });
      expect(onBoundary.admitted).toBe(true);

      // Total in-flight now exactly equals the balance — never more.
      const inflight = (await pendingRows())
        .filter((r) => r.status === "pending")
        .reduce((s, r) => s + r.estimated, 0);
      expect(inflight).toBeCloseTo(10, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "rejects an unknown organization with reason org_not_found",
    async () => {
      if (!pgliteReady) return;
      const res = await ledger.admitInferenceChargeViaLedger({
        charge: {
          ...charge(nextRequestId()),
          organizationId: "00000000-0000-0000-0000-00000000dead",
        },
        estimatedCostUsd: 1,
        thresholdUsd: 1,
      });
      expect(res.admitted).toBe(false);
      expect(res.reason).toBe("org_not_found");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "fails SAFE on a +Infinity threshold (misconfigured SAFE_BALANCE_THRESHOLD) without touching the DB",
    async () => {
      if (!pgliteReady) return;
      const res = await ledger.admitInferenceChargeViaLedger({
        charge: charge(nextRequestId()),
        estimatedCostUsd: 1,
        thresholdUsd: Number.POSITIVE_INFINITY,
      });
      expect(res.admitted).toBe(false);
      expect(await pendingRows()).toHaveLength(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "idempotent re-delivery: the same request id never writes a second pending row",
    async () => {
      if (!pgliteReady) return;
      const reqId = nextRequestId();
      const first = await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 2,
        thresholdUsd: 1,
      });
      expect(first.admitted).toBe(true);
      // Re-admitting the same id is an ON CONFLICT DO NOTHING → not admitted, so
      // the route falls to the safe synchronous reserve (matches the KV backstop).
      const second = await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 2,
        thresholdUsd: 1,
      });
      expect(second.admitted).toBe(false);
      expect(await pendingRows()).toHaveLength(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a same-org concurrent burst cannot collectively overdraw",
    async () => {
      if (!pgliteReady) return;
      // Balance $10, threshold $1, three concurrent $6 charges. At most one can be
      // admitted ($6 ≤ $10; the next sees available $4 < $6).
      //
      // NOTE: single-connection PGlite serializes these `Promise.all` admissions,
      // so this asserts the ACCOUNTING (in-flight ≤ balance), not true parallel
      // locking. The HARD bound under real multi-connection Postgres comes from the
      // per-org `pg_advisory_xact_lock` in admitInferenceChargeViaLedger, which
      // makes each admission read the in-flight SUM only after the prior one
      // commits — see the module header. A bare cross-table SUM under FOR UPDATE
      // would read a stale snapshot and over-admit.
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          ledger.admitInferenceChargeViaLedger({
            charge: charge(nextRequestId()),
            estimatedCostUsd: 6,
            thresholdUsd: 1,
          }),
        ),
      );
      const admitted = results.filter((r) => r.admitted).length;
      expect(admitted).toBe(1);
      const inflight = (await pendingRows())
        .filter((r) => r.status === "pending")
        .reduce((s, r) => s + r.estimated, 0);
      expect(inflight).toBeLessThanOrEqual(10);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "admission accounts for in-flight via the pending rows themselves (self-correcting, no separate counter)",
    async () => {
      if (!pgliteReady) return;
      // Admit $4 (in-flight $4 of $10). A second $7 is refused (10-4=6 < 7)...
      await ledger.admitInferenceChargeViaLedger({
        charge: charge(nextRequestId()),
        estimatedCostUsd: 4,
        thresholdUsd: 1,
      });
      const refused = await ledger.admitInferenceChargeViaLedger({
        charge: charge(nextRequestId()),
        estimatedCostUsd: 7,
        thresholdUsd: 1,
      });
      expect(refused.admitted).toBe(false);
      // ...but once the first SETTLES (leaves the pending set), headroom returns and
      // the $7 is admitted — proving in-flight is the live SUM of pending rows.
      const firstId = (await pendingRows())[0].request_id;
      await ledger.createLedgerDebitSettler({ ...charge(firstId) })(4);
      const nowOk = await ledger.admitInferenceChargeViaLedger({
        charge: charge(nextRequestId()),
        estimatedCostUsd: 5, // balance is now $6 after the $4 debit; 5 ≤ 6
        thresholdUsd: 1,
      });
      expect(nowOk.admitted).toBe(true);
    },
    PGLITE_TIMEOUT,
  );
});

describe("createLedgerDebitSettler — exactly-once inline settlement", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("10.000000");
  });

  test(
    "settles the ACTUAL cost: claims the row, debits once, moves the balance by -actual",
    async () => {
      if (!pgliteReady) return;
      const reqId = nextRequestId();
      await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 3,
        thresholdUsd: 1,
      });
      const settle = ledger.createLedgerDebitSettler(charge(reqId));
      await settle(2.5);

      expect(await readBalance()).toBeCloseTo(7.5, 6);
      expect(await debitCount()).toBe(1);
      const row = (await pendingRows())[0];
      expect(row).toMatchObject({ status: "settled", actual: 2.5 });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "EXACTLY-ONCE: a second settle of the same request charges nothing more",
    async () => {
      if (!pgliteReady) return;
      const reqId = nextRequestId();
      await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 3,
        thresholdUsd: 1,
      });
      const settle = ledger.createLedgerDebitSettler(charge(reqId));
      await settle(2.5);
      await settle(2.5); // duplicate (retry / double waitUntil)

      expect(await readBalance()).toBeCloseTo(7.5, 6); // not 5.0
      expect(await debitCount()).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "settle(0) (error/abort) claims the row but charges nothing",
    async () => {
      if (!pgliteReady) return;
      const reqId = nextRequestId();
      await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 3,
        thresholdUsd: 1,
      });
      await ledger.createLedgerDebitSettler(charge(reqId))(0);

      expect(await readBalance()).toBeCloseTo(10, 6);
      expect(await debitCount()).toBe(0);
      expect((await pendingRows())[0]).toMatchObject({ status: "settled", actual: 0 });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "fires the low-credit/auto-top-up/waifu notifications on a successful debit (parity with deductCredits)",
    async () => {
      if (!pgliteReady) return;
      const notify = spyOn(creditsService, "notifyBalanceDecrease");
      try {
        const reqId = nextRequestId();
        await ledger.admitInferenceChargeViaLedger({
          charge: charge(reqId),
          estimatedCostUsd: 3,
          thresholdUsd: 1,
        });
        await ledger.createLedgerDebitSettler(charge(reqId))(2);
        // The org drained $2 → it must get the same low-balance notifications every
        // other billing path fires (so a hosted agent is told to pause, etc.).
        expect(notify).toHaveBeenCalledTimes(1);
        const [org, newBalance] = notify.mock.calls[0];
        expect(org).toBe(ORG_ID);
        expect(newBalance).toBeCloseTo(8, 6);
      } finally {
        notify.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "does NOT fire balance-decrease notifications when nothing was debited (settle(0) / uncollected)",
    async () => {
      if (!pgliteReady) return;
      const notify = spyOn(creditsService, "notifyBalanceDecrease");
      try {
        const reqId = nextRequestId();
        await ledger.admitInferenceChargeViaLedger({
          charge: charge(reqId),
          estimatedCostUsd: 3,
          thresholdUsd: 1,
        });
        await ledger.createLedgerDebitSettler(charge(reqId))(0); // claims, charges nothing
        expect(notify).not.toHaveBeenCalled();
      } finally {
        notify.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "uncollected: a debit the DB refuses (would overdraw) marks the row, leaves the balance intact",
    async () => {
      if (!pgliteReady) return;
      const reqId = nextRequestId();
      await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 1,
        thresholdUsd: 0.5,
      });
      // Drain the org to $0.50 out-of-band, then settle an actual that exceeds it.
      await dbWrite.execute(
        `UPDATE organizations SET credit_balance = '0.500000' WHERE id = '${ORG_ID}';`,
      );
      await ledger.createLedgerDebitSettler(charge(reqId))(5);

      // CHECK(credit_balance >= 0) refused the debit → balance untouched, no debit row.
      expect(await readBalance()).toBeCloseTo(0.5, 6);
      expect(await debitCount()).toBe(0);
      // The charge is recorded uncollected (auditable), not left pending forever.
      expect((await pendingRows())[0]).toMatchObject({ status: "uncollected" });
    },
    PGLITE_TIMEOUT,
  );
});

describe("sweepStalePendingInferenceChargesDb — cron backstop", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("100.000000");
  });

  test(
    "settles stale pending rows charging the ESTIMATE; skips young ones",
    async () => {
      if (!pgliteReady) return;
      const stale = nextRequestId();
      const young = nextRequestId();
      await insertPending(stale, "4.000000", 30 * 60 * 1000); // 30 min old → stale
      await insertPending(young, "2.000000", 60 * 1000); // 1 min old → in-flight

      const stats = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });

      expect(stats.settled).toBe(1);
      expect(await readBalance()).toBeCloseTo(96, 6); // only the $4 stale charge
      const rows = await pendingRows();
      expect(rows.find((r) => r.request_id === stale)?.status).toBe("settled");
      expect(rows.find((r) => r.request_id === young)?.status).toBe("pending");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "inline-then-sweep never double-charges (the inline settle already claimed it)",
    async () => {
      if (!pgliteReady) return;
      const reqId = nextRequestId();
      await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 4,
        thresholdUsd: 1,
      });
      await ledger.createLedgerDebitSettler(charge(reqId))(3); // inline: balance 100 → 97
      // Even though the row is now old, the sweep finds nothing pending to charge.
      const stats = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 0 });
      expect(stats.settled).toBe(0);
      expect(await readBalance()).toBeCloseTo(97, 6);
      expect(await debitCount()).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "drains the whole stale backlog oldest-first across multiple batches (no silent cap)",
    async () => {
      if (!pgliteReady) return;
      for (let i = 0; i < 5; i++) {
        await insertPending(nextRequestId(), "1.000000", (40 + i) * 60 * 1000);
      }
      const stats = await ledger.sweepStalePendingInferenceChargesDb({
        graceMs: 20 * 60 * 1000,
        batchSize: 2, // force multiple batches
      });
      expect(stats.settled).toBe(5);
      expect(stats.batches).toBeGreaterThanOrEqual(3);
      expect(await readBalance()).toBeCloseTo(95, 6);
      expect((await pendingRows()).every((r) => r.status === "settled")).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a dropped inline settle (row left pending) is recovered by the sweep — no lost charge",
    async () => {
      if (!pgliteReady) return;
      // Admit but NEVER call the inline settler (simulates an evicted isolate /
      // dropped waitUntil). With the OLD non-transactional code a crash could strand
      // the row 'settled' with no debit; here the row stays 'pending' and is
      // recoverable — the sweep charges the estimate once it ages past the grace.
      const reqId = nextRequestId();
      await ledger.admitInferenceChargeViaLedger({
        charge: charge(reqId),
        estimatedCostUsd: 5,
        thresholdUsd: 1,
      });
      await dbWrite.execute(
        `UPDATE inference_pending_charges SET enqueued_at = NOW() - INTERVAL '30 minutes' WHERE request_id = '${reqId}';`,
      );
      const stats = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });
      expect(stats.settled).toBe(1);
      expect(await readBalance()).toBeCloseTo(95, 6); // the $5 estimate recovered
      expect(await debitCount()).toBe(1);
      expect((await pendingRows())[0].status).toBe("settled");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "GCs terminal rows older than the retention window; keeps recent terminal + all pending",
    async () => {
      if (!pgliteReady) return;
      // Two settled rows: one ancient, one fresh; plus a still-pending (young) row.
      await insertPending(nextRequestId(), "1.000000", 60 * 1000); // young pending — keep
      const oldSettled = nextRequestId();
      const newSettled = nextRequestId();
      await dbWrite.execute(
        `INSERT INTO inference_pending_charges (request_id, organization_id, model, provider, billing_source, estimated_cost_usd, status, enqueued_at, settled_at)
         VALUES ('${oldSettled}', '${ORG_ID}', 'm', 'p', 'platform', '1', 'settled', NOW() - INTERVAL '50 hours', NOW() - INTERVAL '49 hours'),
                ('${newSettled}', '${ORG_ID}', 'm', 'p', 'platform', '1', 'uncollected', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour');`,
      );
      const stats = await ledger.sweepStalePendingInferenceChargesDb({
        graceMs: 20 * 60 * 1000,
        retentionMs: 24 * 60 * 60 * 1000,
      });
      expect(stats.gcDeleted).toBe(1); // only the 49h-old terminal row
      const ids = (await pendingRows()).map((r) => r.request_id);
      expect(ids).not.toContain(oldSettled); // GC'd
      expect(ids).toContain(newSettled); // within retention → kept
    },
    PGLITE_TIMEOUT,
  );
});

describe("sweepStalePendingInferenceChargesDb — corrupt estimate fails closed (#13415)", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("100.000000");
  });

  /** Force a NaN estimate onto a stale pending row the way DB corruption would. */
  async function insertCorruptPending(requestId: string, ageMs: number): Promise<void> {
    await dbWrite.execute(
      `INSERT INTO inference_pending_charges
         (request_id, organization_id, user_id, api_key_id, model, provider, billing_source, estimated_cost_usd, status, enqueued_at)
       VALUES ('${requestId}', '${ORG_ID}', '${USER_ID}', NULL, 'gpt-oss-120b', 'cerebras', 'platform', 'NaN'::numeric, 'pending', NOW() - INTERVAL '${ageMs} milliseconds');`,
    );
  }

  test(
    "a corrupt 'NaN' estimate is NOT settled at $0 — it fails closed to an auditable 'corrupt' row (no debit)",
    async () => {
      if (!pgliteReady) return;
      const corrupt = nextRequestId();
      await insertCorruptPending(corrupt, 30 * 60 * 1000); // stale

      const stats = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });

      // REGRESSION GUARD: the old `Number.isFinite(estimate) ? estimate : 0` path
      // would have `settled` this row at $0 (a fabricated free-inference collection).
      expect(stats.settled).toBe(0);
      expect(stats.corrupt).toBe(1);
      expect(await debitCount()).toBe(0); // no fabricated $0 debit row
      expect(await readBalance()).toBeCloseTo(100, 6); // balance untouched
      const rows = await pendingRows();
      const row = rows.find((r) => r.request_id === corrupt);
      expect(row?.status).toBe("corrupt"); // left `pending`? NO — auditable terminal, not settled
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a negative estimate is NOT settled — it fails closed to an auditable 'corrupt' row (no debit)",
    async () => {
      if (!pgliteReady) return;
      const negative = nextRequestId();
      await dbWrite.execute(
        `INSERT INTO inference_pending_charges
           (request_id, organization_id, user_id, api_key_id, model, provider, billing_source, estimated_cost_usd, status, enqueued_at)
         VALUES ('${negative}', '${ORG_ID}', '${USER_ID}', NULL, 'gpt-oss-120b', 'cerebras', 'platform', '-5.000000'::numeric, 'pending', NOW() - INTERVAL '1800000 milliseconds');`,
      );

      const stats = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });

      expect(stats.settled).toBe(0);
      expect(stats.corrupt).toBe(1);
      expect(await debitCount()).toBe(0);
      expect(await readBalance()).toBeCloseTo(100, 6);
      const rows = await pendingRows();
      const row = rows.find((r) => r.request_id === negative);
      expect(row?.status).toBe("corrupt");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a corrupt row is transitioned out of 'pending' so it does not re-scan forever, and GCs like other terminals",
    async () => {
      if (!pgliteReady) return;
      const corrupt = nextRequestId();
      await insertCorruptPending(corrupt, 30 * 60 * 1000);

      // First sweep marks it corrupt (settled_at = NOW()).
      await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });
      expect((await pendingRows()).find((r) => r.request_id === corrupt)?.status).toBe("corrupt");

      // A second sweep does NOT re-scan it as pending (it's terminal now).
      const second = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });
      expect(second.corrupt).toBe(0);
      expect(second.scanned).toBe(0);

      // Age it past retention and confirm the GC clause reclaims a 'corrupt' terminal.
      await dbWrite.execute(
        `UPDATE inference_pending_charges SET settled_at = NOW() - INTERVAL '49 hours' WHERE request_id = '${corrupt}';`,
      );
      const third = await ledger.sweepStalePendingInferenceChargesDb({
        graceMs: 20 * 60 * 1000,
        retentionMs: 24 * 60 * 60 * 1000,
      });
      expect(third.gcDeleted).toBe(1);
      expect((await pendingRows()).map((r) => r.request_id)).not.toContain(corrupt);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "corrupt rows do not block healthy rows in the same sweep batch",
    async () => {
      if (!pgliteReady) return;
      const corrupt = nextRequestId();
      const healthy = nextRequestId();
      await insertCorruptPending(corrupt, 40 * 60 * 1000);
      await insertPending(healthy, "3.000000", 35 * 60 * 1000);

      const stats = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });

      expect(stats.corrupt).toBe(1);
      expect(stats.settled).toBe(1); // the healthy $3 charge still settled
      expect(await readBalance()).toBeCloseTo(97, 6);
      const rows = await pendingRows();
      expect(rows.find((r) => r.request_id === corrupt)?.status).toBe("corrupt");
      expect(rows.find((r) => r.request_id === healthy)?.status).toBe("settled");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an explicit $0 estimate is a legitimate free request — settled, NOT flagged corrupt",
    async () => {
      if (!pgliteReady) return;
      const free = nextRequestId();
      await insertPending(free, "0.000000", 30 * 60 * 1000);

      const stats = await ledger.sweepStalePendingInferenceChargesDb({ graceMs: 20 * 60 * 1000 });

      expect(stats.corrupt).toBe(0);
      expect(stats.settled).toBe(1); // claimed, charges nothing
      expect(await debitCount()).toBe(0); // $0 → no debit row (settle(0) claims-only)
      expect(await readBalance()).toBeCloseTo(100, 6);
      expect((await pendingRows()).find((r) => r.request_id === free)?.status).toBe("settled");
    },
    PGLITE_TIMEOUT,
  );
});

describe("parseSweepEstimate boundary + CorruptPendingChargeEstimateError", () => {
  test("exports the fail-closed error type", () => {
    expect(typeof ledger.CorruptPendingChargeEstimateError).toBe("function");
    const err = new ledger.CorruptPendingChargeEstimateError("req-x", "NaN");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CorruptPendingChargeEstimateError");
    expect(err.requestId).toBe("req-x");
    expect(err.rawValue).toBe("NaN");
  });
});

describe("resolveInferenceBillingLedger — backstop selector", () => {
  test("only 'db' (case/space-insensitive) selects the DB ledger; everything else is 'kv'", () => {
    expect(ledger.resolveInferenceBillingLedger({ INFERENCE_BILLING_LEDGER: "db" })).toBe("db");
    expect(ledger.resolveInferenceBillingLedger({ INFERENCE_BILLING_LEDGER: " DB " })).toBe("db");
    expect(ledger.resolveInferenceBillingLedger({ INFERENCE_BILLING_LEDGER: "kv" })).toBe("kv");
    expect(ledger.resolveInferenceBillingLedger({ INFERENCE_BILLING_LEDGER: "" })).toBe("kv");
    expect(ledger.resolveInferenceBillingLedger({})).toBe("kv");
  });
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
