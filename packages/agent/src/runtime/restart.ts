/**
 * Restart infrastructure for Eliza — thin re-export of `@elizaos/shared/restart`.
 *
 * The single source of truth lives in `@elizaos/shared` (browser-safe, no-op
 * default). This module preserves the historical import path used inside the
 * agent package so existing imports keep working.
 */
export {
  RESTART_EXIT_CODE,
  type RestartHandler,
  requestRestart,
  setRestartHandler,
} from "@elizaos/shared";
