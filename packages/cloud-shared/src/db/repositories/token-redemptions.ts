import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { mutateRowCount } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { apps } from "../schemas/apps";
import {
  type ElizaTokenPrice,
  elizaTokenPrices,
  type NewElizaTokenPrice,
  type NewRedemptionLimit,
  type NewTokenRedemption,
  type RedemptionLimit,
  redemptionLimits,
  type TokenRedemption,
  tokenRedemptions,
} from "../schemas/token-redemptions";
import { users } from "../schemas/users";

export type {
  ElizaTokenPrice,
  NewElizaTokenPrice,
  NewRedemptionLimit,
  NewTokenRedemption,
  RedemptionLimit,
  TokenRedemption,
};

export type TokenRedemptionStatus = TokenRedemption["status"];

export interface AdminTokenRedemptionListRow {
  id: string;
  user_id: string;
  app_id: string | null;
  points_amount: string;
  usd_value: string;
  eliza_amount: string;
  eliza_price_usd: string;
  network: string;
  payout_address: string;
  status: TokenRedemptionStatus;
  requires_review: boolean;
  tx_hash: string | null;
  failure_reason: string | null;
  retry_count: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  created_at: Date;
  completed_at: Date | null;
  metadata: unknown;
  user_email: string | null;
  app_name: string | null;
}

export interface AdminTokenRedemptionStatusCount {
  status: TokenRedemptionStatus;
  count: number;
  total_usd: string;
}

/**
 * Repository for token redemption database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class TokenRedemptionsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
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
  async findByIdAndUser(id: string, userId: string): Promise<TokenRedemption | undefined> {
    return await dbRead.query.tokenRedemptions.findFirst({
      where: and(eq(tokenRedemptions.id, id), eq(tokenRedemptions.user_id, userId)),
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
      where: and(eq(tokenRedemptions.user_id, userId), eq(tokenRedemptions.status, "pending")),
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

  async listForAdmin(
    statuses: TokenRedemptionStatus[],
    limit: number,
  ): Promise<AdminTokenRedemptionListRow[]> {
    if (statuses.length === 0) return [];

    return await dbRead
      .select({
        id: tokenRedemptions.id,
        user_id: tokenRedemptions.user_id,
        app_id: tokenRedemptions.app_id,
        points_amount: tokenRedemptions.points_amount,
        usd_value: tokenRedemptions.usd_value,
        eliza_amount: tokenRedemptions.eliza_amount,
        eliza_price_usd: tokenRedemptions.eliza_price_usd,
        network: tokenRedemptions.network,
        payout_address: tokenRedemptions.payout_address,
        status: tokenRedemptions.status,
        requires_review: tokenRedemptions.requires_review,
        tx_hash: tokenRedemptions.tx_hash,
        failure_reason: tokenRedemptions.failure_reason,
        retry_count: tokenRedemptions.retry_count,
        reviewed_by: tokenRedemptions.reviewed_by,
        reviewed_at: tokenRedemptions.reviewed_at,
        review_notes: tokenRedemptions.review_notes,
        created_at: tokenRedemptions.created_at,
        completed_at: tokenRedemptions.completed_at,
        metadata: tokenRedemptions.metadata,
        user_email: users.email,
        app_name: apps.name,
      })
      .from(tokenRedemptions)
      .leftJoin(users, eq(tokenRedemptions.user_id, users.id))
      .leftJoin(apps, eq(tokenRedemptions.app_id, apps.id))
      .where(inArray(tokenRedemptions.status, statuses))
      .orderBy(desc(tokenRedemptions.created_at))
      .limit(limit);
  }

  async countByStatusForAdmin(): Promise<AdminTokenRedemptionStatusCount[]> {
    return await dbRead
      .select({
        status: tokenRedemptions.status,
        count: sql<number>`COUNT(*)`,
        total_usd: sql<string>`COALESCE(SUM(CAST(${tokenRedemptions.usd_value} AS DECIMAL)), 0)`,
      })
      .from(tokenRedemptions)
      .groupBy(tokenRedemptions.status);
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new token redemption request.
   */
  async create(data: NewTokenRedemption): Promise<TokenRedemption> {
    const [redemption] = await dbWrite.insert(tokenRedemptions).values(data).returning();
    return redemption;
  }

  /**
   * Acquires processing lock on a redemption.
   * Returns true if lock was acquired, false if already locked.
   */
  async acquireProcessingLock(redemptionId: string, workerId: string): Promise<boolean> {
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "processing",
        processing_started_at: new Date(),
        processing_worker_id: workerId,
        updated_at: new Date(),
      })
      .where(and(eq(tokenRedemptions.id, redemptionId), eq(tokenRedemptions.status, "approved")))
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
  async markFailed(redemptionId: string, reason: string, retryable: boolean): Promise<void> {
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
  async approve(redemptionId: string, reviewerId: string, notes?: string): Promise<boolean> {
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "approved",
        reviewed_by: reviewerId,
        reviewed_at: new Date(),
        review_notes: notes,
        updated_at: new Date(),
      })
      .where(and(eq(tokenRedemptions.id, redemptionId), eq(tokenRedemptions.status, "pending")))
      .returning();

    return !!updated;
  }

  /**
   * Admin: Rejects a pending redemption.
   */
  async reject(redemptionId: string, reviewerId: string, reason: string): Promise<boolean> {
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
      .where(and(eq(tokenRedemptions.id, redemptionId), eq(tokenRedemptions.status, "pending")))
      .returning();

    return !!updated;
  }
}

/**
 * Repository for redemption limits (daily rate limiting).
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class RedemptionLimitsRepository {
  /**
   * Gets or creates daily limits for a user.
   */
  async getOrCreateForToday(userId: string): Promise<RedemptionLimit> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await dbRead.query.redemptionLimits.findFirst({
      where: and(eq(redemptionLimits.user_id, userId), gte(redemptionLimits.date, today)),
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
      // Race condition - another request created it, refetch from write DB.
      const refetched = await dbWrite.query.redemptionLimits.findFirst({
        where: and(eq(redemptionLimits.user_id, userId), gte(redemptionLimits.date, today)),
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
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class ElizaTokenPricesRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Gets the most recent cached price for a network.
   */
  async getLatest(network: string, maxAgeMs: number): Promise<ElizaTokenPrice | undefined> {
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
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Caches a new price.
   */
  async cache(data: NewElizaTokenPrice): Promise<ElizaTokenPrice> {
    const [price] = await dbWrite.insert(elizaTokenPrices).values(data).returning();
    return price;
  }

  /**
   * Cleans up expired price entries.
   */
  async cleanupExpired(): Promise<number> {
    const result = await dbWrite
      .delete(elizaTokenPrices)
      .where(lt(elizaTokenPrices.expires_at, new Date()));

    return mutateRowCount(result);
  }
}

// Export singleton instances
export const tokenRedemptionsRepository = new TokenRedemptionsRepository();
export const redemptionLimitsRepository = new RedemptionLimitsRepository();
export const elizaTokenPricesRepository = new ElizaTokenPricesRepository();
