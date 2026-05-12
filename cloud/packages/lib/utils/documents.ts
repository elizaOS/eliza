/**
 * Shared utilities for document file processing.
 * Used across pre-upload, submit, and processing services.
 */

import { logger } from "@/lib/utils/logger";
import { isValidUUID } from "@/lib/utils/validation";

// Re-export for backward compatibility
export { isValidUUID } from "@/lib/utils/validation";

/**
 * Structured log marker for orphaned blobs.
 * This constant allows easy searching/filtering in log aggregation systems.
 */
const ORPHANED_BLOB_LOG_MARKER = "[ORPHANED_BLOB]";

export interface OrphanedBlobInfo {
  blobUrl: string;
  userId?: string;
  reason: "cleanup_failed" | "partial_upload_failure" | "expired_pending" | "unknown";
  originalError?: string;
  timestamp: number;
}

/**
 * Tracks an orphaned blob for later cleanup.
 *
 * This function logs orphaned blobs in a structured format that can be:
 * 1. Monitored via log aggregation (search for "[ORPHANED_BLOB]")
 * 2. Parsed by a future cleanup cron job
 * 3. Used to set up alerts for high orphan rates
 *
 * Future improvement: Store in database table for reliable cleanup scheduling.
 *
 * @param info - Information about the orphaned blob.
 */
export function trackOrphanedBlob(info: OrphanedBlobInfo): void {
  // Log at error level to ensure it's always captured, even without verbose logging
  logger.error(ORPHANED_BLOB_LOG_MARKER, {
    type: "orphaned_blob",
    blobUrl: info.blobUrl,
    userId: info.userId,
    reason: info.reason,
    originalError: info.originalError,
    timestamp: info.timestamp,
    isoTimestamp: new Date(info.timestamp).toISOString(),
  });
}

/**
 * Tracks multiple orphaned blobs from a batch operation.
 *
 * @param blobs - Array of orphaned blob information.
 * @param batchContext - Optional context about the batch operation.
 */
export function trackOrphanedBlobBatch(
  blobs: OrphanedBlobInfo[],
  batchContext?: { operation: string; userId?: string },
): void {
  if (blobs.length === 0) return;

  // Log summary at error level for monitoring
  logger.error(`${ORPHANED_BLOB_LOG_MARKER}_BATCH`, {
    type: "orphaned_blob_batch",
    count: blobs.length,
    operation: batchContext?.operation,
    userId: batchContext?.userId,
    blobUrls: blobs.map((b) => b.blobUrl),
    timestamp: Date.now(),
  });

  // Also log individual entries for detailed tracking
  for (const blob of blobs) {
    trackOrphanedBlob(blob);
  }
}

/**
 * Extracts the user ID from a pre-upload blob URL path.
 * Blob paths follow the format: documents-pre-upload/{userId}/{timestamp}-{filename}
 *
 * SECURITY: Validates that the extracted userId is a valid UUID format to prevent
 * path traversal attacks (e.g., "../../../etc/passwd").
 *
 * @param url - The blob URL to extract the user ID from.
 * @returns The user ID if valid, null otherwise.
 */
export function extractUserIdFromBlobPath(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    // Expected format: documents-pre-upload/{userId}/{timestamp}-{filename}
    if (pathParts.length >= 3 && pathParts[0] === "documents-pre-upload") {
      const userId = pathParts[1];
      // SECURITY: Validate userId is a proper UUID to prevent path traversal
      if (isValidUUID(userId)) {
        return userId;
      }
    }
    return null;
  } catch {
    return null;
  }
}
