/**
 * Shared error-formatting utilities for global process handlers.
 *
 * The implementations now live in `@elizaos/shared` (`error-classification.ts`)
 * so the agent package and the on-device bridges can reuse them without an
 * `app-core → agent` cycle. Re-exported here so existing importers
 * (`run-main.ts`, `dev-server.ts`) keep resolving.
 */
export {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "@elizaos/shared";
