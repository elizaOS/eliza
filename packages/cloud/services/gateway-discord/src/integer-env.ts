/**
 * Provides the gateway's shared lexical boundary for integer environment values.
 * Callers retain ownership of setting-specific range validation.
 */

/** Parses one complete safe decimal integer while preserving legacy signs. */
export function parseIntegerEnv(
  name: string,
  defaultValue: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env[name];
  if (value === undefined) return defaultValue;
  const trimmed = value.trim();
  const parsed = /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Invalid ${name} environment variable: "${value}" is not a valid integer`,
    );
  }
  return parsed;
}

/** Applies a caller-owned lower bound after shared lexical validation. */
export function parseIntegerEnvAtLeast(
  name: string,
  defaultValue: number,
  minValue: number = 1,
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = parseIntegerEnv(name, defaultValue, env);
  if (parsed < minValue) {
    throw new Error(
      `Invalid ${name} environment variable: ${parsed} is below minimum value of ${minValue}`,
    );
  }
  return parsed;
}
