/**
 * Browser-safe reader for the server-owned billing snapshot v2.
 *
 * The endpoint payload is untrusted at this boundary. Only the exact balance
 * and active-compute fields consumed by this UI are selected, and monetary
 * values remain base-10 strings from transport through render.
 */

import type {
  AccountBalanceSnapshot,
  ActiveComputeResourceSnapshot,
  ExactBillingValue,
  Observed,
} from "@elizaos/cloud-shared/types/account-billing-snapshot";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import { useSessionAuth } from "../../lib/use-session-auth";

export const BILLING_SNAPSHOT_V2_QUERY_KEY = [
  "billing",
  "limits",
  "v2",
] as const;

const BILLING_SNAPSHOT_PATH = "/api/v1/billing/limits";
const BILLING_SNAPSHOT_REFRESH_INTERVAL_MS = 30_000;
const INVALID_RESPONSE_MESSAGE = "Billing snapshot response is invalid.";
const EXACT_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const EXACT_NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;

type HourlyUsd = ExactBillingValue & {
  unit: "usd_per_hour";
  currency: "USD";
};

type DailyUsd = ExactBillingValue & {
  unit: "usd_per_day";
  currency: "USD";
};

export type BillingSnapshotResource = Pick<
  ActiveComputeResourceSnapshot,
  "resourceType" | "resourceId" | "name" | "status" | "billingStatus"
> & {
  ratePerHour: Observed<HourlyUsd>;
  estimatedRecurringComputeCostPerDay: Observed<DailyUsd>;
};

export interface BillingSnapshotV2View {
  snapshotStartedAt: string;
  snapshotCompletedAt: string;
  balance: Observed<AccountBalanceSnapshot>;
  activeCompute: {
    resources: Observed<BillingSnapshotResource[]>;
    estimatedRecurringComputeCostPerDay: Observed<DailyUsd>;
  };
}

function invalidResponse(): never {
  throw new Error(INVALID_RESPONSE_MESSAGE);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidResponse();
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidResponse();
  }
  return value;
}

