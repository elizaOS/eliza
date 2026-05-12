/**
 * ALB Listener Rule Priority Manager
 *
 * Manages unique priority assignment for ALB listener rules.
 * ALB priorities must be unique integers between 1 and 50,000.
 *
 * SIMPLIFIED APPROACH:
 * - Sequential allocation: next_priority = max(priority) + 1
 * - Released priorities are marked with released_at timestamp
 * - Cleanup cron deletes released priorities after 1 hour (allows audit trail)
 * - No complex hashing or collision handling needed
 */

import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { albPriorities } from "@/db/schemas/alb-priorities";
import { logger } from "@/lib/utils/logger";

/**
 * Database-backed priority manager (PRODUCTION)
 *
 * Uses PostgreSQL with sequential allocation and soft deletes.
 */
export class DatabasePriorityManager {
  private static readonly MAX_RETRIES = 5;

  /**
   * Allocate next available ALB priority for a user's project
   * Uses simple sequential allocation with database transaction and retry logic
   *
   * @param userId - The user ID
   * @param projectName - The project name (each user can have multiple projects)
   */
  async allocatePriority(userId: string, projectName: string = "default"): Promise<number> {
    logger.info(
      `[ALB allocatePriority] Starting allocation for user ${userId}, project ${projectName}`,
    );

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= DatabasePriorityManager.MAX_RETRIES; attempt++) {
      try {
        return await this.tryAllocatePriority(userId, projectName, attempt);
      } catch (error) {
        lastError = error as Error;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if it's a unique constraint violation (can retry)
        const isConstraintViolation =
          errorMessage.includes("unique") ||
          errorMessage.includes("duplicate") ||
          errorMessage.includes("23505"); // PostgreSQL unique violation code

        if (isConstraintViolation && attempt < DatabasePriorityManager.MAX_RETRIES) {
          logger.warn(
            `[ALB allocatePriority] Attempt ${attempt} failed with constraint violation, retrying...`,
          );
          // Small random delay to reduce collision probability
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 100 * attempt));
          continue;
        }

