/**
 * Validates linked-account inventory responses before UI state can consume them.
 *
 * The accounts endpoint may carry additional feature-detected metadata, but its
 * provider and linked-account fields are required and must fail closed.
 */

import {
  ElizaError,
  LINKED_ACCOUNT_ACCOUNT_SOURCES,
  LINKED_ACCOUNT_HEALTH_STATES,
  LINKED_ACCOUNT_PROVIDER_IDS,
  SERVICE_ROUTE_ACCOUNT_STRATEGIES,
} from "@elizaos/core";
import type { AccountsListResponse } from "./client-agent";

/** Stable classification for malformed account inventory responses. */
export const ACCOUNTS_RESPONSE_INVALID_CODE = "ACCOUNTS_RESPONSE_INVALID";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, expected: string): never {
  throw new ElizaError(
    `Invalid /api/accounts response at ${path}: expected ${expected}`,
    {
      code: ACCOUNTS_RESPONSE_INVALID_CODE,
      context: { path, expected },
    },
  );
}

function assertNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(path, "a non-empty string");
  }
}

function assertFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(path, "a finite number");
  }
}

function assertOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] !== undefined) {
    assertFiniteNumber(record[key], `${path}.${key}`);
  }
}

function assertOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    invalid(`${path}.${key}`, "a string");
  }
}

function isOneOf(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

function assertHealthDetail(value: unknown, path: string): void {
  if (!isRecord(value)) invalid(path, "an object");
  assertOptionalFiniteNumber(value, "until", path);
  assertOptionalString(value, "lastError", path);
  assertOptionalFiniteNumber(value, "lastChecked", path);
}

function assertUsage(value: unknown, path: string): void {
  if (!isRecord(value)) invalid(path, "an object");
  assertFiniteNumber(value.refreshedAt, `${path}.refreshedAt`);
  for (const key of ["sessionPct", "weeklyPct"] as const) {
    const percentage = value[key];
    if (percentage !== undefined) {
      assertFiniteNumber(percentage, `${path}.${key}`);
      if (percentage < 0 || percentage > 100) {
        invalid(`${path}.${key}`, "a percentage from 0 to 100");
      }
    }
  }
  assertOptionalFiniteNumber(value, "resetsAt", path);

  if (value.weeklyModelBuckets === undefined) return;
  if (!isRecord(value.weeklyModelBuckets)) {
    invalid(`${path}.weeklyModelBuckets`, "an object");
  }
  for (const [model, rawBucket] of Object.entries(value.weeklyModelBuckets)) {
    const bucketPath = `${path}.weeklyModelBuckets.${model}`;
    if (!model.trim() || !isRecord(rawBucket)) {
      invalid(bucketPath, "a model usage object");
    }
    assertFiniteNumber(rawBucket.pct, `${bucketPath}.pct`);
    if (rawBucket.pct < 0 || rawBucket.pct > 100) {
      invalid(`${bucketPath}.pct`, "a percentage from 0 to 100");
    }
    assertOptionalFiniteNumber(rawBucket, "resetsAt", bucketPath);
  }
}

function assertAccount(
  value: unknown,
  providerId: string,
  path: string,
): string {
  if (!isRecord(value)) invalid(path, "an object");
  assertNonEmptyString(value.id, `${path}.id`);
  if (!isOneOf(LINKED_ACCOUNT_PROVIDER_IDS, value.providerId)) {
    invalid(`${path}.providerId`, "a supported linked-account provider");
  }
  if (value.providerId !== providerId) {
    invalid(`${path}.providerId`, `the parent provider "${providerId}"`);
  }
  assertNonEmptyString(value.label, `${path}.label`);
  if (!isOneOf(LINKED_ACCOUNT_ACCOUNT_SOURCES, value.source)) {
    invalid(`${path}.source`, "oauth or api-key");
  }
  if (typeof value.enabled !== "boolean") {
    invalid(`${path}.enabled`, "a boolean");
  }
  assertFiniteNumber(value.priority, `${path}.priority`);
  assertFiniteNumber(value.createdAt, `${path}.createdAt`);
  if (!isOneOf(LINKED_ACCOUNT_HEALTH_STATES, value.health)) {
    invalid(`${path}.health`, "a supported linked-account health state");
  }
  if (typeof value.hasCredential !== "boolean") {
    invalid(`${path}.hasCredential`, "a boolean");
  }
  if (
    value.prioritySource !== undefined &&
    value.prioritySource !== "explicit" &&
    value.prioritySource !== "generated"
  ) {
    invalid(`${path}.prioritySource`, "explicit or generated");
  }

  for (const key of [
    "lastUsedAt",
    "lastPrimedAt",
    "subscriptionEndsAt",
  ] as const) {
    assertOptionalFiniteNumber(value, key, path);
  }
  for (const key of ["organizationId", "userId", "email"] as const) {
    assertOptionalString(value, key, path);
  }
  if (value.healthDetail !== undefined) {
    assertHealthDetail(value.healthDetail, `${path}.healthDetail`);
  }
  if (value.usage !== undefined) {
    assertUsage(value.usage, `${path}.usage`);
  }
  return value.id;
}

function assertAccountsListResponse(
  value: unknown,
): asserts value is AccountsListResponse {
  if (!isRecord(value)) invalid("response", "an object");
  if (!Array.isArray(value.providers)) {
    invalid("response.providers", "an array");
  }

  const providerIds = new Set<string>();
  for (const [providerIndex, rawProvider] of value.providers.entries()) {
    const path = `response.providers[${providerIndex}]`;
    if (!isRecord(rawProvider)) invalid(path, "an object");
    if (!isOneOf(LINKED_ACCOUNT_PROVIDER_IDS, rawProvider.providerId)) {
      invalid(`${path}.providerId`, "a supported linked-account provider");
    }
    if (providerIds.has(rawProvider.providerId)) {
      invalid(`${path}.providerId`, "a unique provider");
    }
    providerIds.add(rawProvider.providerId);
    if (!isOneOf(SERVICE_ROUTE_ACCOUNT_STRATEGIES, rawProvider.strategy)) {
      invalid(`${path}.strategy`, "a supported account strategy");
    }
    if (!Array.isArray(rawProvider.accounts)) {
      invalid(`${path}.accounts`, "an array");
    }

    const accountIds = new Set<string>();
    for (const [accountIndex, account] of rawProvider.accounts.entries()) {
      const accountPath = `${path}.accounts[${accountIndex}]`;
      const accountId = assertAccount(
        account,
        rawProvider.providerId,
        accountPath,
      );
      if (accountIds.has(accountId)) {
        invalid(`${accountPath}.id`, "a unique account id within its provider");
      }
      accountIds.add(accountId);
    }
  }
}

/** Parse an untrusted accounts response or throw before it reaches UI state. */
export function parseAccountsListResponse(
  value: unknown,
): AccountsListResponse {
  assertAccountsListResponse(value);
  return value;
}
