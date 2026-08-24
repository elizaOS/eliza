/**
 * Full payment-state row validation shared by the billing list and detail
 * surfaces (#22966). Every field either surface renders is required by the
 * route contract: a partial payload is malformed and must become an explicit
 * error state, never a row that renders NaN amounts, torn-down components, or
 * fabricated policy output.
 */

import type { PaymentStateDisplay } from "./payment-activity-card";

/**
 * The server's closed state vocabulary — a local mirror of
 * `PAYMENT_STATE_STATUSES` from cloud-shared payment-history, re-declared
 * here because `@elizaos/ui` deliberately does not import the cloud-shared
 * server bundle (same boundary rule as cloud-org-types.ts and
 * sandbox-status.ts). The compile-time `satisfies` assertion makes any drift
 * between this list and the `PaymentStateDisplay["paymentState"]` union a
 * build error instead of a silent validation hole.
 */
const PAYMENT_STATE_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "partially_refunded",
  "refunded",
  "dispute_withdrawn",
  "dispute_reinstated",
  "unavailable",
] as const satisfies readonly PaymentStateDisplay["paymentState"][];

const PAYMENT_STATE_SET: ReadonlySet<string> = new Set(PAYMENT_STATE_STATUSES);

/**
 * Type guard for a complete payment-state row from the transport. The list
 * card accepts rows into its ready state only through this guard, mirroring
 * the detail page: `id`/`paymentState` alone are not enough because rendering
 * dereferences identifiers, amounts, event fields, and reversal totals — and
 * value-shaped fields must be checked against their closed unions, not for
 * string-ness, or a payload claiming `paymentState: "paid"` or an unusable
 * `eventTime` would render an invented state or "Invalid Date".
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
    // A non-parsable timestamp renders as "Invalid Date" on both surfaces;
    // an unparsable value is malformed, not a ready row.
    Number.isFinite(new Date(row.eventTime).getTime()) &&
    (row.eventTimeKind === "provider_settlement" ||
      row.eventTimeKind === "server_creation" ||
      row.eventTimeKind === "reversal_ledger_observation") &&
    typeof row.paymentState === "string" &&
    PAYMENT_STATE_SET.has(row.paymentState) &&
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
        (row.policyEffect as Record<string, unknown>).status ===
          "unavailable" &&
        typeof (row.policyEffect as Record<string, unknown>).reason ===
          "string")) &&
    (row.supportState === "none" || row.supportState === "contact_support")
  );
}
