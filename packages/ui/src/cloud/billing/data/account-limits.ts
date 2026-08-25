/**
 * Validates and loads the authenticated Cloud account-limits snapshot.
 * The parser treats the HTTP payload as untrusted, preserves exact byte
 * strings, and rejects contradictory or incomplete limits instead of
 * fabricating usable values for the billing UI.
 */

import type {
  AccountLimitsSnapshot,
  CountedLimitItem,
  InferenceRateLimitItem,
  LimitItemState,
  SandboxCreateLimitItem,
  SandboxLimitItem,
  StorageLimitItem,
} from "@elizaos/cloud-shared/lib/services/account-limits-snapshot";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import { useSessionAuth } from "../../lib/use-session-auth";

export type { AccountLimitsSnapshot };

const ACCOUNT_LIMITS_PATH = "/api/v1/billing/limits";
const INVALID_RESPONSE_MESSAGE = "Account limits response is invalid.";
const LIMIT_STATES = new Set<LimitItemState>([
  "available",
  "at-limit",
  "over-limit",
  "unavailable",
]);
const DECIMAL_BYTES = /^(0|[1-9]\d*)$/;

type ReadyLimitState = Exclude<LimitItemState, "unavailable">;

function invalidResponse(): never {
  throw new Error(INVALID_RESPONSE_MESSAGE);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidResponse();
  }
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidResponse();
  }
  return value;
}

function limitState(value: unknown): LimitItemState {
  if (typeof value !== "string" || !LIMIT_STATES.has(value as LimitItemState)) {
    return invalidResponse();
  }
  return value as LimitItemState;
}

function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidResponse();
  }
  return value;
}

function positiveLimit(value: unknown): number {
  const parsed = safeCount(value);
  if (parsed === 0) return invalidResponse();
  return parsed;
}

function classifiedState(used: number, limit: number): ReadyLimitState {
  if (used > limit) return "over-limit";
  if (used === limit) return "at-limit";
  return "available";
}

function parseCountedLimit(value: unknown): CountedLimitItem {
  const record = asRecord(value);
  const source = nonEmptyString(record.source);
  const state = limitState(record.state);

  if (state === "unavailable") {
    if (hasOwn(record, "used") || hasOwn(record, "limit")) {
      return invalidResponse();
    }
    return {
      source,
      state,
      reason: nonEmptyString(record.reason),
    };
  }

  if (hasOwn(record, "reason")) return invalidResponse();
  const used = safeCount(record.used);
  const limit = positiveLimit(record.limit);
  if (classifiedState(used, limit) !== state) return invalidResponse();

  return { source, state, used, limit };
}

function parseSandboxCreateLimit(
  value: unknown,
  used: number | undefined,
): SandboxCreateLimitItem {
  const record = asRecord(value);
  const state = limitState(record.state);

  if (state === "unavailable") {
    if (hasOwn(record, "limit")) return invalidResponse();
    return { state, reason: nonEmptyString(record.reason) };
  }

  if (used === undefined || hasOwn(record, "reason")) {
    return invalidResponse();
  }
  const limit = positiveLimit(record.limit);
  if (classifiedState(used, limit) !== state) return invalidResponse();
  return { state, limit };
}

function parseSandboxLimit(value: unknown): SandboxLimitItem {
  const record = asRecord(value);
  const source = nonEmptyString(record.source);
  const compatibilityState = limitState(record.state);
  const used = hasOwn(record, "used") ? safeCount(record.used) : undefined;
  const nonEagerCreate = parseSandboxCreateLimit(record.nonEagerCreate, used);
  const eagerManagedCreate = parseSandboxCreateLimit(
    record.eagerManagedCreate,
    used,
  );
  if (compatibilityState !== eagerManagedCreate.state) {
    return invalidResponse();
  }

  return {
    source,
    ...(used === undefined ? {} : { used }),
    nonEagerCreate,
    eagerManagedCreate,
    // The required compatibility state is retained only after proving it
    // agrees with the authoritative eager path. Other deprecated aliases are
    // deliberately ignored and never become UI truth.
    state: compatibilityState,
  };
}

interface ParsedDecimalBytes {
  text: string;
  value: bigint;
}

