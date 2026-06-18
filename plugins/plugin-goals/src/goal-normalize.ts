/**
 * Self-contained input-normalization helpers for the goals back-end.
 *
 * These mirror the small subset of `@elizaos/plugin-personal-assistant`'s
 * `service-normalize` / `service-helpers-misc` helpers that the goal CRUD code
 * actually used. They are reproduced here (rather than imported) so
 * `@elizaos/plugin-goals` carries no dependency on plugin-personal-assistant.
 * `fail` throws a {@link GoalsServiceError} carrying an HTTP status, which the
 * action and route layers map to client-facing responses.
 */

import type { IAgentRuntime } from "@elizaos/core";

/** Error carrying an HTTP status for goals back-end failures. */
export class GoalsServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "GoalsServiceError";
  }
}

export function goalsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fail(status: number, message: string, code?: string): never {
  throw new GoalsServiceError(status, message, code);
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return { ...value };
}

export function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value };
}

export function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, field);
}

export function normalizeNullableRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireRecord(value, field);
}

export function mergeMetadata(
  current: Record<string, unknown>,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  const merged = {
    ...current,
    ...cloneRecord(updates),
  };
  if (
    typeof merged.privacyClass !== "string" ||
    merged.privacyClass.trim().length === 0
  ) {
    merged.privacyClass = "private";
  }
  if (merged.privacyClass === "private") {
    merged.publicContextBlocked = true;
  }
  return merged;
}
