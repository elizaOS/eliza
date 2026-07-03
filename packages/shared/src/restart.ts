/**
 * Restart infrastructure — browser-safe version.
 *
 * The host environment (CLI, desktop, dev-server) must call
 * setRestartHandler() at startup to provide a real implementation.
 * The default leaves restart requests unhandled so this module can be safely
 * imported in browsers.
 *
 * @module restart
 */
import restartExitCodeDefinition from "./restart-exit-code.json" with {
  type: "json",
};

/**
 * Special exit code that tells the CLI runner to restart the process.
 */
export const RESTART_EXIT_CODE = restartExitCodeDefinition.restartExitCode;

/**
 * A function invoked when a restart is requested.
 */
export type RestartHandler = (reason?: string) => void | Promise<void>;

// Browser-safe default. Server hosts register a real handler.
let _handler: RestartHandler = () => {};

/**
 * Replace the active restart handler.
 */
export function setRestartHandler(handler: RestartHandler): void {
  _handler = handler;
}

/**
 * Trigger a restart. Delegates to whatever handler is currently registered.
 */
export function requestRestart(reason?: string): void | Promise<void> {
  return _handler(reason);
}
