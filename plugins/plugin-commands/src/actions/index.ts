/**
 * Command action layer (#8790).
 *
 * Exports the deterministic command handlers, the per-conversation settings
 * store, the dispatch helper (used by the pre-LLM gate and connectors), and the
 * registered `*_COMMAND` actions.
 */

import { createCommandActions } from "./command-actions";
import { DETERMINISTIC_COMMAND_KEYS } from "./handlers";

export * from "./command-actions";
export * from "./command-settings";
export * from "./dispatch";
export * from "./handlers";
export * from "./shortcuts";

/**
 * The deterministic command actions for the built-in deterministic commands. Built
 * from the default registry so they can be registered statically on the plugin;
 * request-time command resolution reads the per-runtime store directly.
 */
export const commandActions = createCommandActions([
	...DETERMINISTIC_COMMAND_KEYS,
]);
