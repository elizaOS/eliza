/**
 * Primitive input validators for the calendar service: string/boolean/number/
 * ISO/timezone/capability normalizers that trim and validate untrusted request
 * fields, failing with a `CalendarServiceError` (carrying an HTTP status) on
 * invalid input.
 */
import {
  LIFEOPS_CONNECTOR_MODES,
  LIFEOPS_CONNECTOR_SIDES,
  LIFEOPS_GOOGLE_CAPABILITIES,
  type LifeOpsConnectorMode,
  type LifeOpsConnectorSide,
  type LifeOpsGoogleCapability,
} from "@elizaos/shared";
import {
  CALENDAR_TIME_ZONE_ALIASES,
  isValidTimeZone,
  resolveDefaultTimeZone,
} from "./constants.js";
import { fail } from "./errors.js";

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    fail(400, `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    fail(400, `${field} is required`);
  }
  return normalized;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
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

export function normalizeIsoString(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    fail(400, `${field} must be a valid ISO datetime`);
  }
  return new Date(parsed).toISOString();
}

export function normalizeOptionalIsoString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeIsoString(value, field);
}

export function normalizeFiniteNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  fail(400, `${field} must be a finite number`);
}

export function normalizeOptionalMinutes(
  value: unknown,
  field: string,
): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const minutes = Math.trunc(normalizeFiniteNumber(value, field));
  if (minutes < 0) {
    fail(400, `${field} must be zero or greater`);
  }
  return minutes;
}

function normalizeEnumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  if (
    fallback !== undefined &&
    (value === undefined || value === null || value === "")
  ) {
    return fallback;
  }
  const text = requireNonEmptyString(value, field) as T;
  if (!allowed.includes(text)) {
    fail(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return text;
}

export function normalizeValidTimeZone(
  value: unknown,
  field: string,
  fallback: string = resolveDefaultTimeZone(),
): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    fail(400, `${field} must be a valid IANA time zone`);
  }
  const candidate = value.trim();
  if (candidate.length === 0) {
    return fallback;
  }
  const normalized =
    CALENDAR_TIME_ZONE_ALIASES[candidate.toLowerCase()] ?? candidate;
  if (!isValidTimeZone(normalized)) {
    fail(400, `${field} must be a valid IANA time zone`);
  }
  return normalized;
}

export function normalizeOptionalConnectorMode(
  value: unknown,
  field: string,
): LifeOpsConnectorMode | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeEnumValue(value, field, LIFEOPS_CONNECTOR_MODES);
}

export function normalizeOptionalConnectorSide(
  value: unknown,
  field: string,
): LifeOpsConnectorSide | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeEnumValue(value, field, LIFEOPS_CONNECTOR_SIDES);
}

export function normalizeGoogleCapabilities(
  value: Iterable<unknown> | undefined,
): LifeOpsGoogleCapability[] {
  const allowed = new Set<LifeOpsGoogleCapability>(LIFEOPS_GOOGLE_CAPABILITIES);
  const normalized: LifeOpsGoogleCapability[] = [];
  const seen = new Set<LifeOpsGoogleCapability>();
  const source = value ? Array.from(value) : [];

  for (const candidate of source) {
    if (typeof candidate !== "string") continue;
    if (!allowed.has(candidate as LifeOpsGoogleCapability)) continue;
    const capability = candidate as LifeOpsGoogleCapability;
    if (seen.has(capability)) continue;
    seen.add(capability);
    normalized.push(capability);
  }

  if (!seen.has("google.basic_identity")) {
    normalized.unshift("google.basic_identity");
  }

  return normalized;
}
