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
 * The fix adds a SEPARATE recovery pass over stuck `processing` rows that
 * re-approves a row ONLY when it provably never broadcast a transaction
 * (`broadcast_tx_hash IS NULL`). The broadcast hash is persisted BEFORE the
 * transaction is broadcast (#10588: EVM signs locally then sends a raw tx; Solana
 * records the deterministic signature before the raw send) — so recovery can tell
 * "never broadcast" (safe to retry) from "broadcast, awaiting confirmation"
 * (must reconcile on-chain; re-broadcasting would DOUBLE-PAY). The previous flow
 * recorded the hash AFTER the broadcast, leaving a sub-second double-pay window.
 *
 * These tests run the REAL `PayoutProcessorService.processBatch` against
 * in-process PGlite. Only the chain clients (viem) and the RPC/env helpers are
 * stubbed — the DB selectors, the lock, the recovery SQL, the broadcast-hash
 * persistence, and the per-redemption try/catch all run for real, so each test
 * fails if the real logic regresses. Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realViem from "viem";
import * as realViemAccounts from "viem/accounts";
import * as realCloudBindings from "../../runtime/cloud-bindings";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const EVM_KEY = `0x${"1".repeat(64)}`;
const HOLDER_ADDRESS = `0x${"a".repeat(40)}`;
const FAIL_ADDRESS = "0x000000000000000000000000000000000000fa11";
const OK_ADDRESS = "0x0000000000000000000000000000000000000111";

// --- Chain client stubs (the only things that hit the network) ----------------
// #10588: executeEvmPayout now signs LOCALLY (prepare → sign → keccak256),
// persists the hash, and only THEN broadcasts (sendRawTransaction). The recipient
// is encoded in the signed calldata, so we decode it to let a test fail one
// specific payout. The broadcast hash is keccak256 of the (fixed, valid-hex)
// signed tx, computed with real viem so the DB value is deterministic.
const TRANSFER_ABI = realViem.parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const SIGNED_TX = `0x${"ab".repeat(120)}` as const;
const BROADCAST_HASH = realViem.keccak256(SIGNED_TX);

const prepareTxMock = mock(async (args: { data: `0x${string}` }) => ({ ...args, nonce: 0 }));
const signTxMock = mock(async () => SIGNED_TX);
const sendRawTxMock = mock(
  async (_args: { serializedTransaction: `0x${string}` }) => BROADCAST_HASH,
);
const waitReceiptMock = mock(async (_args: { hash: string }) => ({ status: "success" as const }));
const readContractMock = mock(async () => 10n ** 30n); // hot-wallet balance: always sufficient

