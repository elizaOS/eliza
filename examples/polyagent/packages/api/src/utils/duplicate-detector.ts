/**
 * Duplicate Content Detection Utility
 *
 * Prevents users from posting duplicate content in a short time period.
 * Uses content hashing to detect exact and near-duplicate content.
 */

import crypto from "node:crypto";
import { logger } from "@polyagent/shared";

interface DuplicateRecord {
  contentHash: string;
  timestamp: number;
}

// In-memory store for duplicate detection
// In production, you might want to use Redis
const duplicateStore = new Map<string, DuplicateRecord[]>();

/**
 * Duplicate detection configurations
 */
export const DUPLICATE_DETECTION_CONFIGS = {
  POST: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    actionType: "post",
  },
  COMMENT: {
    windowMs: 2 * 60 * 1000, // 2 minutes
    actionType: "comment",
  },
  MESSAGE: {
    windowMs: 1 * 60 * 1000, // 1 minute
    actionType: "message",
  },
} as const;

/**
 * Create a hash of content for duplicate detection
 * Normalizes content by removing extra whitespace and converting to lowercase
 */
function hashContent(content: string): string {
  // Normalize content: trim, lowercase, remove extra whitespace
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");

  // Create SHA-256 hash
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Check if content is a duplicate
 * Returns true if the same content was posted recently by the same user
 */
export function checkDuplicate(
  userId: string,
  content: string,
  config: { windowMs: number; actionType: string },
): { isDuplicate: boolean; lastPostedAt?: Date } {
  const key = `${userId}:${config.actionType}`;
  const contentHash = hashContent(content);
  const now = Date.now();

  // Get user's recent posts
  let records = duplicateStore.get(key);

  if (!records) {
    records = [];
    duplicateStore.set(key, records);
  }

  // Remove old records outside the window
  const windowStart = now - config.windowMs;
  records = records.filter((record) => record.timestamp > windowStart);
  duplicateStore.set(key, records);

  // Check for duplicate
  const duplicate = records.find(
    (record) => record.contentHash === contentHash,
  );

  if (duplicate) {
    logger.warn("Duplicate content detected", {
      userId,
      actionType: config.actionType,
      contentHash,
      lastPostedAt: new Date(duplicate.timestamp).toISOString(),
    });

    return {
      isDuplicate: true,
      lastPostedAt: new Date(duplicate.timestamp),
    };
  }

  // Record this content
  records.push({
    contentHash,
    timestamp: now,
  });

  logger.debug("Content uniqueness check passed", {
    userId,
    actionType: config.actionType,
    contentHash,
  });

  return {
    isDuplicate: false,
  };
}

/**
 * Clear duplicate records for a user and action type
 */
export function clearDuplicates(userId: string, actionType: string): void {
  const key = `${userId}:${actionType}`;
  duplicateStore.delete(key);
  logger.info("Duplicate records cleared", { userId, actionType });
}

/**
 * Clear all duplicate records
 */
export function clearAllDuplicates(): void {
  duplicateStore.clear();
  logger.info("All duplicate records cleared");
}

/**
 * Cleanup old duplicate records periodically
 */
export function cleanupDuplicates(): void {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes (longer than any window)

  let cleanedCount = 0;

  for (const [key, records] of duplicateStore.entries()) {
    // Filter out old records
    const validRecords = records.filter(
      (record) => now - record.timestamp < maxAge,
    );

    if (validRecords.length === 0) {
      duplicateStore.delete(key);
      cleanedCount++;
    } else if (validRecords.length < records.length) {
      duplicateStore.set(key, validRecords);
    }
  }

  if (cleanedCount > 0) {
    logger.info("Cleaned up old duplicate records", {
      cleanedCount,
      totalRemaining: duplicateStore.size,
    });
  }
}

/**
 * Get statistics about duplicate detection
 */
export function getDuplicateStats(): {
  totalUsers: number;
  totalRecords: number;
  recordsByType: Record<string, number>;
} {
  const stats = {
    totalUsers: duplicateStore.size,
    totalRecords: 0,
    recordsByType: {} as Record<string, number>,
  };

  for (const [key, records] of duplicateStore.entries()) {
    const actionType = key.split(":")[1] || "unknown";
    stats.totalRecords += records.length;
    stats.recordsByType[actionType] =
      (stats.recordsByType[actionType] || 0) + records.length;
  }

  return stats;
}

// Run cleanup every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(cleanupDuplicates, 5 * 60 * 1000);
}
