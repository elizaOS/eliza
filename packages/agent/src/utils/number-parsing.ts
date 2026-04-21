export interface ParseClampedIntegerOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

export interface ParseClampedNumberOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

export interface ParsePositiveNumberOptions {
  fallback?: number;
  floor?: boolean;
}

function sanitizeNumericText(value: string | null | undefined): string {
  return value == null ? "" : value.trim();
}

function normalizeFallback(fallback: number | undefined): number | undefined {
  return Number.isFinite(fallback) ? fallback : undefined;
}

export function parseClampedInteger(
  value: string | null | undefined,
  options: ParseClampedIntegerOptions & { fallback: number },
): number;
export function parsePositiveInteger(
  value: string | null | undefined,
  fallback: number,
): number;
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