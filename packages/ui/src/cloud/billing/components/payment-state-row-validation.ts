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
 * sandbox-status.ts). The Record-typed mirror below makes drift in EITHER
 * direction (added server state, stray local state) a compile error instead
 * of a silent validation hole.
 */
// A Record keyed by the union (not an array + satisfies) is exhaustive in
// BOTH directions: a stray value fails compilation AND an omitted union
// member fails compilation, so the guard's vocabulary can never silently
// fall behind the rendered union.
const PAYMENT_STATE_SET: Readonly<
  Record<PaymentStateDisplay["paymentState"], true>
> = {
  pending: true,
  succeeded: true,
  failed: true,
  canceled: true,
  expired: true,
  partially_refunded: true,
  refunded: true,
  dispute_withdrawn: true,
  dispute_reinstated: true,
  unavailable: true,
};

// Runtime membership view of the exhaustive mirror above. `new Set(...)` of
// own keys only: prototype-chain names can never enter the vocabulary.
const PAYMENT_STATE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(PAYMENT_STATE_SET),
);

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
    // The server serializes every eventTime with toISOString(), so the
    // canonical round-trip is the exact transport contract: "0" parses to a
    // 2000 date and "2024-02-30" silently normalizes to March 1 under a bare
    // isFinite check — both would render an authoritative-looking but
    // altered timestamp instead of the malformed-response state.
    Number.isFinite(new Date(row.eventTime).getTime()) &&
    new Date(row.eventTime).toISOString() === row.eventTime &&
    (row.eventTimeKind === "provider_settlement" ||
      row.eventTimeKind === "server_creation" ||
      row.eventTimeKind === "reversal_ledger_observation") &&
    typeof row.paymentState === "string" &&
    PAYMENT_STATE_KEYS.has(row.paymentState) &&
    typeof row.cumulativeRefundedChargeCurrency === "number" &&
    Number.isFinite(row.cumulativeRefundedChargeCurrency) &&
    typeof row.cumulativeDisputedChargeCurrency === "number" &&
    Number.isFinite(row.cumulativeDisputedChargeCurrency) &&
    typeof row.cumulativeClawbackCredits === "number" &&
    Number.isFinite(row.cumulativeClawbackCredits) &&
    typeof row.reinstatedCredits === "number" &&
    Number.isFinite(row.reinstatedCredits) &&
    typeof row.unrecoveredShortfallCredits === "number" &&
    Number.isFinite(row.unrecoveredShortfallCredits) &&
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
