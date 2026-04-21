export interface ParsePositiveNumberOptions {
  fallback?: number;
  floor?: boolean;
}

export interface ParseClampedNumberOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

export interface ParseClampedIntegerOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

function sanitizeNumericText(value: string | null | undefined): string {
  return value == null ? "" : value.trim();
}

function normalizeFallback(fallback: number | undefined): number | undefined {
  return Number.isFinite(fallback) ? fallback : undefined;
}

/**
 * Parse a positive integer.
 *
 * - trims whitespace
 * - returns `fallback` when missing/invalid/non-finite/<=0
 * - floors the value so `12.9` becomes `12`
 */
export function parsePositiveInteger(
  value: string | null | undefined,
  fallback: number,
): number;
/**
 * Parse a positive floating-point value.
 *
 * - trims whitespace
 * - returns `fallback` when missing/invalid/non-finite/<=0
 */
export function parsePositiveFloat(
  value: string | null | undefined,
  options?: ParsePositiveNumberOptions,
): number | undefined {
  const raw = sanitizeNumericText(value);
  if (!raw) return normalizeFallback(options?.fallback);

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return normalizeFallback(options?.fallback);

  return options?.floor ? Math.floor(parsed) : parsed;
}

/**
 * Parse and clamp a numeric value.
 */
export function parseClampedFloat(
  value: string | null | undefined,
  options: ParseClampedNumberOptions & { fallback: number },
): number;
/**
 * Parse an integer and optionally clamp it to the provided bounds.
 */
export function parseClampedInteger(
  value: string | null | undefined,
  options: ParseClampedIntegerOptions & { fallback: number },
): number;