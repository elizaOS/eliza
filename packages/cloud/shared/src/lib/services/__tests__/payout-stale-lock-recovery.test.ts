/**
 * Real-DB coverage for payout stale-lock recovery + the no-double-pay invariant
 * (issue #10553).
 *
 * The bug: `processBatch` only selected `status='approved'` rows, but a worker
 * that died mid-payout leaves the row in `status='processing'` forever — never
 * re-selected, funds locked, no retry. The "recovery" clause that was supposed
 * to catch this (`processing_started_at < now-LOCK_TIMEOUT`) was ANDed with
 * `status='approved'`, and approved rows always have a NULL
 * `processing_started_at`, so it was unreachable dead code.
 *
 * The fix adds a SEPARATE recovery pass over stuck `processing` rows. A row that
 * already broadcast a transaction (`broadcast_tx_hash IS NOT NULL`) is surfaced
 * for on-chain reconciliation, never re-broadcast.
 *
 * #10588 hardening: a row with NO recorded broadcast (`broadcast_tx_hash IS NULL`)
 * is NO LONGER auto-re-approved for retry. A null hash does not prove the tx was
 * never broadcast — a worker can die between broadcasting the transaction and
 * persisting its hash — so re-approving would re-broadcast and DOUBLE-PAY. Such
 * rows are now escalated to `failed` + `requires_review` for human / on-chain
 * verification instead.
 *
 * These tests run the REAL `PayoutProcessorService.processBatch` against
 * in-process PGlite. Only the chain clients (viem) and the RPC/env helpers are
 * stubbed — the DB selectors, the lock, the recovery SQL, the broadcast-hash
 * persistence, and the per-redemption try/catch all run for real, so each test
 * fails if the real logic regresses. Self-skips if PGlite is unavailable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realViem from "viem";
import * as realViemAccounts from "viem/accounts";
import * as realCloudBindings from "../../runtime/cloud-bindings";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const EVM_KEY = `0x${"1".repeat(64)}`;
const HOLDER_ADDRESS = `0x${"a".repeat(40)}`;
const FAIL_ADDRESS = "0x000000000000000000000000000000000000fa11";
const OK_ADDRESS = "0x0000000000000000000000000000000000000111";

// --- Chain client stubs (the only things that hit the network) ----------------
const writeContractMock = mock(async (_args: { args: [string, bigint] }) => `0x${"b".repeat(64)}`);
const waitReceiptMock = mock(async (_args: { hash: string }) => ({ status: "success" as const }));
const readContractMock = mock(async () => 10n ** 30n); // hot-wallet balance: always sufficient

// Keep the real env (so the db client still resolves DATABASE_URL=pglite://memory)
// and only inject the EVM hot-wallet key. Solana stays unconfigured.
mock.module("../../runtime/cloud-bindings", () => ({
  ...realCloudBindings,
  getCloudAwareEnv: () => ({ ...process.env, EVM_PAYOUT_PRIVATE_KEY: EVM_KEY }),
}));

mock.module("../../config/evm-rpc", () => ({
  resolveEvmRpc: () => ({ source: "test", url: "https://rpc.test.invalid" }),
}));

// Spread the real viem module (token-constants pulls parseAbi, parseUnits, …
// from it) and override only the two client factories so no RPC is hit.
mock.module("viem", () => ({
  ...realViem,
  createPublicClient: () => ({
    readContract: readContractMock,
    waitForTransactionReceipt: waitReceiptMock,
  }),
  createWalletClient: () => ({ writeContract: writeContractMock }),
}));

mock.module("viem/accounts", () => ({
  ...realViemAccounts,
  privateKeyToAccount: () => ({ address: HOLDER_ADDRESS }),
}));

const sendAlertMock = mock(async () => undefined);
mock.module("../payout-alerts", () => ({
  payoutAlertsService: {
    sendAlert: sendAlertMock,
    alertLowBalance: mock(async () => undefined),
  },
}));

const PGLITE_TIMEOUT = 60000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let PayoutProcessorService: typeof import("../payout-processor").PayoutProcessorService;
let service: InstanceType<typeof import("../payout-processor").PayoutProcessorService>;
let pgliteReady = true;

interface SeedOpts {
  status: string;
  broadcastTxHash?: string | null;
  retryCount?: number;
  /** processing_started_at, expressed as minutes in the PAST (undefined → NULL). */
  startedMinutesAgo?: number;
  payoutAddress?: string;
}

async function seedUserAndEarnings(userId: string): Promise<void> {
  await dbWrite.execute(
    `INSERT INTO redeemable_earnings (user_id, total_earned, total_redeemed, total_pending, available_balance)
     VALUES ('${userId}', '100.0000', '0.0000', '10.0000', '90.0000')
     ON CONFLICT DO NOTHING;`,
  );
}

