/** Persists crypto payments records for cloud services through the shared DB boundary. */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  canonicalizeCryptoTransactionHash,
  isHexTransactionHash,
} from "../crypto-payment-transaction-hash";
import { dbRead, dbWrite } from "../helpers";
import {
  type CryptoPayment,
  cryptoPayments,
  type NewCryptoPayment,
} from "../schemas/crypto-payments";

export type { CryptoPayment, NewCryptoPayment };

const SETTLE_CLAIM_KEY = "settleClaimedUntil";
export const SETTLEMENT_PENDING_KEY = "settlementPending";

function settleClaimInactive() {
  // A deadline is not proof that a broadcast transfer failed. Retain the
  // claim until a definitive rejection releases it or settlement confirms it.
  return sql`${cryptoPayments.metadata}->>${SETTLE_CLAIM_KEY}::text IS NULL`;
}

/**
 * Repository for crypto payment database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class CryptoPaymentsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  async findById(id: string): Promise<CryptoPayment | undefined> {
    return await dbRead.query.cryptoPayments.findFirst({
      where: eq(cryptoPayments.id, id),
    });
  }

  async findByPaymentAddress(address: string): Promise<CryptoPayment | undefined> {
    return await dbRead.query.cryptoPayments.findFirst({
      where: eq(cryptoPayments.payment_address, address),
      orderBy: desc(cryptoPayments.created_at),
    });
  }

  async findByTransactionHash(txHash: string): Promise<CryptoPayment | undefined> {
    const canonicalTxHash = canonicalizeCryptoTransactionHash(txHash);
    const [payment] = await dbRead
      .select()
      .from(cryptoPayments)
      .where(
        isHexTransactionHash(canonicalTxHash)
          ? sql`lower(${cryptoPayments.transaction_hash}) = ${canonicalTxHash}`
          : eq(cryptoPayments.transaction_hash, canonicalTxHash),
      )
      .limit(1);
    return payment;
  }

  async findByTrackId(trackId: string): Promise<CryptoPayment | undefined> {
    const [payment] = await dbRead
      .select()
      .from(cryptoPayments)
      .where(sql`${cryptoPayments.metadata}->>'oxapay_track_id' = ${trackId}`)
      .limit(1);
    return payment;
  }

  async findPendingByAddress(address: string): Promise<CryptoPayment | undefined> {
    return await dbRead.query.cryptoPayments.findFirst({
      where: and(eq(cryptoPayments.payment_address, address), eq(cryptoPayments.status, "pending")),
    });
  }

  async listByOrganization(organizationId: string): Promise<CryptoPayment[]> {
    return await dbRead.query.cryptoPayments.findMany({
      where: eq(cryptoPayments.organization_id, organizationId),
      orderBy: desc(cryptoPayments.created_at),
    });
  }

  async listPendingPayments(): Promise<CryptoPayment[]> {
    return await dbRead.query.cryptoPayments.findMany({
      where: eq(cryptoPayments.status, "pending"),
      orderBy: desc(cryptoPayments.created_at),
    });
  }

  async listExpiredPendingPayments(): Promise<CryptoPayment[]> {
    return await dbRead.query.cryptoPayments.findMany({
      where: and(eq(cryptoPayments.status, "pending"), lt(cryptoPayments.expires_at, new Date())),
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  async create(data: NewCryptoPayment): Promise<CryptoPayment> {
    const transactionHash =
      typeof data.transaction_hash === "string"
        ? canonicalizeCryptoTransactionHash(data.transaction_hash, data.network)
        : data.transaction_hash;
    const [payment] = await dbWrite
      .insert(cryptoPayments)
      .values({
        ...data,
        transaction_hash: transactionHash,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning();
    return payment;
  }

  async update(id: string, data: Partial<NewCryptoPayment>): Promise<CryptoPayment | undefined> {
    const transactionHash =
      typeof data.transaction_hash === "string"
        ? canonicalizeCryptoTransactionHash(data.transaction_hash, data.network)
        : data.transaction_hash;
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        ...data,
        ...(data.transaction_hash !== undefined && { transaction_hash: transactionHash }),
        updated_at: new Date(),
      })
      .where(eq(cryptoPayments.id, id))
      .returning();
    return payment;
  }

  async markAsConfirmed(
    id: string,
    txHash: string,
    blockNumber: string,
    receivedAmount: string,
  ): Promise<CryptoPayment | undefined> {
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        status: "confirmed",
        transaction_hash: canonicalizeCryptoTransactionHash(txHash),
        block_number: blockNumber,
        received_amount: receivedAmount,
        confirmed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(cryptoPayments.id, id))
      .returning();
    return payment;
  }

  /**
   * Expires a still-pending payment that no settlement currently holds; returns
   * undefined when it is no longer pending or a settle claim is active.
   */
  async markAsExpired(id: string): Promise<CryptoPayment | undefined> {
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        status: "expired",
        updated_at: new Date(),
      })
      .where(
        and(eq(cryptoPayments.id, id), eq(cryptoPayments.status, "pending"), settleClaimInactive()),
      )
      .returning();
    return payment;
  }

  /**
   * Atomically claims a pending payment for one settlement attempt. The recorded
   * deadline is diagnostic, never permission to replay an uncertain transfer.
   */
  async claimSettlement(id: string, claimedUntil: Date): Promise<CryptoPayment | undefined> {
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        metadata: sql`coalesce(${cryptoPayments.metadata}, '{}'::jsonb) || jsonb_build_object(${SETTLE_CLAIM_KEY}::text, ${claimedUntil.toISOString()}::text)`,
        updated_at: new Date(),
      })
      .where(
        and(eq(cryptoPayments.id, id), eq(cryptoPayments.status, "pending"), settleClaimInactive()),
      )
      .returning();
    return payment;
  }

  /**
   * Records a facilitator settlement in one statement: confirms the row,
   * releases the settle claim, merges `metadataPatch`, and flags the
   * post-settlement work as pending until `clearSettlementPending` runs.
   */
  async confirmSettlement(
    id: string,
    params: { txHash: string; receivedAmount: string; metadataPatch: Record<string, unknown> },
  ): Promise<CryptoPayment | undefined> {
    const now = new Date();
    const patch = { ...params.metadataPatch, [SETTLEMENT_PENDING_KEY]: true };
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        status: "confirmed",
        transaction_hash: canonicalizeCryptoTransactionHash(params.txHash),
        block_number: "",
        received_amount: params.receivedAmount,
        confirmed_at: now,
        updated_at: now,
        metadata: sql`(coalesce(${cryptoPayments.metadata}, '{}'::jsonb) - ${SETTLE_CLAIM_KEY}::text) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(cryptoPayments.id, id))
      .returning();
    return payment;
  }

  /**
   * Clears the post-settlement flag set by `confirmSettlement`; returns
   * undefined when another caller already cleared it.
   */
  async clearSettlementPending(id: string): Promise<CryptoPayment | undefined> {
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        metadata: sql`${cryptoPayments.metadata} - ${SETTLEMENT_PENDING_KEY}::text`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(cryptoPayments.id, id),
          eq(cryptoPayments.status, "confirmed"),
          sql`${cryptoPayments.metadata}->>${SETTLEMENT_PENDING_KEY}::text = 'true'`,
        ),
      )
      .returning();
    return payment;
  }

  async releaseSettlementClaim(id: string): Promise<void> {
    await dbWrite
      .update(cryptoPayments)
      .set({
        metadata: sql`${cryptoPayments.metadata} - ${SETTLE_CLAIM_KEY}::text`,
        updated_at: new Date(),
      })
      .where(and(eq(cryptoPayments.id, id), eq(cryptoPayments.status, "pending")));
  }

  async markAsFailed(id: string, reason?: string): Promise<CryptoPayment | undefined> {
    const existing = await this.findById(id);
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        status: "failed",
        metadata: reason ? { ...existing?.metadata, failureReason: reason } : existing?.metadata,
        updated_at: new Date(),
      })
      .where(eq(cryptoPayments.id, id))
      .returning();
    return payment;
  }
}

export const cryptoPaymentsRepository = new CryptoPaymentsRepository();
