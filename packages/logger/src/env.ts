/**
 * Minimal, dependency-free environment-variable reader for the logger.
 *
 * Provides typed string, boolean, and numeric environment variable readers
 * used during logger initialization (LOG_LEVEL, LOG_JSON_FORMAT, LOG_TIMESTAMPS,
 * SERVER_ID). Inlining these helpers keeps `@elizaos/logger` standalone without
 * depending on `@elizaos/core`. Node reads from `process.env`; browsers read from
 * `globalThis.window.ENV` / `globalThis.__ENV__` if populated by a host.
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

/** Read an environment variable as a boolean, recognizing true/1/yes/on and false/0/no/off. */
export function getEnvBoolean(key: string, defaultValue = false): boolean {
  const val = getEnv(key);
  if (val === undefined) return defaultValue;
  const normalized = val.trim().toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return defaultValue;
}

/** Read an environment variable as a parsed number, or defaultValue if unset/empty/invalid. */
export function getEnvNumber(
  key: string,
  defaultValue?: number,
): number | undefined {
  const val = getEnv(key);
  if (val === undefined) return defaultValue;
  const trimmed = val.trim();
  if (trimmed.length === 0) return defaultValue;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