/** Decode the ERC-20 transfer recipient from prepared calldata (real viem). */
function recipientOf(data: `0x${string}`): string {
  const decoded = realViem.decodeFunctionData({ abi: TRANSFER_ABI, data });
  return (decoded.args[0] as string).toLowerCase();
}

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
// from it) and override only the client factories so no RPC is hit.
mock.module("viem", () => ({
  ...realViem,
  createPublicClient: () => ({
    readContract: readContractMock,
    waitForTransactionReceipt: waitReceiptMock,
  }),
  createWalletClient: () => ({
    prepareTransactionRequest: prepareTxMock,
    signTransaction: signTxMock,
    sendRawTransaction: sendRawTxMock,
  }),
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
  network?: string;
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
        now() + interval '1 hour', '${opts.network ?? "base"}', '${opts.payoutAddress ?? OK_ADDRESS}', '${opts.status}',
        ${started}, ${broadcast}, '${opts.retryCount ?? 0}');`,
  );
  return id;
}

async function readRedemption(id: string): Promise<{
  status: string;
  failure_reason: string | null;
  broadcast_tx_hash: string | null;
  tx_hash: string | null;
  retry_count: string;
  processing_started_at: string | null;
  requires_review: boolean;
}> {
  const rows = await dbWrite.execute(
    `SELECT status, failure_reason, broadcast_tx_hash, tx_hash, retry_count, processing_started_at, requires_review
     FROM token_redemptions WHERE id = '${id}';`,
  );
  return rows.rows[0] as {
    status: string;
    failure_reason: string | null;
    broadcast_tx_hash: string | null;
    tx_hash: string | null;
    retry_count: string;
    processing_started_at: string | null;
    requires_review: boolean;
  };
}

/** Read the redeeming user's earnings balances via the redemption's user_id. */
async function readEarnings(
  redemptionId: string,
): Promise<{ available_balance: number; total_pending: number }> {
  const r = await dbWrite.execute(
    `SELECT re.available_balance, re.total_pending
       FROM redeemable_earnings re
       JOIN token_redemptions tr ON tr.user_id = re.user_id
      WHERE tr.id = '${redemptionId}';`,
  );
  const row = r.rows[0] as { available_balance: string; total_pending: string };
  return {
    available_balance: Number(row.available_balance),
    total_pending: Number(row.total_pending),
  };
}

/** Count refund ledger entries for a redemption (idempotency assertion). */
async function refundLedgerCount(redemptionId: string): Promise<number> {
  const r = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM redeemable_earnings_ledger
      WHERE redemption_id = '${redemptionId}' AND entry_type = 'refund';`,
  );
  return (r.rows[0] as { n: number }).n;
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
        asset text NOT NULL DEFAULT 'usdc',
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

  prepareTxMock.mockReset();
  signTxMock.mockReset();
  sendRawTxMock.mockReset();
  waitReceiptMock.mockReset();
  readContractMock.mockReset();
  sendAlertMock.mockReset();
  prepareTxMock.mockImplementation(async (args: { data: `0x${string}` }) => ({
    ...args,
    nonce: 0,
  }));
  signTxMock.mockImplementation(async () => SIGNED_TX);
  sendRawTxMock.mockImplementation(async () => BROADCAST_HASH);
  waitReceiptMock.mockImplementation(async () => ({ status: "success" as const }));
  readContractMock.mockImplementation(async () => 10n ** 30n);
  sendAlertMock.mockImplementation(async () => undefined);
});

