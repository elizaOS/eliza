/** Pure classification of typed subscription lifecycle failures shared by the queue consumer and recovery; no I/O. */
import { ElizaError } from "@elizaos/core";

/**
 * Typed lifecycle failures that retrying cannot fix: the provider object
 * requires policy no owner implements (discounts, tax, proration, plan or
 * schedule drift, unsupported statuses). Everything else stays retryable.
 */
const POLICY_FAILURES: Record<string, readonly string[] | "all"> = {
  SUBSCRIPTION_LIFECYCLE_UNSUPPORTED: "all",
  SUBSCRIPTION_LIFECYCLE_REOBSERVE: [
    "provider_identity_or_catalog_mismatch",
    "unsupported_provider_observation",
  ],
  SUBSCRIPTION_RENEWAL_UNAVAILABLE: [
    "unsupported_provider_shape_or_adjustment",
    "unsupported_canonical_invoice",
    "payment_invoice_or_catalog_identity_mismatch",
    "historical_catalog_binding_mismatch",
    "missing_recurring_line",
    "unsupported_source_or_period",
  ],
  SUBSCRIPTION_CANCELLATION_REOBSERVE: [
    "provider_identity_catalog_or_period_changed",
    "cancellation_schedule_not_confirmed",
    "unsupported_provider_observation",
    "customer_authority_unavailable",
  ],
  SUBSCRIPTION_DUNNING_UNAVAILABLE: ["unsupported_current_authority"],
  SUBSCRIPTION_RECONCILIATION_UNAVAILABLE: ["unsupported_live_status"],
};

export function typedFailure(error: unknown): { code: string; reason: string | null } | null {
  if (!(error instanceof ElizaError)) return null;
  const reason = error.context?.reason;
  return { code: error.code, reason: typeof reason === "string" ? reason : null };
}

/** Returns the stable incident reason for a policy failure, or null when the failure is retryable. */
export function subscriptionPolicyFailureReason(error: unknown): string | null {
  const failure = typedFailure(error);
  if (!failure) return null;
  const reasons = POLICY_FAILURES[failure.code];
  if (reasons === "all") return failure.reason ?? failure.code;
  return failure.reason && reasons?.includes(failure.reason)
    ? `${failure.code}:${failure.reason}`
    : null;
}
