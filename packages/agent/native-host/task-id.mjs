/**
 * The task id rule for staged native hosts, which cannot import
 * `@elizaos/core`. It must equal `TASK_ID_PATTERN` from
 * `@elizaos/core/protocol`. Keep this module free of imports.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
