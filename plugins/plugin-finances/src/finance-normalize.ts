/**
 * Self-contained input-normalization helpers for the finances back-end.
 *
 * These mirror the small subset of `@elizaos/plugin-personal-assistant`'s
 * `service-normalize` helpers that the finance code actually used. They are
 * reproduced here (rather than imported) so `@elizaos/plugin-finances` carries
 * no dependency on plugin-personal-assistant. `fail` throws a
 * {@link FinancesServiceError} carrying an HTTP status, which the action and
 * route layers map to client-facing responses.
 */

import type { IAgentRuntime } from "@elizaos/core";

/** Error carrying an HTTP status for finance back-end failures. */
export class FinancesServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "FinancesServiceError";
  }
}

export function financeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fail(status: number, message: string, code?: string): never {
  throw new FinancesServiceError(status, message, code);
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
