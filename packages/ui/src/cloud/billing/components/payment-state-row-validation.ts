/**
 * Full payment-state row validation shared by the billing list and detail
 * surfaces (#22966). Every field either surface renders is required by the
 * route contract: a partial payload is malformed and must become an explicit
 * error state, never a row that renders NaN amounts, torn-down components, or
 * fabricated policy output.
 */

import type { PaymentStateDisplay } from "./payment-activity-card";

/**
 * Type guard for a complete payment-state row from the transport. The list
 * card accepts rows into its ready state only through this guard, mirroring
 * the detail page: `id`/`paymentState` alone are not enough because rendering
 * dereferences identifiers, amounts, event fields, and reversal totals.
 */
export function isPaymentStateRow(
  value: unknown,
): value is PaymentStateDisplay {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    (row.surface === "payment_request" || row.surface === "checkout_order") &&
    typeof row.authorityId === "string" &&
    (row.receiptId === null || typeof row.receiptId === "string") &&
    typeof row.provider === "string" &&
    typeof row.amountCents === "number" &&
    Number.isFinite(row.amountCents) &&
    typeof row.currency === "string" &&
    typeof row.eventTime === "string" &&
    (row.eventTimeKind === "provider_settlement" ||
      row.eventTimeKind === "server_creation" ||
      row.eventTimeKind === "reversal_ledger_observation") &&
    typeof row.paymentState === "string" &&
    typeof row.cumulativeRefundedUsd === "number" &&
    Number.isFinite(row.cumulativeRefundedUsd) &&
    typeof row.cumulativeDisputedUsd === "number" &&
    Number.isFinite(row.cumulativeDisputedUsd) &&
    typeof row.cumulativeClawbackCredits === "number" &&
    Number.isFinite(row.cumulativeClawbackCredits) &&
    typeof row.reinstatedCredits === "number" &&
    Number.isFinite(row.reinstatedCredits) &&
    typeof row.unrecoveredShortfallUsd === "number" &&
    Number.isFinite(row.unrecoveredShortfallUsd) &&
    typeof row.disputeReinstated === "boolean" &&
    (row.policyEffect === null ||
      (typeof row.policyEffect === "object" &&
        row.policyEffect !== null &&
        typeof (row.policyEffect as Record<string, unknown>).status ===
          "string" &&
        typeof (row.policyEffect as Record<string, unknown>).reason ===
          "string")) &&
    (row.supportState === "none" || row.supportState === "contact_support")
  );
}
