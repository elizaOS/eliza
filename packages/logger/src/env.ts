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

type EnvBag = Record<string, string | boolean | number | undefined>;

function browserEnvBag(): EnvBag {
  const g = globalThis as {
    window?: { ENV?: EnvBag };
    __ENV__?: EnvBag;
  };
  return { ...(g.window?.ENV ?? {}), ...(g.__ENV__ ?? {}) };
}

const isNode =
  typeof process !== "undefined" &&
  !!process.versions &&
  typeof process.versions.node === "string";

/** Read an environment variable as a string, or `undefined` when unset. */
export function getEnv(key: string, defaultValue?: string): string | undefined {
  if (isNode) {
    return process.env[key] ?? defaultValue;
  }
  const value = browserEnvBag()[key];
  return value !== undefined ? String(value) : defaultValue;
}