describe("payout stale-lock recovery (#10553)", () => {
  test(
    "(a) a stale 'processing' row with NO broadcast hash is recovered, re-approved, and paid out",
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
      // It started in 'processing' (NOT selectable by the approved-select), so
      // reaching 'completed' proves recovery re-approved it and the batch then
      // paid it out.
      expect(row.status).toBe("completed");
      expect(row.tx_hash).toBe(BROADCAST_HASH);
      expect(row.broadcast_tx_hash).toBe(BROADCAST_HASH);
      // recovery incremented retry_count on the way back to 'approved'.
      expect(Number(row.retry_count)).toBe(1);
      // A real transaction was broadcast exactly once.
      expect(sendRawTxMock.mock.calls.length).toBe(1);
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
      expect(sendRawTxMock.mock.calls.length).toBe(0);
      // It is surfaced for on-chain reconciliation.
      expect(sendAlertMock.mock.calls.length).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(b2) #10628: stale Solana rows without a broadcast hash are escalated, not re-approved",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "processing",
        network: "solana",
        broadcastTxHash: null,
        startedMinutesAgo: 10,
        retryCount: 0,
      });

      const stats = await service.processBatch();

      const row = await readRedemption(id);
      expect(stats.processed).toBe(0);
      expect(row.status).toBe("failed");
      expect(row.broadcast_tx_hash).toBeNull();
      expect(row.tx_hash).toBeNull();
      expect(Number(row.retry_count)).toBe(1);
      expect(row.processing_started_at).toBeNull();
      expect(row.requires_review).toBe(true);
      expect(row.failure_reason).toContain("Solana stale processing lock");
      expect(sendRawTxMock.mock.calls.length).toBe(0);
      expect(sendAlertMock.mock.calls.length).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(c) a throw in one redemption does not abort the batch",
    async () => {
      if (!pgliteReady) return;
      // r1 throws at PREPARE (before signing/recording/sending — genuinely
      // pre-broadcast); r2 must still pay out.
      const r1 = await seedRedemption({ status: "approved", payoutAddress: FAIL_ADDRESS });
      const r2 = await seedRedemption({ status: "approved", payoutAddress: OK_ADDRESS });

      prepareTxMock.mockImplementation(async (args: { data: `0x${string}` }) => {
        if (recipientOf(args.data) === FAIL_ADDRESS.toLowerCase()) {
          throw new Error("RPC connection reset");
        }
        return { ...args, nonce: 0 };
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
      expect(row2.tx_hash).toBe(BROADCAST_HASH);
      expect(stats.processed).toBe(2);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(d) the tx hash is persisted BEFORE broadcast; an eviction during confirm leaves it for reconciliation",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({ status: "approved" });

      // Simulate a worker eviction / RPC failure DURING the confirmation wait,
      // i.e. AFTER the transaction was already broadcast.
      waitReceiptMock.mockImplementation(async () => {
        throw new Error("worker evicted while awaiting receipt");
      });

      await service.processBatch();

      const row = await readRedemption(id);
      // The broadcast hash was persisted before the raw send, so it is set even
      // though confirmation threw.
      expect(row.broadcast_tx_hash).toBe(BROADCAST_HASH);
      // It never confirmed, so it is not completed and not re-approved — it is
      // left in 'processing' for on-chain reconciliation (never re-broadcast).
      expect(row.tx_hash).toBeNull();
      expect(row.status).toBe("processing");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(d2) #10588: the broadcast hash is persisted BEFORE the raw send (window closed)",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({ status: "approved" });

      // Capture the DB state at the EXACT moment the raw transaction is sent. If
      // the hash is already persisted then, a worker death anywhere in the
      // broadcast→persist gap can never leave a NULL-hash row that recovery would
      // re-broadcast → the double-pay window is closed.
      let hashAtSendTime: string | null | "UNSET" = "UNSET";
      sendRawTxMock.mockImplementation(async () => {
        hashAtSendTime = (await readRedemption(id)).broadcast_tx_hash;
        return BROADCAST_HASH;
      });

      await service.processBatch();

      // The hash was already committed when sendRawTransaction ran (not after it).
      expect(hashAtSendTime).toBe(BROADCAST_HASH);
      const row = await readRedemption(id);
      expect(row.status).toBe("completed");
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
      expect(sendRawTxMock.mock.calls.length).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(f) a provably-safe stale row with retries exhausted is failed for manual intervention",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: null,
        startedMinutesAgo: 10,
        retryCount: 3, // == MAX_RETRY_ATTEMPTS
      });

      await service.processBatch();

      const row = await readRedemption(id);
      expect(row.status).toBe("failed");
      expect(row.broadcast_tx_hash).toBeNull();
      expect(row.requires_review).toBe(true);
      // Never silently re-broadcast.
      expect(sendRawTxMock.mock.calls.length).toBe(0);
      expect(sendAlertMock.mock.calls.length).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(f2) #10628: stale-lock recovery fails the row when its recovery strike reaches the retry ceiling",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: null,
        startedMinutesAgo: 10,
        retryCount: 2, // recovery strike reaches MAX_RETRY_ATTEMPTS (3)
      });

      const stats = await service.processBatch();

      const row = await readRedemption(id);
      expect(stats.processed).toBe(0);
      expect(row.status).toBe("failed");
      expect(Number(row.retry_count)).toBe(3);
      expect(row.broadcast_tx_hash).toBeNull();
      expect(row.processing_started_at).toBeNull();
      expect(row.requires_review).toBe(true);
      expect(sendRawTxMock.mock.calls.length).toBe(0);
      expect(sendAlertMock.mock.calls.length).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(g) #10628: final retryable failure is failed, not orphaned as unselectable approved",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "approved",
        retryCount: 2, // next retry reaches MAX_RETRY_ATTEMPTS (3)
        payoutAddress: FAIL_ADDRESS,
      });

      prepareTxMock.mockImplementation(async (args: { data: `0x${string}` }) => {
        if (recipientOf(args.data) === FAIL_ADDRESS.toLowerCase()) {
          throw new Error("RPC connection reset before broadcast");
        }
        return { ...args, nonce: 0 };
      });

      const stats = await service.processBatch();

      const row = await readRedemption(id);
      expect(stats.failed).toBe(1);
      expect(row.status).toBe("failed");
      expect(Number(row.retry_count)).toBe(3);
      expect(row.requires_review).toBe(true);
      expect(row.processing_started_at).toBeNull();
      expect(row.broadcast_tx_hash).toBeNull();
      expect(sendRawTxMock.mock.calls.length).toBe(0);
      expect(sendAlertMock.mock.calls.length).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(h) final retryable failure does not overwrite a row no longer processing",
    async () => {
      if (!pgliteReady) return;
      const id = await seedRedemption({
        status: "approved",
        retryCount: 2,
      });

      readContractMock.mockImplementation(async () => {
        await dbWrite.execute(
          `UPDATE token_redemptions
           SET status = 'completed',
               tx_hash = '${BROADCAST_HASH}',
               broadcast_tx_hash = '${BROADCAST_HASH}',
               processing_started_at = NULL
           WHERE id = '${id}';`,
        );
        return 0n;
      });

      const stats = await service.processBatch();

      const row = await readRedemption(id);
      expect(stats.failed).toBe(1);
      expect(row.status).toBe("completed");
      expect(row.tx_hash).toBe(BROADCAST_HASH);
      expect(row.broadcast_tx_hash).toBe(BROADCAST_HASH);
      expect(Number(row.retry_count)).toBe(2);
      expect(row.requires_review).toBe(false);
      expect(sendRawTxMock.mock.calls.length).toBe(0);
      expect(sendAlertMock.mock.calls.length).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(g) a retries-exhausted redemption returns its locked earnings to available_balance exactly once",
    async () => {
      if (!pgliteReady) return;
      // Seeded: total_pending=10 (locked), available_balance=90, usd_value=10.
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: null,
        startedMinutesAgo: 10,
        retryCount: 3, // == MAX_RETRY_ATTEMPTS → recovery marks it 'failed'
      });

      const before = await readEarnings(id);
      expect(before.available_balance).toBeCloseTo(90, 4);
      expect(before.total_pending).toBeCloseTo(10, 4);

      await service.processBatch();

      const row = await readRedemption(id);
      expect(row.status).toBe("failed");
      expect(row.broadcast_tx_hash).toBeNull();

      // The $10 was returned from total_pending to available_balance (previously
      // stranded forever — rejectRedemption only touches 'pending' rows).
      const after = await readEarnings(id);
      expect(after.available_balance).toBeCloseTo(100, 4);
      expect(after.total_pending).toBeCloseTo(0, 4);
      expect(await refundLedgerCount(id)).toBe(1);

      // Idempotent: a second batch does NOT refund again (ledger guard).
      await service.processBatch();
      const after2 = await readEarnings(id);
      expect(after2.available_balance).toBeCloseTo(100, 4);
      expect(await refundLedgerCount(id)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "(h) a broadcast-but-unconfirmed row is NEVER refunded (reverse-double-pay guard)",
    async () => {
      if (!pgliteReady) return;
      // A stale row WITH a broadcast hash: tokens may be on-chain, so it must be
      // routed to reconciliation (left 'processing'), never failed+refunded —
      // refunding available_balance while tokens went out would be a reverse
      // double-pay.
      const id = await seedRedemption({
        status: "processing",
        broadcastTxHash: `0x${"d".repeat(64)}`,
        startedMinutesAgo: 10,
        retryCount: 0,
      });

      const before = await readEarnings(id);
      await service.processBatch();

      const row = await readRedemption(id);
      // Not failed (reconciliation path), and crucially NOT refunded.
      expect(row.status).toBe("processing");
      const after = await readEarnings(id);
      expect(after.available_balance).toBeCloseTo(before.available_balance, 4);
      expect(after.total_pending).toBeCloseTo(before.total_pending, 4);
      expect(await refundLedgerCount(id)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
