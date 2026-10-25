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
  OrganizationSubscriptionSnapshot,
  SubscriptionCancellationBlockerCode,
  SubscriptionCancellationControlSnapshot,
} from "@elizaos/cloud-sdk/account-billing-snapshot";
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
  | "resourceType"
  | "resourceId"
  | "name"
  | "status"
  | "billingStatus"
  | "billingInterval"
  | "lastBilledAt"
  | "nextBillingAt"
  | "estimatedNextBillingAt"
  | "cancellationControl"
> & {
  ratePerHour: Observed<HourlyUsd>;
  estimatedRecurringComputeCostPerDay: Observed<DailyUsd>;
};

/** The organization Plus/Pro fields this UI renders; provider identifiers never reach it. */
export interface BillingSubscriptionView {
  subscriptionId: string;
  planKey: OrganizationSubscriptionSnapshot["planKey"];
  state: OrganizationSubscriptionSnapshot["state"];
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingPlanKey: OrganizationSubscriptionSnapshot["pendingPlanKey"];
  graceExpiresAt: string | null;
  dunningStartedAt: string | null;
  allowance: Observed<{
    granted: string;
    effectiveRemaining: Observed<string>;
  }>;
  cancellationControl: SubscriptionCancellationControlSnapshot;
}

export interface BillingSnapshotV2View {
  snapshotStartedAt: string;
  snapshotCompletedAt: string;
  balance: Observed<AccountBalanceSnapshot>;
  /** Unparseable subscription evidence is reported as unavailable, never as "no subscription". */
  subscription: Observed<BillingSubscriptionView>;
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

function nullableCanonicalIsoTimestamp(value: unknown): string | null {
  return value === null ? null : canonicalIsoTimestamp(value);
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

function nonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidResponse();
  }
  return Number(value);
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

  const resourceType = record.resourceType;
  const resourceId = nonEmptyString(record.resourceId);
  const control = asRecord(record.cancellationControl);
  const expectedDisplayAction =
    resourceType === "container" ? "stop" : "stop_compute";
  if (
    control.displayAction !== expectedDisplayAction ||
    control.method !== "POST" ||
    control.mode !== "stop" ||
    control.endpoint !==
      `/api/v1/billing/resources/${resourceId.toLowerCase()}/cancel?resourceType=${resourceType}` ||
    typeof control.eligible !== "boolean" ||
    !Array.isArray(control.blockers)
  ) {
    return invalidResponse();
  }
  const blockerSet = new Set<string>();
  const blockers = control.blockers.map((blocker) => {
    if (
      blocker !== "interactive_session_required" &&
      blocker !== "billing_account_ineligible" &&
      blocker !== "owner_or_admin_role_required"
    ) {
      return invalidResponse();
    }
    if (blockerSet.has(blocker)) return invalidResponse();
    blockerSet.add(blocker);
    return blocker;
  });
  if (control.eligible !== (blockers.length === 0)) {
    return invalidResponse();
  }

