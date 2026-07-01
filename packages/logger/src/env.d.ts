/**
 * Minimal, dependency-free environment-variable reader for the logger.
 *
 * The logger only needs to read a handful of string env vars at module-init
 * time (LOG_LEVEL, LOG_JSON_FORMAT, LOG_TIMESTAMPS, SERVER_ID). Inlining this
 * keeps `@elizaos/logger` standalone — it does not pull in `@elizaos/core`'s
 * environment/boolean utilities (and thus the rest of core). Node reads from
 * `process.env`; browsers read from `globalThis.window.ENV` / `globalThis.__ENV__`
 * if a host populated them, matching the core reader's browser behavior.
 */
/** Read an environment variable as a string, or `undefined` when unset. */
export declare function getEnv(key: string, defaultValue?: string): string | undefined;
//# sourceMappingURL=env.d.ts.map