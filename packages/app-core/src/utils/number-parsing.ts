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
export function parsePositiveInteger(
  value: string | null | undefined,
  fallback?: number,
): number | undefined;
export function parsePositiveInteger(
  value: string | null | undefined,
  fallback?: number,
): number | undefined {
  const raw = sanitizeNumericText(value);
  if (!raw) return normalizeFallback(fallback);

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return normalizeFallback(fallback);

  return Math.max(1, Math.floor(parsed));
}

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
export function parseClampedFloat(
  value: string | null | undefined,
  options: ParseClampedNumberOptions = {},
): number | undefined {
  const raw = sanitizeNumericText(value);
  if (!raw) return normalizeFallback(options.fallback);

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return normalizeFallback(options.fallback);

  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Parse an integer and optionally clamp it to the provided bounds.
 */
export function parseClampedInteger(
  value: string | null | undefined,
  options: ParseClampedIntegerOptions & { fallback: number },
): number;
export function parseClampedInteger(
  value: string | null | undefined,
  options?: ParseClampedIntegerOptions,
): number | undefined;
export function parseClampedInteger(
  value: string | null | undefined,
  options: ParseClampedIntegerOptions = {},
): number | undefined {
  const raw = sanitizeNumericText(value);
  if (!raw) return normalizeFallback(options.fallback);

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return normalizeFallback(options.fallback);

  const min = options.min;
  if (min !== undefined && parsed < min) return min;

  const max = options.max;
  if (max !== undefined && parsed > max) return max;

  return parsed;
}
