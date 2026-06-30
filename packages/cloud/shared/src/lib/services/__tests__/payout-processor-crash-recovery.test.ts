/**
 * Crash-recovery + no-double-pay tests for the payout processor (#10553).
 *
 * Before: a worker that died mid-payout left a redemption stuck in `processing`
 * forever — the only batch selector filtered on status='approved', and the
 * "recover stale lock" OR-clause was dead (no approved row ever carries a stale
 * lock). And executeEvmPayout did not wrap writeContract/waitForTransactionReceipt,
 * so a thrown RPC error aborted the whole batch with the row left locked.
 *
 * After: a separate stale-`processing` recovery path classifies each stuck row by
 * whether a transfer may already be on-chain (broadcast_tx_hash recorded, or any
 * interrupted Solana payout) and NEVER auto-retries those — only a provably
 * un-broadcast EVM lock is re-approved. The broadcast hash is persisted the moment
 * the transfer is submitted, BEFORE confirmation. These tests pin that safety.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const viemActual = require("viem") as Record<string, unknown>;
const cloudBindingsActual = await import("../../runtime/cloud-bindings");
const evmRpcActual = await import("../../config/evm-rpc");
const dbClientActual = await import("../../../db/client");
const payoutAlertsActual = await import("../payout-alerts");

// ---- module mocks (must be set before importing the service) ----
const getCloudAwareEnv = mock();
mock.module("../../runtime/cloud-bindings", () => ({ ...cloudBindingsActual, getCloudAwareEnv }));

const resolveEvmRpc = mock(() => ({ source: "test", url: "https://rpc.invalid.example" }));
mock.module("../../config/evm-rpc", () => ({ ...evmRpcActual, resolveEvmRpc }));

// Controllable viem clients. writeContract / waitForTransactionReceipt / readContract
// are driven per-test; http + parseUnits stay real.
const writeContract = mock();
const waitForTransactionReceipt = mock();
const readContract = mock(async () => 10n ** 30n); // hot wallet always funded
mock.module("viem", () => ({
  ...viemActual,
  createPublicClient: () => ({ readContract, waitForTransactionReceipt }),
  createWalletClient: () => ({ writeContract }),
}));
mock.module("viem/accounts", () => ({
  privateKeyToAccount: () => ({ address: "0x000000000000000000000000000000000000dEaD" }),
}));

// DB mock: a thenable chain whose terminal awaits consume a results queue in call
// order. `.set()` payloads are captured for assertions.
function makeDb() {
  const queue: unknown[][] = [];
  const setArgs: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable — emulates drizzle's awaitable query builder so `await db.select()...` resolves to the queued result.
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.length ? queue.shift() : []).then(resolve, reject),
  };
  for (const m of [
    "select",
    "from",
    "where",
    "limit",
    "update",
    "insert",
    "values",
    "returning",
    "delete",
    "orderBy",
  ]) {
    chain[m] = mock(() => chain);
  }
  chain.set = mock((payload: Record<string, unknown>) => {
    setArgs.push(payload);
    return chain;
  });
  chain.transaction = mock(async (fn: (tx: unknown) => unknown) => fn(chain));
  return {
    chain,
    enqueue: (r: unknown[]) => queue.push(r),
    setArgs,
    reset: () => {
      queue.length = 0;
      setArgs.length = 0;
    },
  };
}

// One STABLE db/chain for the whole file — the processor's ESM import snapshots
// the chain, so we reset its queue/setArgs in place between tests rather than
// reassigning `db` (which the import would never see).
const db = makeDb();
mock.module("../../../db/client", () => ({
  ...dbClientActual,
  dbRead: db.chain,
  dbWrite: db.chain,
}));

const sendAlert = mock(async () => undefined);
mock.module("../payout-alerts", () => ({
  ...payoutAlertsActual,
  payoutAlertsService: { sendAlert },
}));

const { classifyStaleProcessingLock, PayoutProcessorService } = await import("../payout-processor");

afterAll(() => {
  mock.module("viem", () => viemActual);
});

const EVM_KEY = `0x${"1".repeat(64)}`;

function evmRedemption(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    network: "base",
    payout_address: "0x000000000000000000000000000000000000bEEF",
    eliza_amount: "100",
    price_quote_expires_at: new Date(Date.now() + 60_000),
    eliza_price_usd: "0.01",
    usd_value: "1.00",
    user_id: "22222222-2222-4222-8222-222222222222",
    broadcast_tx_hash: null,
    ...over,
  } as never;
}

beforeEach(() => {
  db.reset();
  getCloudAwareEnv.mockReset();
  getCloudAwareEnv.mockReturnValue({ EVM_PAYOUT_PRIVATE_KEY: EVM_KEY });
  writeContract.mockReset();
  waitForTransactionReceipt.mockReset();
  readContract.mockReset();
  readContract.mockResolvedValue(10n ** 30n);
  resolveEvmRpc.mockReturnValue({ source: "test", url: "https://rpc.invalid.example" });
  sendAlert.mockReset();
  sendAlert.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. The pure safety classifier — the no-double-pay decision, exhaustive.
// ---------------------------------------------------------------------------
describe("classifyStaleProcessingLock — never re-approves a possibly-broadcast row", () => {
  for (const network of ["ethereum", "base", "bnb"]) {
    test(`${network} with NO broadcast hash → reapprove (worker died before submitting)`, () => {
      const r = classifyStaleProcessingLock({ network, broadcast_tx_hash: null });
      expect(r.action).toBe("reapprove");
    });
    test(`${network} WITH a broadcast hash → reconcile (may be in-flight, never re-broadcast)`, () => {
      const r = classifyStaleProcessingLock({ network, broadcast_tx_hash: "0xdeadbeef" });
      expect(r.action).toBe("reconcile");
    });
  }

  test("solana with NO broadcast hash → reconcile (atomic send+confirm can't be proven un-sent)", () => {
    const r = classifyStaleProcessingLock({ network: "solana", broadcast_tx_hash: null });
    expect(r.action).toBe("reconcile");
  });
  test("solana WITH a broadcast hash → reconcile", () => {
    const r = classifyStaleProcessingLock({ network: "solana", broadcast_tx_hash: "sig123" });
    expect(r.action).toBe("reconcile");
  });
});

// ---------------------------------------------------------------------------
// 2. executeEvmPayout — persist hash BEFORE confirm; route every failure safely.
// ---------------------------------------------------------------------------
describe("executeEvmPayout — broadcast hash persisted before confirmation", () => {
  test("success: records broadcast hash BEFORE awaiting the receipt, then completes", async () => {
    const svc = new PayoutProcessorService();
    const order: string[] = [];
    const recordSpy = spyOn(
      svc as unknown as { recordBroadcastTxHash: (id: string, h: string) => Promise<void> },
      "recordBroadcastTxHash",
    ).mockImplementation(async () => {
      order.push("record");
    });
    writeContract.mockImplementation(async () => {
      order.push("broadcast");
      return "0xabc123";
    });
    waitForTransactionReceipt.mockImplementation(async () => {
      order.push("confirm");
      return { status: "success" };
    });

    const result = await (
      svc as unknown as {
        executeEvmPayout: (r: never, n: string) => Promise<{ success: boolean; txHash?: string }>;
      }
    ).executeEvmPayout(evmRedemption(), "base");

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xabc123");
    // The hash MUST be persisted between broadcast and confirmation.
    expect(order).toEqual(["broadcast", "record", "confirm"]);
    expect(recordSpy).toHaveBeenCalledWith(evmRedemption().id, "0xabc123");
  });

  test("writeContract throws (never submitted) → retryable, no hash recorded", async () => {
    const svc = new PayoutProcessorService();
    const recordSpy = spyOn(
      svc as unknown as { recordBroadcastTxHash: () => Promise<void> },
      "recordBroadcastTxHash",
    ).mockResolvedValue(undefined);
    writeContract.mockRejectedValue(new Error("nonce too low"));

    const result = await (
      svc as unknown as {
        executeEvmPayout: (
          r: never,
          n: string,
        ) => Promise<{ success: boolean; retryable?: boolean; needsReconciliation?: boolean }>;
      }
    ).executeEvmPayout(evmRedemption(), "base");

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.needsReconciliation).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  test("hash persistence fails AFTER broadcast → needsReconciliation (never retry)", async () => {
    const svc = new PayoutProcessorService();
    spyOn(
      svc as unknown as { recordBroadcastTxHash: () => Promise<void> },
      "recordBroadcastTxHash",
    ).mockRejectedValue(new Error("db down"));
    writeContract.mockResolvedValue("0xLIVE");

    const result = await (
      svc as unknown as {
        executeEvmPayout: (
          r: never,
          n: string,
        ) => Promise<{
          success: boolean;
          retryable?: boolean;
          needsReconciliation?: boolean;
          txHash?: string;
        }>;
      }
    ).executeEvmPayout(evmRedemption(), "base");

    expect(result.success).toBe(false);
    expect(result.needsReconciliation).toBe(true);
    expect(result.retryable).toBeUndefined();
    expect(result.txHash).toBe("0xLIVE");
    // The tx is live — we must NOT wait/confirm-then-retry; reconcile instead.
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  test("waitForTransactionReceipt throws (broadcast, unconfirmed) → needsReconciliation", async () => {
    const svc = new PayoutProcessorService();
    spyOn(
      svc as unknown as { recordBroadcastTxHash: () => Promise<void> },
      "recordBroadcastTxHash",
    ).mockResolvedValue(undefined);
    writeContract.mockResolvedValue("0xLIVE2");
    waitForTransactionReceipt.mockRejectedValue(new Error("rpc timeout"));

    const result = await (
      svc as unknown as {
        executeEvmPayout: (
          r: never,
          n: string,
        ) => Promise<{
          success: boolean;
          retryable?: boolean;
          needsReconciliation?: boolean;
          txHash?: string;
        }>;
      }
    ).executeEvmPayout(evmRedemption(), "base");

    expect(result.success).toBe(false);
    expect(result.needsReconciliation).toBe(true);
    expect(result.retryable).toBeUndefined();
    expect(result.txHash).toBe("0xLIVE2");
  });

  test("reverted transfer (moved nothing) → retryable", async () => {
    const svc = new PayoutProcessorService();
    spyOn(
      svc as unknown as { recordBroadcastTxHash: () => Promise<void> },
      "recordBroadcastTxHash",
    ).mockResolvedValue(undefined);
    writeContract.mockResolvedValue("0xREVERT");
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });

    const result = await (
      svc as unknown as {
        executeEvmPayout: (
          r: never,
          n: string,
        ) => Promise<{ success: boolean; retryable?: boolean; needsReconciliation?: boolean }>;
      }
    ).executeEvmPayout(evmRedemption(), "base");

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.needsReconciliation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. recoverStaleLocks — routes each stuck row to the safe action.
// ---------------------------------------------------------------------------
describe("recoverStaleLocks — re-approves only provably un-broadcast EVM locks", () => {
  const config = {
    LOCK_TIMEOUT_MS: 5 * 60 * 1000,
    BATCH_SIZE: 10,
    MAX_RETRY_ATTEMPTS: 3,
    WORKER_ID: "test",
  } as never;

  test("stale EVM lock with no broadcast hash → re-approved", async () => {
    const svc = new PayoutProcessorService();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    db.enqueue([
      { id: "r1", network: "base", broadcast_tx_hash: null, processing_started_at: old },
    ]); // select
    db.enqueue([{ id: "r1" }]); // reapprove .returning() → truthy

    await (svc as unknown as { recoverStaleLocks: (c: never) => Promise<void> }).recoverStaleLocks(
      config,
    );

    expect(db.setArgs.length).toBe(1);
    expect(db.setArgs[0].status).toBe("approved");
    expect(db.setArgs[0].processing_started_at).toBeNull();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  test("stale lock WITH a broadcast hash → parked failed + requires_review + alert", async () => {
    const svc = new PayoutProcessorService();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    db.enqueue([
      {
        id: "r2",
        network: "base",
        broadcast_tx_hash: "0xINFLIGHT",
        processing_started_at: old,
        payout_address: "0xbEEF",
        eliza_amount: "5",
      },
    ]); // select
    db.enqueue([{ id: "r2" }]); // parked .returning() → truthy

    await (svc as unknown as { recoverStaleLocks: (c: never) => Promise<void> }).recoverStaleLocks(
      config,
    );

    expect(db.setArgs.length).toBe(1);
    expect(db.setArgs[0].status).toBe("failed");
    expect(db.setArgs[0].requires_review).toBe(true);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  test("stale Solana lock with no hash → parked for reconciliation (never re-approved)", async () => {
    const svc = new PayoutProcessorService();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    db.enqueue([
      {
        id: "r3",
        network: "solana",
        broadcast_tx_hash: null,
        processing_started_at: old,
        eliza_amount: "5",
        payout_address: "sol",
      },
    ]);
    db.enqueue([{ id: "r3" }]);

    await (svc as unknown as { recoverStaleLocks: (c: never) => Promise<void> }).recoverStaleLocks(
      config,
    );

    expect(db.setArgs[0].status).toBe("failed");
    expect(db.setArgs[0].requires_review).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. processBatch — one throwing redemption never aborts the batch.
// ---------------------------------------------------------------------------
describe("processBatch — a throwing redemption is isolated", () => {
  test("a mid-batch throw is caught; the remaining rows still process", async () => {
    const svc = new PayoutProcessorService();
    spyOn(
      svc as unknown as { recoverStaleLocks: () => Promise<void> },
      "recoverStaleLocks",
    ).mockResolvedValue(undefined);
    spyOn(
      svc as unknown as { acquireLock: () => Promise<boolean> },
      "acquireLock",
    ).mockResolvedValue(true);
    const completed: string[] = [];
    spyOn(
      svc as unknown as { markCompleted: (r: { id: string }) => Promise<void> },
      "markCompleted",
    ).mockImplementation(async (r) => {
      completed.push(r.id);
    });
    spyOn(
      svc as unknown as { processRedemption: (r: { id: string }) => Promise<unknown> },
      "processRedemption",
    ).mockImplementation(async (r) => {
      if (r.id === "b") throw new Error("RPC exploded mid-payout");
      return { success: true, txHash: `0x${r.id}` };
    });

    db.enqueue([{ id: "a" }, { id: "b" }, { id: "c" }]); // approved-rows select

    const stats = await svc.processBatch();

    expect(stats.processed).toBe(3);
    expect(stats.succeeded).toBe(2);
    expect(stats.failed).toBe(1);
    // The throw on "b" did not prevent "c" from completing.
    expect(completed).toEqual(["a", "c"]);
  });
});