async function seedRedemption(opts: SeedOpts): Promise<string> {
  const id = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await seedUserAndEarnings(userId);

  const started =
    opts.startedMinutesAgo === undefined
      ? "NULL"
      : `now() - interval '${opts.startedMinutesAgo} minutes'`;
  const broadcast =
    opts.broadcastTxHash === undefined || opts.broadcastTxHash === null
      ? "NULL"
      : `'${opts.broadcastTxHash}'`;

  await dbWrite.execute(
    `INSERT INTO token_redemptions
       (id, user_id, points_amount, usd_value, eliza_price_usd, eliza_amount,
        price_quote_expires_at, network, payout_address, status,
        processing_started_at, broadcast_tx_hash, retry_count)
     VALUES
       ('${id}', '${userId}', '1000.00', '10.0000', '0.10000000', '100.00000000',
        now() + interval '1 hour', 'base', '${opts.payoutAddress ?? OK_ADDRESS}', '${opts.status}',
        ${started}, ${broadcast}, '${opts.retryCount ?? 0}');`,
  );
  return id;
}

async function readRedemption(id: string): Promise<{
  status: string;
  broadcast_tx_hash: string | null;
  tx_hash: string | null;
  retry_count: string;
  processing_started_at: string | null;
  requires_review: number;
}> {
  const rows = await dbWrite.execute(
    `SELECT status, broadcast_tx_hash, tx_hash, retry_count, processing_started_at,
            (requires_review)::int AS requires_review
     FROM token_redemptions WHERE id = '${id}';`,
  );
  return rows.rows[0] as {
    status: string;
    broadcast_tx_hash: string | null;
    tx_hash: string | null;
    retry_count: string;
    processing_started_at: string | null;
    requires_review: number;
  };
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ PayoutProcessorService } = await import("../payout-processor"));

    const ddl = [
      `CREATE TABLE IF NOT EXISTS token_redemptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        app_id uuid,
        points_amount numeric(12,2) NOT NULL DEFAULT '0',
        usd_value numeric(12,4) NOT NULL DEFAULT '0',
        eliza_price_usd numeric(18,8) NOT NULL DEFAULT '0',
        eliza_amount numeric(24,8) NOT NULL DEFAULT '0',
        price_quote_expires_at timestamp NOT NULL DEFAULT now(),
        network text NOT NULL DEFAULT 'base',
        payout_address text NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
        address_signature text,
        status text NOT NULL DEFAULT 'pending',
        processing_started_at timestamp,
        processing_worker_id text,
        broadcast_tx_hash text,
        tx_hash text,
        completed_at timestamp,
        failure_reason text,
        retry_count numeric(3,0) NOT NULL DEFAULT '0',
        requires_review boolean NOT NULL DEFAULT false,
        reviewed_by uuid,
        reviewed_at timestamp,
        review_notes text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      // Full column set: markCompleted's UPDATE ... RETURNING maps the entire
      // redeemableEarnings schema, so every mapped column must exist.
      `CREATE TABLE IF NOT EXISTS redeemable_earnings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE,
        total_earned numeric(18,4) NOT NULL DEFAULT '0',
        total_redeemed numeric(18,4) NOT NULL DEFAULT '0',
        total_pending numeric(18,4) NOT NULL DEFAULT '0',
        available_balance numeric(18,4) NOT NULL DEFAULT '0',
        earned_from_miniapps numeric(18,4) NOT NULL DEFAULT '0',
        earned_from_agents numeric(18,4) NOT NULL DEFAULT '0',
        earned_from_mcps numeric(18,4) NOT NULL DEFAULT '0',
        earned_from_affiliates numeric(18,4) NOT NULL DEFAULT '0',
        earned_from_app_owner_shares numeric(18,4) NOT NULL DEFAULT '0',
        earned_from_creator_shares numeric(18,4) NOT NULL DEFAULT '0',
        total_converted_to_credits numeric(18,4) NOT NULL DEFAULT '0',
        last_earning_at timestamp,
        last_redemption_at timestamp,
        version numeric(10,0) NOT NULL DEFAULT '0',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS redeemable_earnings_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        entry_type text NOT NULL,
        amount numeric(18,4) NOT NULL,
        balance_after numeric(18,4) NOT NULL,
        earnings_source text,
        source_id uuid,
        redemption_id uuid,
        description text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now()
      )`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
    service = new PayoutProcessorService();
  } catch (error) {
    pgliteReady = false;
    console.warn("[payout-stale-lock-recovery] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

beforeEach(async () => {
  if (!pgliteReady) return;
  await dbWrite.execute(`DELETE FROM token_redemptions;`);
  await dbWrite.execute(`DELETE FROM redeemable_earnings_ledger;`);
  await dbWrite.execute(`DELETE FROM redeemable_earnings;`);

  writeContractMock.mockReset();
  waitReceiptMock.mockReset();
  readContractMock.mockReset();
  sendAlertMock.mockReset();
  writeContractMock.mockImplementation(async () => `0x${"b".repeat(64)}`);
  waitReceiptMock.mockImplementation(async () => ({ status: "success" as const }));
  readContractMock.mockImplementation(async () => 10n ** 30n);
  sendAlertMock.mockImplementation(async () => undefined);
});

describe("payout stale-lock recovery (#10553)", () => {
  test(
    "(a) a stale 'processing' row with NO recorded broadcast is escalated for review, NOT auto-re-paid (double-pay guard, #10588)",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: null,
        startedMinutesAgo: 10, // > 5min LOCK_TIMEOUT → stale
        retryCount: 0,
      });

      await service.processBatch();

      const row = await readRedemption(id);
      // A null broadcast hash does NOT prove the tx was never broadcast — the
      // worker may have died between broadcasting and persisting the hash. So
      // recovery must never auto-re-pay it (that would re-broadcast and
      // double-pay); it is surfaced for human / on-chain review instead.
      expect(row.status).toBe("failed");
      expect(Number(row.requires_review)).toBe(1);
      expect(row.broadcast_tx_hash).toBeNull();
      expect(row.tx_hash).toBeNull();
      // The load-bearing assertion: NO transaction was (re-)broadcast.
      expect(writeContractMock.mock.calls.length).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(b) a stale 'processing' row WITH a broadcast hash is NOT re-approved (no double-pay)",
    async () => {
      if (!pgliteReady) return;
      const broadcastHash = `0x${"d".repeat(64)}`;
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: broadcastHash,
        startedMinutesAgo: 10,
        retryCount: 0,
      });

      await service.processBatch();

      const row = await readRedemption(id);
      // Left exactly as-is — recovery must never touch a broadcast row.
      expect(row.status).toBe("processing");
      expect(row.broadcast_tx_hash).toBe(broadcastHash);
      expect(row.tx_hash).toBeNull();
      // The load-bearing assertion: NO new transaction was broadcast.
      expect(writeContractMock.mock.calls.length).toBe(0);
      // It is surfaced for on-chain reconciliation.
      expect(sendAlertMock.mock.calls.length).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(c) a throw in one redemption does not abort the batch",
    async () => {
      if (!pgliteReady) return;
      // r1 will throw at broadcast (before any tx is sent); r2 must still pay out.
      const r1 = await seedRedemption({ status: "approved", payoutAddress: FAIL_ADDRESS });
      const r2 = await seedRedemption({ status: "approved", payoutAddress: OK_ADDRESS });

      writeContractMock.mockImplementation(async (call: { args: [string, bigint] }) => {
        if (call.args[0] === FAIL_ADDRESS) throw new Error("RPC connection reset");
        return `0x${"b".repeat(64)}`;
      });

      // Must not throw out of processBatch.
      const stats = await service.processBatch();

      const row1 = await readRedemption(r1);
      const row2 = await readRedemption(r2);
      // r1 threw BEFORE broadcast (no hash) → safe retryable failure → back to approved.
      expect(row1.status).toBe("approved");
      expect(row1.broadcast_tx_hash).toBeNull();
      expect(Number(row1.retry_count)).toBe(1);
      // r2 was reached despite r1 throwing → paid out.
      expect(row2.status).toBe("completed");
      expect(row2.tx_hash).toBe(`0x${"b".repeat(64)}`);
      expect(stats.processed).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(d) the tx hash is persisted at BROADCAST time, before confirmation",
    async () => {
      if (!pgliteReady) return;
      const broadcastHash = `0x${"e".repeat(64)}`;
      const id = await seedRedemption({ status: "approved" });

      writeContractMock.mockImplementation(async () => broadcastHash);
      // Simulate a worker eviction / RPC failure DURING the confirmation wait,
      // i.e. AFTER the transaction was already broadcast.
      waitReceiptMock.mockImplementation(async () => {
        throw new Error("worker evicted while awaiting receipt");
      });

      await service.processBatch();

      const row = await readRedemption(id);
      // The broadcast hash was persisted the moment writeContract returned,
      // BEFORE waitForTransactionReceipt threw.
      expect(row.broadcast_tx_hash).toBe(broadcastHash);
      // It never confirmed, so it is not completed and not re-approved — it is
      // left in 'processing' for on-chain reconciliation (never re-broadcast).
      expect(row.tx_hash).toBeNull();
      expect(row.status).toBe("processing");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(e) a FRESH 'processing' row (within LOCK_TIMEOUT) is left alone for the live worker",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: null,
        startedMinutesAgo: 1, // < 5min LOCK_TIMEOUT → a live worker may hold it
        retryCount: 0,
      });

      await service.processBatch();

      const row = await readRedemption(id);
      // Recovery must not steal a row from a worker still inside the timeout.
      expect(row.status).toBe("processing");
      expect(Number(row.retry_count)).toBe(0);
      expect(writeContractMock.mock.calls.length).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(f) a stale 'processing' row with no broadcast is escalated regardless of retry_count",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: null,
        startedMinutesAgo: 10,
        retryCount: 3, // recovery no longer keys off retry_count — all null-broadcast escalate
      });

      await service.processBatch();

      const row = await readRedemption(id);
      expect(row.status).toBe("failed");
      expect(Number(row.requires_review)).toBe(1);
      expect(row.broadcast_tx_hash).toBeNull();
      // Never silently re-broadcast.
      expect(writeContractMock.mock.calls.length).toBe(0);
    },
    PGLITE_TIMEOUT,
  );
});
