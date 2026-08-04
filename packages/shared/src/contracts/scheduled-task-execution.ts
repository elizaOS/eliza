/**
 * Scheduled-task execution profiles shared by hosts and runners.
 * The scheduling runner and app-core capability probe consume this vocabulary
 * so persisted tasks and host capability reports cannot drift.
 */

export const TASK_EXECUTION_PROFILES = [
  "foreground",
  "bg-light-30s",
  "bg-heavy-fgs",
  "notify-only",
] as const;

export type TaskExecutionProfile = (typeof TASK_EXECUTION_PROFILES)[number];

/**
 * Default profile assumed when a persisted task has no `executionProfile`
 * column (back-compat for tasks written before this field landed). Foreground
 * is the safest default — the runner downgrades to notify-only if even that
 * isn't available.
 */
export const DEFAULT_TASK_EXECUTION_PROFILE: TaskExecutionProfile =
  "foreground";