        // Non-retryable error or max retries exceeded
        throw error;
      }
    }

    throw lastError || new Error("Failed to allocate ALB priority after max retries");
  }

  /**
   * Internal method to attempt priority allocation
   */
  private async tryAllocatePriority(
    userId: string,
    projectName: string,
    attempt: number,
  ): Promise<number> {
    return await dbWrite.transaction(async (tx) => {
      logger.info(
        `[ALB allocatePriority] Inside transaction for user ${userId}, project ${projectName} (attempt ${attempt})`,
      );

      // Check if user+project already has a priority record (active or expired)
      const existing = await tx.query.albPriorities.findFirst({
        where: and(eq(albPriorities.userId, userId), eq(albPriorities.projectName, projectName)),
      });

      if (existing && !existing.expiresAt) {
        // User+project has an active priority - return it
        logger.info(
          `[ALB allocatePriority] User ${userId} project ${projectName} already has priority ${existing.priority}`,
        );
        return existing.priority;
      }

      if (existing && existing.expiresAt) {
        // User+project has an expired priority - reactivate it by clearing expiresAt
        logger.info(
          `[ALB allocatePriority] Reactivating expired priority ${existing.priority} for user ${userId} project ${projectName}`,
        );
        const [reactivated] = await tx
          .update(albPriorities)
          .set({ expiresAt: null, createdAt: new Date() })
          .where(and(eq(albPriorities.userId, userId), eq(albPriorities.projectName, projectName)))
          .returning();

        logger.info(
          `✅ Reactivated ALB priority ${reactivated.priority} for user ${userId} project ${projectName}`,
        );
        return reactivated.priority;
      }

      // Get the maximum priority (including expired ones to avoid conflicts)
      const [maxResult] = await tx
        .select({
          maxPriority: sql<number>`COALESCE(MAX(${albPriorities.priority}), 0)`,
        })
        .from(albPriorities);

      const nextPriority = (maxResult?.maxPriority || 0) + 1;

      // Validate we haven't exceeded ALB limit
      if (nextPriority > 50000) {
        throw new Error("ALB priority limit exceeded - too many containers created (max 50,000)");
      }

      logger.info(
        `[ALB] Attempting to allocate priority ${nextPriority} for user ${userId} project ${projectName}`,
      );

      // Create new priority record
      const [inserted] = await tx
        .insert(albPriorities)
        .values({
          userId,
          projectName,
          priority: nextPriority,
          createdAt: new Date(),
          // expiresAt is omitted - will default to NULL in the database
        })
        .returning();

      logger.info(
        `✅ Allocated ALB priority ${inserted.priority} for user ${userId} project ${projectName}`,
      );
      return inserted.priority;
    });
  }

  /**
   * Release a priority when a container is deleted
   * Sets expiry timestamp for cleanup (1 hour grace period for audit)
   *
   * @param userId - The user ID
   * @param projectName - The project name (each user can have multiple projects)
   */
  async releasePriority(userId: string, projectName: string = "default"): Promise<void> {
    // Set expiry date (1 hour from now for audit trail)
    const expiryDate = new Date(Date.now() + 60 * 60 * 1000);

    const result = await dbWrite
      .update(albPriorities)
      .set({ expiresAt: expiryDate })
      .where(and(eq(albPriorities.userId, userId), eq(albPriorities.projectName, projectName)))
      .returning();

    if (result.length > 0) {
      logger.info(
        `✅ Released ALB priority ${result[0].priority} for user ${userId} project ${projectName} (expires: ${expiryDate.toISOString()})`,
      );
    } else {
      logger.warn(`⚠️  No ALB priority found for user ${userId} project ${projectName}`);
    }
  }

  /**
   * Get priority for a user+project (without allocating if doesn't exist)
   *
   * @param userId - The user ID
   * @param projectName - The project name (each user can have multiple projects)
   */
  async getPriority(userId: string, projectName: string = "default"): Promise<number | undefined> {
    const result = await dbRead.query.albPriorities.findFirst({
      where: and(eq(albPriorities.userId, userId), eq(albPriorities.projectName, projectName)),
    });

    // Only return if not expired
    if (result && !result.expiresAt) {
      return result.priority;
    }

    return undefined;
  }

  /**
   * Cleanup expired priorities (run this via cron every hour)
   * Permanently deletes priorities that have expired
   */
  async cleanupExpiredPriorities(): Promise<number> {
    const now = new Date();
    const deleted = await dbWrite
      .delete(albPriorities)
      .where(and(isNotNull(albPriorities.expiresAt), lt(albPriorities.expiresAt, now)))
      .returning();

    if (deleted.length > 0) {
      logger.info(
        `🧹 Cleaned up ${deleted.length} expired ALB priorities (freed ${deleted.map((p) => p.priority).join(", ")})`,
      );
    }

    return deleted.length;
  }

  /**
   * Get all active priorities (for debugging/monitoring)
   */
  async getAllActivePriorities(): Promise<
    Array<{
      userId: string;
      projectName: string;
      priority: number;
      createdAt: Date;
    }>
  > {
    const results = await dbRead.query.albPriorities.findMany({
      where: isNull(albPriorities.expiresAt),
      columns: {
        userId: true,
        projectName: true,
        priority: true,
        createdAt: true,
      },
      orderBy: (albPriorities, { asc }) => [asc(albPriorities.priority)],
    });

    return results.map((r) => ({
      userId: r.userId,
      projectName: r.projectName,
      priority: r.priority,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Get statistics about priority allocation
   */
  async getStats(): Promise<{
    totalActive: number;
    totalExpired: number;
    highestPriority: number;
    availableSlots: number;
  }> {
    const [activeCount] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(albPriorities)
      .where(isNull(albPriorities.expiresAt));

    const [expiredCount] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(albPriorities)
      .where(isNotNull(albPriorities.expiresAt));

    const [maxResult] = await dbRead
      .select({ max: sql<number>`COALESCE(MAX(${albPriorities.priority}), 0)` })
      .from(albPriorities)
      .where(isNull(albPriorities.expiresAt));

    const highestPriority = maxResult?.max || 0;
    const totalActive = activeCount?.count || 0;
    const totalExpired = expiredCount?.count || 0;

    return {
      totalActive,
      totalExpired,
      highestPriority,
      availableSlots: 50000 - totalActive,
    };
  }
}

export const dbPriorityManager = new DatabasePriorityManager();
