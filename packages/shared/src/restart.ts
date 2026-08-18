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
const DEFAULT_RESTART_HANDLER: RestartHandler = () => {};
let _handler: RestartHandler = DEFAULT_RESTART_HANDLER;

/**
 * Replace the active restart handler.
 */
export function setRestartHandler(handler: RestartHandler): void {
  _handler = typeof handler === "function" ? handler : DEFAULT_RESTART_HANDLER;
}

/**
 * Reset the active restart handler to the default noop function (for test cleanup).
 */
export function resetRestartHandlerForTests(): void {
  _handler = DEFAULT_RESTART_HANDLER;
}

/**
 * Trigger a restart. Delegates to whatever handler is currently registered.
 */
export function requestRestart(reason?: string): void | Promise<void> {
  const cleanReason = typeof reason === "string" ? reason.trim() : undefined;
  return _handler(cleanReason);
}
