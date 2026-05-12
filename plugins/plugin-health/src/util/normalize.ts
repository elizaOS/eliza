/**
 * Minimal value-normalisation helpers used inside plugin-health.
 *
 * Reproduces only the helpers that the moved health-bridge / health-connectors
 * / service-normalize-health files actually call. Kept small and dependency-
 * free so plugin-health stays decoupled from app-lifeops' larger
 * `service-normalize.ts` family.
 *
 * Behaviour matches `app-lifeops/src/lifeops/service-normalize.ts` exactly.
 */

export class HealthNormalizationError extends Error {
  public readonly status: number;
  public readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export function fail(status: number, message: string, code?: string): never {
  throw new HealthNormalizationError(status, message, code);
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(400, `${field} must be a non-empty string`);
  }
  return (value as string).trim();
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeOptionalBoolean(
  value: unknown,
  _field: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  return undefined;
}

export function normalizeOptionalIsoString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    fail(400, `${field} must be an ISO string`);
  }
  const trimmed = (value as string).trim();
  if (trimmed.length === 0) return undefined;
  if (Number.isNaN(Date.parse(trimmed))) {
    fail(400, `${field} must be a valid ISO timestamp`);
  }
  return trimmed;
}

export function normalizeOptionalFiniteNumber(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  fail(400, `${field} must be a finite number`);
}