  return {
    resourceType,
    resourceId,
    name: nonEmptyString(record.name),
    status: nonEmptyString(record.status),
    billingStatus: nonEmptyString(record.billingStatus),
    billingInterval:
      record.billingInterval === "hour" || record.billingInterval === "day"
        ? record.billingInterval
        : invalidResponse(),
    lastBilledAt: nullableCanonicalIsoTimestamp(record.lastBilledAt),
    nextBillingAt: nullableCanonicalIsoTimestamp(record.nextBillingAt),
    estimatedNextBillingAt: nullableCanonicalIsoTimestamp(
      record.estimatedNextBillingAt,
    ),
    cancellationControl: {
      displayAction: expectedDisplayAction,
      method: "POST",
      mode: "stop",
      endpoint: control.endpoint,
      expectedLifecycleRevision: nonNegativeSafeInteger(
        control.expectedLifecycleRevision,
      ),
      eligible: control.eligible,
      blockers,
    },
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

const SUBSCRIPTION_STATES = new Set<string>([
  "pending",
  "incomplete",
  "active",
  "grace",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete_expired",
]);
const SUBSCRIPTION_BLOCKERS = new Set<string>([
  "interactive_session_required",
  "billing_account_ineligible",
  "owner_or_admin_role_required",
  "subscription_state_unsupported",
]);
const EXACT_ALLOWANCE_USD = /^(?:0|[1-9]\d*)\.\d{6}$/;

function planKey(value: unknown): "plus_monthly" | "pro_monthly" {
  return value === "plus_monthly" || value === "pro_monthly"
    ? value
    : invalidResponse();
}

function allowanceAmount(value: unknown): string {
  if (typeof value !== "string" || !EXACT_ALLOWANCE_USD.test(value)) {
    return invalidResponse();
  }
  return value;
}

function parseSubscriptionControl(
  value: unknown,
): SubscriptionCancellationControlSnapshot {
  const control = asRecord(value);
  const subscriptionId = nonEmptyString(control.subscriptionId);
  const undo = control.action === "undo";
  if (
    (control.action !== "cancel" && !undo) ||
    control.method !== "POST" ||
    control.endpoint !==
      (undo
        ? "/api/v1/subscriptions/cancel/undo"
        : "/api/v1/subscriptions/cancel") ||
    typeof control.eligible !== "boolean" ||
    !Array.isArray(control.blockers)
  ) {
    return invalidResponse();
  }
  const seen = new Set<string>();
  const blockers = control.blockers.map((blocker) => {
    if (
      typeof blocker !== "string" ||
      !SUBSCRIPTION_BLOCKERS.has(blocker) ||
      seen.has(blocker)
    ) {
      return invalidResponse();
    }
    seen.add(blocker);
    return blocker as SubscriptionCancellationBlockerCode;
  });
  const expected = control.expectedSubscriptionRevision;
  if (
    control.eligible !== (blockers.length === 0) ||
    !Number.isSafeInteger(expected) ||
    Number(expected) <= 0
  ) {
    return invalidResponse();
  }
  return {
    action: undo ? "undo" : "cancel",
    method: "POST",
    endpoint: undo
      ? "/api/v1/subscriptions/cancel/undo"
      : "/api/v1/subscriptions/cancel",
    subscriptionId,
    expectedSubscriptionRevision: Number(expected),
    eligible: control.eligible,
    blockers,
  };
}

function parseSubscription(value: unknown): BillingSubscriptionView {
  const record = asRecord(value);
  const state = record.state;
  if (typeof state !== "string" || !SUBSCRIPTION_STATES.has(state)) {
    return invalidResponse();
  }
  if (typeof record.cancelAtPeriodEnd !== "boolean") return invalidResponse();
  const subscriptionId = nonEmptyString(record.subscriptionId);
  const cancellationControl = parseSubscriptionControl(
    record.cancellationControl,
  );
  if (cancellationControl.subscriptionId !== subscriptionId) {
    return invalidResponse();
  }
  return {
    subscriptionId,
    planKey: planKey(record.planKey),
    state: state as BillingSubscriptionView["state"],
    currentPeriodEnd: canonicalIsoTimestamp(record.currentPeriodEnd),
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    pendingPlanKey:
      record.pendingPlanKey === null ? null : planKey(record.pendingPlanKey),
    graceExpiresAt: nullableCanonicalIsoTimestamp(record.graceExpiresAt),
    dunningStartedAt: nullableCanonicalIsoTimestamp(record.dunningStartedAt),
    allowance: parseObserved(record.allowance, (allowance) => {
      const fields = asRecord(allowance);
      return {
        granted: allowanceAmount(fields.granted),
        effectiveRemaining: parseObserved(
          fields.effectiveRemaining,
          allowanceAmount,
        ),
      };
    }),
    cancellationControl,
  };
}

function observedSubscription(
  value: unknown,
  fallbackObservedAt: string,
): Observed<BillingSubscriptionView> {
  try {
    return parseObserved(value, parseSubscription);
  } catch {
    // error-policy:J3 A subscription block from an older or drifted server must not hide the
    // rest of billing; it renders as explicitly unavailable, never as "no subscription".
    return {
      status: "unavailable",
      source: "billing-snapshot-v2",
      observedAt: fallbackObservedAt,
      error: { code: "subscription_snapshot_invalid", retryable: true },
    };
  }
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
    subscription: observedSubscription(v2.subscription, snapshotCompletedAt),
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
