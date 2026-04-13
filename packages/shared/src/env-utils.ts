/**
 * Shared environment variable utilities.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Returns true when value is a commonly-accepted truthy env string
 * (`1`, `true`, `yes`, `on` — case-insensitive, trimmed).
 */
export function isTruthyEnvValue(value: string | undefined): boolean {
  if (value == null) return false;
  return TRUTHY.has(value.trim().toLowerCase());
}