function canonicalIsoTimestamp(value: unknown): string {
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

function exactDecimal(value: unknown): string {
  if (typeof value !== "string" || !EXACT_NON_NEGATIVE_DECIMAL.test(value)) {
    return invalidResponse();
  }
  return value;
}

function exactInteger(value: unknown): string {
  if (typeof value !== "string" || !EXACT_NON_NEGATIVE_INTEGER.test(value)) {
    return invalidResponse();
  }
  return value;
}

function exactUsdValue<Unit extends "usd" | "usd_per_hour" | "usd_per_day">(
  value: unknown,
  expectedUnit: Unit,
): ExactBillingValue & { unit: Unit; currency: "USD" } {
  const record = asRecord(value);
  if (record.unit !== expectedUnit || record.currency !== "USD") {
    return invalidResponse();
  }
  return {
    value: exactDecimal(record.value),
    unit: expectedUnit,
    currency: "USD",
  };
}

function parseObserved<T>(
  value: unknown,
  parseAvailable: (available: unknown) => T,
): Observed<T> {
  const record = asRecord(value);
  const source = nonEmptyString(record.source);
  const observedAt = canonicalIsoTimestamp(record.observedAt);

  switch (record.status) {
    case "available":
      return {
        status: "available",
        source,
        observedAt,
        value: parseAvailable(record.value),
      };
    case "unavailable": {
      const error = asRecord(record.error);
      if (typeof error.retryable !== "boolean") return invalidResponse();
      return {
        status: "unavailable",
        source,
        observedAt,
        error: {
          code: nonEmptyString(error.code),
          retryable: error.retryable,
        },
      };
    }
    case "unknown_policy": {
      if (!Array.isArray(record.blockedBy) || record.blockedBy.length === 0) {
        return invalidResponse();
      }
      return {
        status: "unknown_policy",
        source,
        observedAt,
        blockedBy: record.blockedBy.map(nonEmptyString),
      };
    }
    case "not_applicable":
      return {
        status: "not_applicable",
        source,
        observedAt,
        reason: nonEmptyString(record.reason),
      };
    default:
      return invalidResponse();
  }
}

function parseBalance(value: unknown): AccountBalanceSnapshot {
  const record = asRecord(value);
  return {
    balance: exactUsdValue(record.balance, "usd"),
    revision: exactInteger(record.revision),
  };
}

function parseResource(value: unknown): BillingSnapshotResource {
  const record = asRecord(value);
  if (
    record.resourceType !== "container" &&
    record.resourceType !== "agent_sandbox"
  ) {
    return invalidResponse();
  }

  return {
    resourceType: record.resourceType,
    resourceId: nonEmptyString(record.resourceId),
    name: nonEmptyString(record.name),
    status: nonEmptyString(record.status),
    billingStatus: nonEmptyString(record.billingStatus),
    ratePerHour: parseObserved(record.ratePerHour, (amount) =>
      exactUsdValue(amount, "usd_per_hour"),
    ),
    estimatedRecurringComputeCostPerDay: parseObserved(
      record.estimatedRecurringComputeCostPerDay,
      (amount) => exactUsdValue(amount, "usd_per_day"),
    ),
  };
}

function parseResources(value: unknown): BillingSnapshotResource[] {
  if (!Array.isArray(value)) return invalidResponse();
  const resources = value.map(parseResource);
  const identities = new Set<string>();
  for (const resource of resources) {
    const identity = `${resource.resourceType}:${resource.resourceId}`;
    if (identities.has(identity)) return invalidResponse();
    identities.add(identity);
  }
  return resources;
}

/** Parse the additive success envelope returned by GET /api/v1/billing/limits. */
export function parseBillingSnapshotV2Envelope(
  value: unknown,
): BillingSnapshotV2View {
  const envelope = asRecord(value);
  if (envelope.success !== true) return invalidResponse();

  const data = asRecord(envelope.data);
  if (data.schemaVersion !== 2) return invalidResponse();

  const v2 = asRecord(data.v2);
  const activeCompute = asRecord(v2.activeCompute);
  const snapshotStartedAt = canonicalIsoTimestamp(v2.snapshotStartedAt);
  const snapshotCompletedAt = canonicalIsoTimestamp(v2.snapshotCompletedAt);
  if (Date.parse(snapshotStartedAt) > Date.parse(snapshotCompletedAt)) {
    return invalidResponse();
  }

  return {
    snapshotStartedAt,
    snapshotCompletedAt,
    balance: parseObserved(v2.balance, parseBalance),
    activeCompute: {
      resources: parseObserved(activeCompute.resources, parseResources),
      estimatedRecurringComputeCostPerDay: parseObserved(
        activeCompute.estimatedRecurringComputeCostPerDay,
        (amount) => exactUsdValue(amount, "usd_per_day"),
      ),
    },
  };
}

/**
 * Read one authenticated snapshot for the current user and confirmed tenant.
 * The organization scopes only the cache key; the server derives authority
 * from authentication and never accepts a client-selected organization.
 */
export function useBillingSnapshotV2(
  organizationId: string | null | undefined,
) {
  const session = useSessionAuth();
  const userId = session.user?.id?.trim() || null;
  const tenantId = organizationId?.trim() || null;
  const enabled =
    session.ready &&
    session.authenticated &&
    userId !== null &&
    tenantId !== null;

  return useQuery<BillingSnapshotV2View>({
    queryKey: [
      ...BILLING_SNAPSHOT_V2_QUERY_KEY,
      "user",
      userId,
      "organization",
      tenantId,
    ],
    queryFn: async ({ signal }) =>
      parseBillingSnapshotV2Envelope(
        await api<unknown>(BILLING_SNAPSHOT_PATH, { signal }),
      ),
    enabled,
    staleTime: 0,
    retry: false,
    refetchInterval: BILLING_SNAPSHOT_REFRESH_INTERVAL_MS,
    refetchOnMount: "always",
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}
