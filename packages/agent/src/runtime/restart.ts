/**
 * Restart infrastructure for the agent runtime.
 *
 * Thin re-export over the browser-safe restart module in `@elizaos/shared`.
 * Hosts (CLI, desktop, dev-server) wire a real handler via
 * `setRestartHandler`; in-bundle agent code triggers it through
 * `requestRestart`. The same `RESTART_EXIT_CODE` is honoured by
 * `eliza/packages/app-core/scripts/run-node.mjs` so a restart bubbles up
 * cleanly to the supervisor process.
 *
 * Reference: `eliza/packages/shared/src/restart.ts` (source of truth).
 */

export {
	RESTART_EXIT_CODE,
	type RestartHandler,
	requestRestart,
	setRestartHandler,
} from "@elizaos/shared";
