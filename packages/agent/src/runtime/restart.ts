/**
 * Restart infrastructure for Eliza — thin re-export of `@elizaos/shared/restart`.
 *
 * The single source of truth lives in `@elizaos/shared` (browser-safe, no-op
 * default). This module preserves the historical import path used inside the
 * agent package so existing imports keep working.
 *
 * Each host environment is responsible for registering its own handler at
 * startup via {@link setRestartHandler}:
 *
 *   - **CLI**: registers a handler that exits with {@link RESTART_EXIT_CODE}
 *     (75). The runner script (`eliza/packages/app-core/scripts/run-node.mjs`)
 *     catches this, rebuilds if source files changed, and relaunches.
 *   - **Dev-server / API**: registers a handler that stops the current
 *     runtime, creates a new one, and hot-swaps references.
 *   - **Desktop app**: registers a handler that calls `AgentManager.restart()`.
 *
 * @module restart
 */

export {
  RESTART_EXIT_CODE,
  setRestartHandler,
  requestRestart,
  type RestartHandler,
} from "@elizaos/shared";
