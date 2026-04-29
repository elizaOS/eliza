/**
 * Browser-safe error formatting helpers.
 *
 * `formatError` returns the human-readable message for `Error` instances and
 * `String(value)` for everything else. The dominant idiom across the
 * codebase — used in log lines and short user-facing surfaces.
 *
 * `formatErrorWithStack` returns the stack when available, falling back to
 * the message. Use this only where the stack is genuinely useful (debug
 * logs, plugin crash diagnostics).
 */

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatErrorWithStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
