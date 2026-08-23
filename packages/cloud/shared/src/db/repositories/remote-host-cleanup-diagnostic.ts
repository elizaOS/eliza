export const MANAGED_CLEANUP_ERROR_PREVIEW_MAX_CHARS = 1_000;
const MANAGED_CLEANUP_ERROR_TRUNCATION_MARKER = "… [truncated]";

/**
 * Persist a deliberately bounded operator preview. Full upstream error bodies
 * stay in protected logs; the row makes truncation explicit instead of
 * silently presenting a prefix as the complete diagnostic.
 */
export function managedCleanupErrorPreview(message: string): string {
  if (message.length <= MANAGED_CLEANUP_ERROR_PREVIEW_MAX_CHARS) return message;
  return `${message.slice(
    0,
    MANAGED_CLEANUP_ERROR_PREVIEW_MAX_CHARS - MANAGED_CLEANUP_ERROR_TRUNCATION_MARKER.length,
  )}${MANAGED_CLEANUP_ERROR_TRUNCATION_MARKER}`;
}
