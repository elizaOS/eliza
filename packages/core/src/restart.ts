/**
 * Explicit host restart infrastructure.
 *
 * The host environment (CLI, desktop, dev-server) must call
 * setRestartHandler() at startup to provide a real implementation.
 * Restart requests fail explicitly until the host installs a handler.
 *
 * @module restart
 */
import { ElizaError } from "./errors.js";
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

let _handler: RestartHandler | undefined;

/**
 * Replace the active restart handler.
 */
export function setRestartHandler(handler: RestartHandler): void {
	_handler = handler;
}

/**
 * Trigger a restart. Delegates to whatever handler is currently registered.
 */
/** Capture the installed host handler before admitting a deferred restart. */
export function requireRestartHandler(): RestartHandler {
	if (!_handler) {
		throw new ElizaError("The host has not installed a restart handler", {
			code: "RESTART_HANDLER_NOT_INSTALLED",
		});
	}
	return _handler;
}

export function requestRestart(reason?: string): void | Promise<void> {
	return requireRestartHandler()(reason);
}
