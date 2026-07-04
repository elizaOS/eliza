/**
 * Scheduled-task host execution profile contracts.
 *
 * What kind of host execution environment a scheduled task needs at fire
 * time. Shared between the scheduling runner (@elizaos/plugin-scheduling),
 * which consults it against the host's capabilities, and the host-capability
 * probe (@elizaos/app-core), which reports which profiles the current host
 * can satisfy. Both sides import this single definition so the runner and the
 * probe agree on the exact profile set without a cast. Pure types only — the
 * probe logic and runner behaviour live in their respective packages.
 *
 * - `foreground`:   requires the app foregrounded. Anything that would block
 *                   the UI thread or needs the user present.
 * - `bg-light-30s`: bookkeeping that fits in ~30s. Safe in iOS
 *                   BGAppRefreshTask windows; no LLM action.
 * - `bg-heavy-fgs`: needs an Android foreground service OR an iOS
 *                   BGProcessingTask. Can run LLM inference. Long but bounded.
 * - `notify-only`:  deliver a local notification; the user's tap opens the app
 *                   in foreground where the real work runs.
 */

export const TASK_EXECUTION_PROFILES = [
	'foreground',
	'bg-light-30s',
	'bg-heavy-fgs',
	'notify-only',
] as const;

export type TaskExecutionProfile = (typeof TASK_EXECUTION_PROFILES)[number];

/**
 * Default profile assumed when a persisted task has no `executionProfile`
 * column (back-compat for tasks written before this field landed). Foreground
 * is the safest default — the runner downgrades to notify-only if even that
 * isn't available.
 */
export const DEFAULT_TASK_EXECUTION_PROFILE: TaskExecutionProfile = 'foreground';
