/**
 * Browser-safe error formatting helpers.
 *
 * `formatError` is the single `@elizaos/core` implementation, also exported
 * from `@elizaos/core/client-public`. Shared re-exports the source file
 * directly so `packages/app/vite.config.ts` can load this module at config
 * eval time without resolving the client-public package subpath to an unbuilt
 * `dist/` (#18056 / #18704). Do not put a second function body here.
 *
 * `formatErrorWithStack` returns the stack when available, falling back to
 * the message. Use this only where the stack is genuinely useful (debug
 * logs, plugin crash diagnostics).
 */

export { formatError } from "../../core/src/utils/format-error.ts";

export function formatErrorWithStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
