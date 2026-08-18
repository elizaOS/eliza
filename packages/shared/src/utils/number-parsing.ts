/**
 * Numeric parsing helpers with optional fallback, flooring, and min/max clamping
 * for positive integers/floats. Used to coerce env vars and config values into
 * bounded numbers without scattering ad-hoc `Number()` + guard logic.
 */
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

export interface ParseCanonicalIntegerOptions {
  min?: number;
  max?: number;
  clamp?: boolean;
}

export type CanonicalIntegerResult = number | undefined | "invalid";

function sanitizeNumericText(value: string | null | undefined): string {
  return value == null ? "" : value.trim();
}

function normalizeFallback(fallback: number | undefined): number | undefined {
  return Number.isFinite(fallback) ? fallback : undefined;
}

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

  if (!/^\d+$/.test(raw)) {
    return normalizeFallback(fallback);
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : normalizeFallback(fallback);
}

export function parseNonNegativeInteger(
  value: string | null | undefined,
  fallback: number,
): number;
export function parseNonNegativeInteger(
  value: string | null | undefined,
  fallback?: number,
): number | undefined;
export function parseNonNegativeInteger(
  value: string | null | undefined,
  fallback?: number,
): number | undefined {
  const raw = sanitizeNumericText(value);
  if (!raw || !/^\d+$/.test(raw)) return normalizeFallback(fallback);

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : normalizeFallback(fallback);
}

/**
 * Parse an optional canonical unsigned decimal integer from an untrusted text
 * boundary. Empty input remains absent, while malformed or unsafe input is
 * distinguishable from omission so HTTP callers can return a 400 response.
 */
export function parseCanonicalInteger(
  value: string | null | undefined,
  options: ParseCanonicalIntegerOptions = {},
): CanonicalIntegerResult {
  const raw = sanitizeNumericText(value);
  if (!raw) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return "invalid";

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return "invalid";

  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new RangeError(
      "canonical integer bounds must be ordered safe integers",
    );
  }
  if (options.clamp) return Math.max(min, Math.min(max, parsed));
  return parsed < min || parsed > max ? "invalid" : parsed;
}

export function parsePositiveFloat(
  value: string | null | undefined,
  options?: ParsePositiveNumberOptions,
): number | undefined {
  const raw = sanitizeNumericText(value);
  if (!raw) return normalizeFallback(options?.fallback);

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return normalizeFallback(options?.fallback);
  }

  const result = options?.floor ? Math.floor(parsed) : parsed;
  return result > 0 ? result : normalizeFallback(options?.fallback);
}

export function parseClampedFloat(
  value: string | null | undefined,
  options: ParseClampedNumberOptions & { fallback: number },
): number;
export function parseClampedFloat(
  value: string | null | undefined,
  options?: ParseClampedNumberOptions,
): number | undefined;
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

  if (!/^[+-]?\d+$/.test(raw)) {
    return normalizeFallback(options.fallback);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return normalizeFallback(options.fallback);

  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  return Math.max(min, Math.min(max, parsed));
}
