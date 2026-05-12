/**
 * Shared environment variable utilities.
 */
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "y", "on", "enabled"]);

export function isTruthyEnvValue(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return TRUTHY_ENV_VALUES.has(normalized);
}
