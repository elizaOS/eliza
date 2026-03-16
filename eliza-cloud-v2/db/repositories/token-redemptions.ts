import { dbRead, dbWrite } from "../helpers";
import {
  tokenRedemptions,
  redemptionLimits,
  elizaTokenPrices,
  type TokenRedemption,
  type NewTokenRedemption,
  type RedemptionLimit,
  type NewRedemptionLimit,
  type ElizaTokenPrice,
  type NewElizaTokenPrice,
} from "../schemas/token-redemptions";
import { eq, and, desc, gte, sql, lt, or, isNull } from "drizzle-orm";

export type {
  TokenRedemption,
  NewTokenRedemption,
  RedemptionLimit,
  NewRedemptionLimit,
  ElizaTokenPrice,
  NewElizaTokenPrice,
};

/**
 * Repository for token redemption database operations.
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (NA primary)
 */
export class TokenRedemptionsRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
  // ============================================================================

  /**
   * Finds a redemption by ID.
   */
  async findById(id: string): Promise<TokenRedemption | undefined> {
    return await dbRead.query.tokenRedemptions.findFirst({
      where: eq(tokenRedemptions.id, id),
    });
  }

  /**
   * Finds a redemption by ID and user ID (for security).
   */
  async findByIdAndUser(
    id: string,
    userId: string,
  ): Promise<TokenRedemption | undefined> {
    return await dbRead.query.tokenRedemptions.findFirst({
      where: and(
        eq(tokenRedemptions.id, id),
        eq(tokenRedemptions.user_id, userId),
      ),
    });
  }

  /**
   * Lists redemptions for a user, ordered by creation date.
   */
  async listByUser(userId: string, limit = 20): Promise<TokenRedemption[]> {
    return await dbRead.query.tokenRedemptions.findMany({
      where: eq(tokenRedemptions.user_id, userId),
      orderBy: [desc(tokenRedemptions.created_at)],
      limit,
    });
  }

  /**
   * Checks if user has a pending redemption.
   */
  async hasPendingRedemption(userId: string): Promise<boolean> {
    const pending = await dbRead.query.tokenRedemptions.findFirst({
      where: and(
        eq(tokenRedemptions.user_id, userId),
        eq(tokenRedemptions.status, "pending"),
      ),
    });
    return !!pending;
  }

  /**
   * Gets approved redemptions ready for processing.
   * Excludes items that are currently being processed or have exceeded retry limit.
   */
  async getApprovedForProcessing(
    batchSize: number,
    lockTimeoutMs: number,
    maxRetries: number,
  ): Promise<TokenRedemption[]> {
    const lockThreshold = new Date(Date.now() - lockTimeoutMs);

    return await dbRead
      .select()
      .from(tokenRedemptions)
      .where(
        and(
          eq(tokenRedemptions.status, "approved"),
          or(
            isNull(tokenRedemptions.processing_started_at),
            lt(tokenRedemptions.processing_started_at, lockThreshold),
          ),
          lt(sql`CAST(${tokenRedemptions.retry_count} AS INTEGER)`, maxRetries),
        ),
      )
      .limit(batchSize);
  }

  /**
   * Gets pending redemptions requiring admin review.
   */
  async getPendingForReview(limit = 50): Promise<TokenRedemption[]> {
    return await dbRead.query.tokenRedemptions.findMany({
      where: and(
        eq(tokenRedemptions.status, "pending"),
        eq(tokenRedemptions.requires_review, true),
      ),
      orderBy: [desc(tokenRedemptions.created_at)],
      limit,
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
  // ============================================================================

  /**
   * Creates a new token redemption request.
   */
  async create(data: NewTokenRedemption): Promise<TokenRedemption> {
    const [redemption] = await dbWrite
      .insert(tokenRedemptions)
      .values(data)
      .returning();
    return redemption;
  }

  /**
   * Acquires processing lock on a redemption.
   * Returns true if lock was acquired, false if already locked.
   */
  async acquireProcessingLock(
    redemptionId: string,
    workerId: string,
  ): Promise<boolean> {
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "processing",
        processing_started_at: new Date(),
        processing_worker_id: workerId,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tokenRedemptions.id, redemptionId),
          eq(tokenRedemptions.status, "approved"),
        ),
      )
      .returning();

    return !!updated;
  }

  /**
   * Marks a redemption as completed with transaction hash.
   */
  async markCompleted(redemptionId: string, txHash: string): Promise<void> {
    await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "completed",
        tx_hash: txHash,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(tokenRedemptions.id, redemptionId));
  }

  /**
   * Marks a redemption as failed with reason.
   * If retryable, resets to approved for retry.
   */
  async markFailed(
    redemptionId: string,
    reason: string,
    retryable: boolean,
  ): Promise<void> {
    if (retryable) {
      await dbWrite
        .update(tokenRedemptions)
        .set({
          status: "approved",
          failure_reason: reason,
          retry_count: sql`${tokenRedemptions.retry_count} + 1`,
          processing_started_at: null,
          processing_worker_id: null,
          updated_at: new Date(),
        })
        .where(eq(tokenRedemptions.id, redemptionId));
    } else {
      await dbWrite
        .update(tokenRedemptions)
        .set({
          status: "failed",
          failure_reason: reason,
          updated_at: new Date(),
        })
        .where(eq(tokenRedemptions.id, redemptionId));
    }
  }

  /**
   * Admin: Approves a pending redemption.
   */
  async approve(
    redemptionId: string,
    reviewerId: string,
    notes?: string,
  ): Promise<boolean> {
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "approved",
        reviewed_by: reviewerId,
        reviewed_at: new Date(),
        review_notes: notes,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tokenRedemptions.id, redemptionId),
          eq(tokenRedemptions.status, "pending"),
        ),
      )
      .returning();

    return !!updated;
  }

  /**
   * Admin: Rejects a pending redemption.
   */
  async reject(
    redemptionId: string,
    reviewerId: string,
    reason: string,
  ): Promise<boolean> {
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "rejected",
        failure_reason: reason,
        reviewed_by: reviewerId,
        reviewed_at: new Date(),
        review_notes: reason,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tokenRedemptions.id, redemptionId),
          eq(tokenRedemptions.status, "pending"),
        ),
      )
      .returning();

    return !!updated;
  }
}

