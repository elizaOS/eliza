/**
 * Browser-safe error formatting helpers.
 *
 * `formatError` is the canonical message extractor and lives in `@elizaos/core`;
 * it is re-exported here so existing `@elizaos/shared` importers keep resolving.
 * It returns the human-readable message for `Error` instances and
 * `String(value)` for everything else — the dominant idiom across the codebase.
 *
 * `formatErrorWithStack` returns the stack when available, falling back to
 * the message. Use this only where the stack is genuinely useful (debug
 * logs, plugin crash diagnostics).
 */

/**
 * Canonical message extractor (mirrors `@elizaos/core` `formatError`).
 * Kept local so browser/shared imports never pull the prebuilt core blob (#18056).
 */
export function formatError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    try {
      return Object.prototype.toString.call(error);
    } catch {
      return "[unstringifiable error]";
    }
  }
}

export function formatErrorWithStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
