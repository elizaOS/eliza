/**
 * Owns the canonical operator configuration shared by both anonymous-session
 * mint routes, including the spend and lifetime safety bounds.
 */

import { logger } from "@/lib/utils/logger";

export const MAX_ANONYMOUS_EXPIRY_DAYS = 365;
export const MAX_ANONYMOUS_MESSAGE_LIMIT = 1000;

/**
 * Parses a canonical positive integer, retaining the default for absent values
 * and warning before configured invalid values fall back.
 */
export function parseAnonymousPositiveIntEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
  max: number,
  scope: "anonymous-session" | "create-anonymous-session",
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const raw = value.trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    logger.warn(
      `[${scope}] Invalid ${name} (expected canonical positive integer), using default ${defaultValue} (received: ${value})`,
    );
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    logger.warn(
      `[${scope}] Invalid ${name} (expected 1..${max}), using default ${defaultValue} (received: ${value})`,
    );
    return defaultValue;
  }
  return parsed;
}
