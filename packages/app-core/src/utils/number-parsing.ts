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
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return normalizeFallback(fallback);
  }

  return Math.max(1, Math.floor(parsed));
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

  return options?.floor ? Math.floor(parsed) : parsed;
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

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return normalizeFallback(options.fallback);

  const { min, max } = options;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;

  return parsed;
}
