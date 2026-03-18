/**
 * Restart infrastructure for Milady.
 *
 * Provides a pluggable restart handler so the restart action (and the
 * `/api/agent/restart` endpoint) work in every host environment:
 *
 *   - **CLI** (default): exits with {@link RESTART_EXIT_CODE} (75). The runner
 *     script (`scripts/run-node.mjs`) catches this, rebuilds if source files
 *     changed, and relaunches.
 *   - **Dev-server / API**: the host registers a handler via
 *     {@link setRestartHandler} that stops the current runtime, creates a new
 *     one, and hot-swaps references.
 *   - **Electron app**: the host registers a handler that calls
 *     `AgentManager.restart()`.
 *
 * @module restart
 */

import process from "node:process";

/**
 * Special exit code that tells the CLI runner to restart the process.
 * Must stay in sync with `RESTART_EXIT_CODE` in `scripts/run-node.mjs`.
 */
export const RESTART_EXIT_CODE = 75;

/**
 * A function invoked when a restart is requested.
 *
 * Return a Promise if the restart involves async work (stopping the runtime,
 * creating a new one, etc.). The restart action waits for this to settle
 * before confirming to the user.
 */
export type RestartHandler = (reason?: string) => void | Promise<void>;

// Default handler: exit the process so the CLI runner can relaunch.
let _handler: RestartHandler = () => {
  process.exit(RESTART_EXIT_CODE);
};

/**
 * Replace the active restart handler.
 *
 * Call this at startup in non-CLI environments (dev-server, Electron) to
 * provide an in-process restart strategy.
 */
export function setRestartHandler(handler: RestartHandler): void {
  _handler = handler;
}

/**
 * Trigger a restart.  Delegates to whatever handler is currently registered.
 *
 * Safe to call from the restart action, the API endpoint, or any other code
 * that needs to bounce the agent.
 */
export function requestRestart(reason?: string): void | Promise<void> {
  return _handler(reason);
}
