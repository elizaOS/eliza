/** Serializes durable signed sweep ownership per EVM chain and sender. */
import { and, eq, gt, isNull, ne, not, sql } from "drizzle-orm";
import {
  getAddress,
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { dbWrite } from "../../db/client";
import { sqlRows } from "../../db/execute-helpers";
import { cryptoSweepOutbox } from "../../db/schemas/crypto-settlement-outbox";

export class EvmSweepDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmSweepDeferredError";
  }
}
export interface EvmSweepIdentity {
  sender: string;
  chainId: bigint;
  nonce: bigint;
}
export interface PreparedEvmSweep {
  rawTransaction: string;
  transactionHash: string;
  metadata: { network: "base" | "bsc"; sweepTo: string; nonce: string; sender?: string };
}
export async function signedEvmSweepIdentity(
  prepared: PreparedEvmSweep,
): Promise<EvmSweepIdentity> {
  const raw = prepared.rawTransaction as Hex;
  const tx = parseTransaction(raw);
  if (
    keccak256(raw).toLowerCase() !== prepared.transactionHash.toLowerCase() ||
    tx.chainId === undefined ||
    tx.nonce === undefined ||
    !Number.isSafeInteger(tx.chainId) ||
    !Number.isSafeInteger(tx.nonce) ||
    tx.chainId <= 0 ||
    tx.nonce < 0 ||
    String(tx.nonce) !== prepared.metadata.nonce
  )
    throw new Error("Prepared EVM sweep identity is invalid");
  const sender = (
    await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })
  ).toLowerCase();
  if (prepared.metadata.sender && getAddress(prepared.metadata.sender).toLowerCase() !== sender)
    throw new Error("Prepared EVM sweep sender does not match signed bytes");
  return { sender, chainId: BigInt(tx.chainId), nonce: BigInt(tx.nonce) };
}

/** Historical signed bytes are authority; never infer a nonce from today's RPC. */
async function restoreLegacyIdentities(
  network: "base" | "bsc",
  sender: string,
  deadline: number,
): Promise<void> {
  let afterId: string | undefined;
  for (;;) {
    if (performance.now() >= deadline)
      throw new EvmSweepDeferredError("Legacy EVM sweep identity recovery will continue on retry");
    const rows = await dbWrite
      .select({
        id: cryptoSweepOutbox.id,
        prepared_transaction: cryptoSweepOutbox.prepared_transaction,
        sweep_transaction_hash: cryptoSweepOutbox.sweep_transaction_hash,
        prepared_metadata: cryptoSweepOutbox.prepared_metadata,
      })
      .from(cryptoSweepOutbox)
      .where(
        and(
          isNull(cryptoSweepOutbox.evm_sender),
          not(isNull(cryptoSweepOutbox.prepared_transaction)),
          sql`${cryptoSweepOutbox.prepared_metadata}->>'network'=${network}`,
          afterId ? gt(cryptoSweepOutbox.id, afterId) : undefined,
        ),
      )
      .orderBy(cryptoSweepOutbox.id)
      .limit(100);
    if (rows.length === 0) return;
    for (const row of rows) {
      afterId = row.id;
      if (performance.now() >= deadline)
        throw new EvmSweepDeferredError(
          "Legacy EVM sweep identity recovery will continue on retry",
        );
      if (!row.prepared_transaction)
        throw new EvmSweepDeferredError("Legacy EVM sweep signature requires reconciliation");
      const legacySender = (
        await recoverTransactionAddress({
          serializedTransaction: row.prepared_transaction as TransactionSerialized,
        })
      ).toLowerCase();
      if (legacySender !== sender) continue;
      const metadata = row.prepared_metadata;
      if (
        !row.prepared_transaction ||
        !row.sweep_transaction_hash ||
        !metadata ||
        typeof metadata.nonce !== "string" ||
        typeof metadata.sweepTo !== "string"
      )
        throw new EvmSweepDeferredError("Legacy EVM sweep identity requires reconciliation");
      const identity = await signedEvmSweepIdentity({
        rawTransaction: row.prepared_transaction,
        transactionHash: row.sweep_transaction_hash,
        metadata: { network, nonce: metadata.nonce, sweepTo: metadata.sweepTo },
      });
      if (identity.chainId !== BigInt(network === "base" ? 8453 : 56))
        throw new EvmSweepDeferredError("Legacy EVM sweep chain requires reconciliation");
      try {
        await dbWrite
          .update(cryptoSweepOutbox)
          .set({
            evm_sender: identity.sender,
            evm_chain_id: identity.chainId,
            evm_nonce: identity.nonce,
          })
          .where(
            and(
              eq(cryptoSweepOutbox.id, row.id),
              isNull(cryptoSweepOutbox.evm_sender),
              eq(cryptoSweepOutbox.prepared_transaction, row.prepared_transaction),
              eq(cryptoSweepOutbox.sweep_transaction_hash, row.sweep_transaction_hash),
            ),
          );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "cause" in error &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause &&
          error.cause.code === "23505"
        )
          throw new EvmSweepDeferredError(
            "Legacy EVM sweep nonce collision requires reconciliation",
          );
        throw error;
      }
    }
    if (rows.length < 100) return;
  }
}

