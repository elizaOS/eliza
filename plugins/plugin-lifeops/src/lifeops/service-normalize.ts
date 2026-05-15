import { type IAgentRuntime, stringToUuid } from "@elizaos/core";
import type {
  LifeOpsContextPolicy,
  LifeOpsDomain,
  LifeOpsPrivacyClass,
  LifeOpsReminderUrgency,
  LifeOpsSubjectType,
  LifeOpsVisibilityScope,
} from "../contracts/index.js";
import {
  LIFEOPS_CONTEXT_POLICIES,
  LIFEOPS_DOMAINS,
  LIFEOPS_PRIVACY_CLASSES,
  LIFEOPS_REMINDER_URGENCY_LEVELS,
  LIFEOPS_SUBJECT_TYPES,
  LIFEOPS_VISIBILITY_SCOPES,
} from "../contracts/index.js";
import { isValidTimeZone, resolveDefaultTimeZone } from "./defaults.js";
import { LIFEOPS_TIME_ZONE_ALIASES } from "./service-constants.js";
import { LifeOpsServiceError } from "./service-types.js";

export function lifeOpsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fail(status: number, message: string, code?: string): never {
  throw new LifeOpsServiceError(status, message, code);
}

export function defaultOwnerEntityId(runtime: IAgentRuntime): string {
  return stringToUuid(`${requireAgentId(runtime)}-admin-entity`);
}

export function normalizeLifeOpsDomain(
  value: unknown,
  fallback: LifeOpsDomain,
): LifeOpsDomain {
  return normalizeEnumValue(
    value,
    "ownership.domain",
    LIFEOPS_DOMAINS,
    fallback,
  );
}

export function normalizeLifeOpsSubjectType(
  value: unknown,
  fallback: LifeOpsSubjectType,
): LifeOpsSubjectType {
  return normalizeEnumValue(
    value,
    "ownership.subjectType",
    LIFEOPS_SUBJECT_TYPES,
    fallback,
  );
}

export function normalizeLifeOpsVisibilityScope(
  value: unknown,
  fallback: LifeOpsVisibilityScope,
): LifeOpsVisibilityScope {
  return normalizeEnumValue(
    value,
    "ownership.visibilityScope",
    LIFEOPS_VISIBILITY_SCOPES,
    fallback,
  );
}

export function normalizeLifeOpsContextPolicy(
  value: unknown,
  fallback: LifeOpsContextPolicy,
): LifeOpsContextPolicy {
  return normalizeEnumValue(
    value,
    "ownership.contextPolicy",
    LIFEOPS_CONTEXT_POLICIES,
    fallback,
  );
}

export function requireAgentId(runtime: IAgentRuntime): string {
  const agentId = runtime.agentId;
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    fail(500, "agent runtime is missing agentId");
  }
  return agentId;
}

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

export function normalizePositiveInteger(
  value: unknown,
  field: string,
): number {
  const number = Math.trunc(normalizeFiniteNumber(value, field));
  if (number <= 0) {
    fail(400, `${field} must be greater than zero`);
  }
  return number;
}

export function normalizeOptionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Math.trunc(normalizeFiniteNumber(value, field));
  if (number < 0) {
    fail(400, `${field} must be zero or greater`);
  }
  return number;
}

export function normalizeOptionalFiniteNumber(
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return normalizeFiniteNumber(value, field);
}

export function normalizeEnumValue<T extends string>(
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
    LIFEOPS_TIME_ZONE_ALIASES[candidate.toLowerCase()] ?? candidate;
  if (!isValidTimeZone(normalized)) {
    fail(400, `${field} must be a valid IANA time zone`);
  }
  return normalized;
}

export function normalizePriority(value: unknown, current = 3): number {
  if (value === undefined) return current;
  const priority = Math.trunc(normalizeFiniteNumber(value, "priority"));
  if (priority < 1 || priority > 5) {
    fail(400, "priority must be between 1 and 5");
  }
  return priority;
}

export function normalizePrivacyClass(
  value: unknown,
  field = "privacyClass",
  current: LifeOpsPrivacyClass = "private",
): LifeOpsPrivacyClass {
  if (value === undefined) {
    return current;
  }
  return normalizeEnumValue(value, field, LIFEOPS_PRIVACY_CLASSES);
}

export function normalizePhoneNumber(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const normalized = `+${digits.slice(1).replace(/\D/g, "")}`;
    if (!/^\+\d{10,15}$/.test(normalized)) {
      fail(400, `${field} must be a valid E.164 phone number`);
    }
    return normalized;
  }
  const plainDigits = digits.replace(/\D/g, "");
  if (/^\d{10}$/.test(plainDigits)) {
    return `+1${plainDigits}`;
  }
  if (/^1\d{10}$/.test(plainDigits)) {
    return `+${plainDigits}`;
  }
  fail(400, `${field} must be a valid phone number`);
}

export function normalizeReminderUrgency(
  value: unknown,
): LifeOpsReminderUrgency {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "medium";
  }
  return normalizeEnumValue(value, "urgency", LIFEOPS_REMINDER_URGENCY_LEVELS);
}
