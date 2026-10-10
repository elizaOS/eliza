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

class HealthNormalizationError extends Error {
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
  if (typeof value === "string") {
    // Match the canonical normalizer (packages/contracts, plugin-calendar):
    // trim and lowercase before comparing, and accept "1"/"0" string forms.
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  } else if (value === 1) {
    return true;
  } else if (value === 0) {
    return false;
  }
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
  if (value === "") return undefined;
  const trimmed = (value as string).trim();
  if (trimmed.length === 0) {
    // A blank string is not absent: the canonical normalizer rejects it with
    // 400 via requireNonEmptyString. Same defect class as #34687.
    fail(400, `${field} must be a non-empty string`);
  }
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