/**
 * One unresolved signed transaction per chain/sender. Prepared bytes retain the
 * nonce across process death; a later intent waits for its receipt or explicit
 * reconciliation. This deliberately trades per-wallet throughput for recovery
 * without nonce gaps. Different senders have independent transaction locks.
 */
export async function prepareAndPersistEvmSweep(params: {
  outboxId: string;
  claimToken: string;
  network: "base" | "bsc";
  sender: string;
  chainId: number;
  readNonce: (blockTag: "latest" | "pending") => Promise<number>;
  prepare: (nonce: number) => Promise<PreparedEvmSweep>;
}): Promise<PreparedEvmSweep> {
  const deadline = performance.now() + 30_000;
  const sender = getAddress(params.sender).toLowerCase();
  await restoreLegacyIdentities(params.network, sender, deadline);
  return dbWrite.transaction(async (tx) => {
    const [lock] = await sqlRows<{ acquired: boolean }>(
      tx,
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`crypto-sweep:${params.chainId}:${sender}`},0)) AS acquired`,
    );
    if (!lock?.acquired) throw new EvmSweepDeferredError("Another sweep owns this EVM wallet");
    const [owned] = await tx
      .select({ id: cryptoSweepOutbox.id })
      .from(cryptoSweepOutbox)
      .where(
        and(
          eq(cryptoSweepOutbox.id, params.outboxId),
          eq(cryptoSweepOutbox.claim_token, params.claimToken),
          eq(cryptoSweepOutbox.state, "processing"),
          gt(cryptoSweepOutbox.lease_expires_at, sql`clock_timestamp()`),
          isNull(cryptoSweepOutbox.prepared_transaction),
        ),
      )
      .for("update")
      .limit(1);
    if (!owned) throw new EvmSweepDeferredError("EVM sweep preparation claim is no longer current");
    const [confirmed, pending] = await Promise.all([
      params.readNonce("latest"),
      params.readNonce("pending"),
    ]);
    if (
      !Number.isSafeInteger(confirmed) ||
      confirmed < 0 ||
      !Number.isSafeInteger(pending) ||
      pending < 0
    )
      throw new Error("EVM provider returned an invalid transaction count");
    const [blocker] = await tx
      .select({ id: cryptoSweepOutbox.id })
      .from(cryptoSweepOutbox)
      .where(
        and(
          ne(cryptoSweepOutbox.id, params.outboxId),
          eq(cryptoSweepOutbox.evm_sender, sender),
          eq(cryptoSweepOutbox.evm_chain_id, BigInt(params.chainId)),
          sql`(${cryptoSweepOutbox.evm_confirmed_at} IS NULL OR ${cryptoSweepOutbox.evm_nonce}>=${BigInt(confirmed)})`,
        ),
      )
      .limit(1);
    if (blocker)
      throw new EvmSweepDeferredError("A prior prepared EVM sweep retains this wallet nonce");
    if (pending !== confirmed)
      throw new EvmSweepDeferredError("EVM provider pending nonce requires reconciliation");
    if (performance.now() >= deadline)
      throw new EvmSweepDeferredError("EVM sweep preparation exceeded its operation deadline");
    const prepared = await params.prepare(confirmed);
    const identity = await signedEvmSweepIdentity(prepared);
    if (
      identity.sender !== sender ||
      identity.chainId !== BigInt(params.chainId) ||
      identity.nonce !== BigInt(confirmed)
    )
      throw new Error("Prepared EVM sweep does not match its wallet authority");
    if (performance.now() >= deadline)
      throw new EvmSweepDeferredError("EVM sweep preparation exceeded its operation deadline");
    const [saved] = await tx
      .update(cryptoSweepOutbox)
      .set({
        prepared_transaction: prepared.rawTransaction,
        sweep_transaction_hash: prepared.transactionHash,
        prepared_metadata: { ...prepared.metadata, sender },
        evm_sender: sender,
        evm_chain_id: identity.chainId,
        evm_nonce: identity.nonce,
        updated_at: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(cryptoSweepOutbox.id, params.outboxId),
          eq(cryptoSweepOutbox.claim_token, params.claimToken),
          gt(cryptoSweepOutbox.lease_expires_at, sql`clock_timestamp()`),
          isNull(cryptoSweepOutbox.prepared_transaction),
        ),
      )
      .returning({ id: cryptoSweepOutbox.id });
    if (!saved)
      throw new EvmSweepDeferredError(
        "EVM sweep claim expired before signed transaction persistence",
      );
    return { ...prepared, metadata: { ...prepared.metadata, sender } };
  });
}
