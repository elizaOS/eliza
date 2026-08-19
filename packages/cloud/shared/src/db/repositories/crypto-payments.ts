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

  async markAsExpired(id: string): Promise<CryptoPayment | undefined> {
    const [payment] = await dbWrite
      .update(cryptoPayments)
      .set({
        status: "expired",
        updated_at: new Date(),
      })
      .where(eq(cryptoPayments.id, id))
      .returning();
    return payment;
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