function decimalBytes(value: unknown): ParsedDecimalBytes {
  if (typeof value !== "string" || !DECIMAL_BYTES.test(value)) {
    return invalidResponse();
  }
  return { text: value, value: BigInt(value) };
}

function classifiedStorageState(used: bigint, limit: bigint): ReadyLimitState {
  if (used > limit) return "over-limit";
  if (used === limit) return "at-limit";
  return "available";
}

function parseStorageLimit(value: unknown): StorageLimitItem {
  const record = asRecord(value);
  const source = nonEmptyString(record.source);
  const state = limitState(record.state);

  if (state === "unavailable") {
    if (hasOwn(record, "bytesUsed") || hasOwn(record, "bytesLimit")) {
      return invalidResponse();
    }
    return { source, state, reason: nonEmptyString(record.reason) };
  }

  if (hasOwn(record, "reason")) return invalidResponse();
  const used = decimalBytes(record.bytesUsed);
  const limit = decimalBytes(record.bytesLimit);
  if (classifiedStorageState(used.value, limit.value) !== state) {
    return invalidResponse();
  }
  return {
    source,
    state,
    bytesUsed: used.text,
    bytesLimit: limit.text,
  };
}

function parseInferenceLimit(value: unknown): InferenceRateLimitItem {
  const record = asRecord(value);
  const source = nonEmptyString(record.source);
  const state = limitState(record.state);

  if (state === "unavailable") {
    if (hasOwn(record, "completionsRpm") || hasOwn(record, "embeddingsRpm")) {
      return invalidResponse();
    }
    return { source, state, reason: nonEmptyString(record.reason) };
  }

  // This endpoint reports configured caps only, so the backend has no usage
  // observation from which it could truthfully emit at-limit/over-limit.
  if (state !== "available" || hasOwn(record, "reason")) {
    return invalidResponse();
  }
  return {
    source,
    state,
    completionsRpm: positiveLimit(record.completionsRpm),
    embeddingsRpm: positiveLimit(record.embeddingsRpm),
  };
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== "string") return invalidResponse();
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    return invalidResponse();
  }
  return value;
}

/**
 * Parse the exact success envelope returned by `GET /api/v1/billing/limits`.
 * Every invalid shape throws the same client-safe error; payload values are
 * never interpolated into that error.
 */
export function parseAccountLimitsEnvelope(
  value: unknown,
): AccountLimitsSnapshot {
  const envelope = asRecord(value);
  if (envelope.success !== true) return invalidResponse();

  const data = asRecord(envelope.data);
  return {
    observedAt: isoTimestamp(data.observedAt),
    cloudCharacters: parseCountedLimit(data.cloudCharacters),
    agentSandboxes: parseSandboxLimit(data.agentSandboxes),
    containers: parseCountedLimit(data.containers),
    apps: parseCountedLimit(data.apps),
    storage: parseStorageLimit(data.storage),
    inferenceRateLimits: parseInferenceLimit(data.inferenceRateLimits),
  };
}

/**
 * Load one authenticated snapshot for the current user and confirmed tenant.
 * Automatic retries/focus/reconnect fetches stay disabled, while each mount
 * revalidates cached data and callers retain an explicit `refetch` action.
 */
export function useAccountLimitsSnapshot(
  organizationId: string | null | undefined,
) {
  const session = useSessionAuth();
  const userId = session.user?.id ?? null;
  const tenantId = organizationId?.trim() || null;
  const enabled =
    session.ready &&
    session.authenticated &&
    userId !== null &&
    userId.length > 0 &&
    tenantId !== null;

  return useQuery<AccountLimitsSnapshot>({
    queryKey: [
      "billing",
      "account-limits",
      "user",
      userId,
      "organization",
      tenantId,
    ],
    queryFn: async ({ signal }) =>
      parseAccountLimitsEnvelope(
        await api<unknown>(ACCOUNT_LIMITS_PATH, { signal }),
      ),
    enabled,
    staleTime: 0,
    retry: false,
    // A cached snapshot remains visible during this refresh, with an explicit
    // refreshing/stale state in the card instead of silently looking current.
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}
