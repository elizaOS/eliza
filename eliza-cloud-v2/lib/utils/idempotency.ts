/**
 * Idempotency Utility for Webhook Handlers
 *
 * Database-backed deduplication to prevent replay attacks.
 * TTL matches the 2-minute webhook signature validity window.
 */

import { dbRead, dbWrite } from "@/db/client";
import { idempotencyKeys } from "@/db/schemas/idempotency-keys";
import { count, eq, gt, lt } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";

const IDEMPOTENCY_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Extract error message safely */
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

/**
 * Check if a message has already been processed within the TTL window.
 * Fails open (returns false) on errors to avoid dropping messages.
 */
export async function isAlreadyProcessed(key: string): Promise<boolean> {
  try {
    const [existing] = await dbRead
      .select({ expires_at: idempotencyKeys.expires_at })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    if (!existing) return false;

    // Check if expired - delete and return false if so
    if (existing.expires_at < new Date()) {
      await dbWrite.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
      return false;
    }

    return true;
  } catch (error) {
    logger.error("[Idempotency] Error checking key", { key, error: getErrorMessage(error) });
    return false;
  }
}

/**
 * Mark a message as processed. Uses upsert to handle race conditions.
 */
export async function markAsProcessed(key: string, source = "unknown"): Promise<void> {
  try {
    const expires_at = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
    await dbWrite
      .insert(idempotencyKeys)
      .values({ key, source, expires_at })
      .onConflictDoUpdate({ target: idempotencyKeys.key, set: { expires_at } });
  } catch (error) {
    logger.error("[Idempotency] Error marking key", { key, source, error: getErrorMessage(error) });
  }
}

/**
 * Get count of active (non-expired) idempotency keys. For monitoring.
 */
export async function getProcessedMessagesCount(): Promise<number> {
  try {
    const [result] = await dbRead
      .select({ count: count() })
      .from(idempotencyKeys)
      .where(gt(idempotencyKeys.expires_at, new Date()));
    return result?.count ?? 0;
  } catch (error) {
    logger.error("[Idempotency] Error getting count", { error: getErrorMessage(error) });
    return 0;
  }
}

/**
 * Clean up expired idempotency keys. Call periodically via cron.
 */
export async function cleanupExpiredKeys(): Promise<number> {
  try {
    const deleted = await dbWrite
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expires_at, new Date()))
      .returning({ id: idempotencyKeys.id });

    if (deleted.length > 0) {
      logger.info("[Idempotency] Cleaned up expired keys", { count: deleted.length });
    }
    return deleted.length;
  } catch (error) {
    logger.error("[Idempotency] Error cleaning up", { error: getErrorMessage(error) });
    return 0;
  }
}

/** Clear all idempotency keys (for testing). */
export async function clearProcessedMessages(): Promise<void> {
  try {
    await dbWrite.delete(idempotencyKeys);
  } catch (error) {
    logger.error("[Idempotency] Error clearing keys", { error: getErrorMessage(error) });
  }
}
