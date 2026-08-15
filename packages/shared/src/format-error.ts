/**
 * Browser-safe error formatting helpers.
 *
 * `formatError` is the canonical `@elizaos/core` implementation, published on
 * `@elizaos/core/client-public` so the app renderer does not pull the prebuilt
 * core browser blob. Do not import the bare `@elizaos/core` barrel here, and
 * do not reach into `packages/core/src`.
 *
 * `formatErrorWithStack` returns the stack when available, falling back to
 * the message. Use this only where the stack is genuinely useful (debug
 * logs, plugin crash diagnostics).
 */

export { formatError } from "@elizaos/core/client-public";

export function formatErrorWithStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