/**
 * Repository for redemption limits (daily rate limiting).
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (NA primary)
 */
export class RedemptionLimitsRepository {
  /**
   * Gets or creates daily limits for a user.
   */
  async getOrCreateForToday(userId: string): Promise<RedemptionLimit> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await dbRead.query.redemptionLimits.findFirst({
      where: and(
        eq(redemptionLimits.user_id, userId),
        gte(redemptionLimits.date, today),
      ),
    });

    if (existing) {
      return existing;
    }

    const [created] = await dbWrite
      .insert(redemptionLimits)
      .values({
        user_id: userId,
        date: today,
      })
      .onConflictDoNothing()
      .returning();

    if (!created) {
      // Race condition - another request created it, use write DB to avoid replication lag
      const refetched = await dbWrite.query.redemptionLimits.findFirst({
        where: and(
          eq(redemptionLimits.user_id, userId),
          gte(redemptionLimits.date, today),
        ),
      });
      if (!refetched) {
        throw new Error("Failed to create or find redemption limits");
      }
      return refetched;
    }

    return created;
  }

  /**
   * Atomically increments daily limits.
   */
  async incrementLimits(userId: string, usdAmount: number): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await dbWrite
      .insert(redemptionLimits)
      .values({
        user_id: userId,
        date: today,
        daily_usd_total: String(usdAmount),
        redemption_count: "1",
      })
      .onConflictDoUpdate({
        target: [redemptionLimits.user_id, redemptionLimits.date],
        set: {
          daily_usd_total: sql`${redemptionLimits.daily_usd_total} + ${usdAmount}`,
          redemption_count: sql`${redemptionLimits.redemption_count} + 1`,
          updated_at: new Date(),
        },
      });
  }
}

/**
 * Repository for elizaOS token price cache.
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (NA primary)
 */
export class ElizaTokenPricesRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
  // ============================================================================

  /**
   * Gets the most recent cached price for a network.
   */
  async getLatest(
    network: string,
    maxAgeMs: number,
  ): Promise<ElizaTokenPrice | undefined> {
    const minFetchedAt = new Date(Date.now() - maxAgeMs);

    return await dbRead.query.elizaTokenPrices.findFirst({
      where: and(
        eq(elizaTokenPrices.network, network),
        gte(elizaTokenPrices.fetched_at, minFetchedAt),
      ),
      orderBy: [desc(elizaTokenPrices.fetched_at)],
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
  // ============================================================================

  /**
   * Caches a new price.
   */
  async cache(data: NewElizaTokenPrice): Promise<ElizaTokenPrice> {
    const [price] = await dbWrite
      .insert(elizaTokenPrices)
      .values(data)
      .returning();
    return price;
  }

  /**
   * Cleans up expired price entries.
   */
  async cleanupExpired(): Promise<number> {
    const result = await dbWrite
      .delete(elizaTokenPrices)
      .where(lt(elizaTokenPrices.expires_at, new Date()));

    return result.rowCount ?? 0;
  }
}

// Export singleton instances
export const tokenRedemptionsRepository = new TokenRedemptionsRepository();
export const redemptionLimitsRepository = new RedemptionLimitsRepository();
export const elizaTokenPricesRepository = new ElizaTokenPricesRepository();
