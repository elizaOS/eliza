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
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    // Match the canonical normalizer (packages/contracts, plugin-calendar):
    // trim and lowercase before comparing, and accept "1"/"0" string forms.
    // Anything else (including null, numbers, and other strings) is invalid
    // input and fails explicitly instead of being treated as absent.
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  fail(400, `${field} must be a boolean`);
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
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    fail(400, `${field} must be a valid ISO timestamp`);
  }
  // Match the canonical normalizer (packages/contracts, plugin-calendar):
  // return the parsed instant in canonical ISO form, not the caller's
  // spelling, so offset, date-only, and other parseable spellings of the
  // same instant are stored identically to every other LifeOps timestamp.
  return new Date(parsed).toISOString();
}

export function normalizeOptionalFiniteNumber(
  value: unknown,
  field: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  fail(400, `${field} must be a finite number`);
}
