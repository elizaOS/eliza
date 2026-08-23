/**
 * Read-only payment-state projection unifying provider-neutral receipts
 * (#22427), Stripe checkout orders, and refund/dispute credit-ledger rows
 * into the customer-visible billing history surface for #22966 (U15b).
 *
 * Every row is derived exclusively from server-authoritative tables; client
 * redirect payloads never influence a state. Reversal amounts are reported
 * from the two distinct authorities the ledger keeps: the provider-cumulative
 * reversed USD recorded by the Stripe queue handlers (`metadata.reversed_usd`)
 * and the applied credit clawback total (row amounts, which may be lower after
 * consumption). Policy effects are never invented: while the refund/chargeback
 * entitlement decision (#22930) is unresolved, every reversal row reports an
 * explicit unavailable policy effect instead of a fabricated outcome.
 *
 * Purchase identity is typed and provider-scoped: Stripe rows unify on the
 * payment intent id; OxaPay rows join through `payment_request_id`, whose
 * grants carry the synthetic `payment-request:{org}:oxapay:{id}` key that can
 * never collide with a real Stripe intent, so no Stripe reversal can attach
 * to an OxaPay purchase.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { dbRead } from "../../db/client";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { paymentRequestReceipts } from "../../db/schemas/payment-request-receipts";
import { type PaymentRequestProvider, paymentRequests } from "../../db/schemas/payment-requests";
import { stripeCheckoutOrders } from "../../db/schemas/stripe-checkout-orders";

/** Customer-visible payment state vocabulary for the billing history surface. */
export const PAYMENT_STATE_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "canceled",
  "partially_refunded",
  "refunded",
  "dispute_withdrawn",
  "dispute_reinstated",
  "unavailable",
] as const;
export type PaymentStateStatus = (typeof PAYMENT_STATE_STATUSES)[number];

/** Reversal sources written by the Stripe queue refund/dispute handlers. */
export const REVERSAL_SOURCES = [
  "charge.refunded",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const;
export type ReversalSource = (typeof REVERSAL_SOURCES)[number];

function isReversalSource(value: unknown): value is ReversalSource {
  return typeof value === "string" && (REVERSAL_SOURCES as readonly string[]).includes(value);
}

/**
 * Why a row reports an unavailable policy effect. The reason is a stable
 * machine-readable key, not prose.
 */
export const POLICY_EFFECT_REASONS = {
  refundPolicyPending: "refund_entitlement_policy_pending_22930",
} as const;
export type PaymentStatePolicyEffectReason =
  (typeof POLICY_EFFECT_REASONS)[keyof typeof POLICY_EFFECT_REASONS];

export interface PaymentStateRow {
  /** Stable projection row id: `{surface}:{authorityId}`. */
  id: string;
  /** Which server authority produced the row. */
  surface: "payment_request" | "checkout_order";
  /** Owning organization-scoped authority id (payment request or checkout order). */
  authorityId: string;
  /** Linked provider-neutral receipt id when one exists (settled requests only). */
  receiptId: string | null;
  provider: PaymentRequestProvider;
  /** Purchase amount in integer cents — the authoritative ledger unit. */
  amountCents: number;
  /** Uppercase currency code as normalized from the owning authority. */
  currency: string;
  /** Provider-neutral event time: settlement when the provider settled, otherwise the authority's creation time. */
  eventTime: string;
  /**
   * Honest labeling of {@link eventTime}: "settlement" carries provider
   * settlement authority; "creation" is the local server observation only.
   */
  eventTimeKind: "settlement" | "creation";
  paymentState: PaymentStateStatus;
  /** Provider-cumulative refunded USD from `charge.refunded` reversals (never dispute withdrawals). */
  cumulativeRefundedUsd: number;
  /** Provider-cumulative disputed USD withdrawn by `charge.dispute.funds_withdrawn` events. */
  cumulativeDisputedUsd: number;
  /** Credits actually removed by clawbacks; may be below the provider amounts after consumption. */
  cumulativeClawbackUsd: number;
  /** Credits restored by a dispute reinstatement. */
  reinstatedUsd: number;
  /** True when a dispute reinstatement ledger row exists for this purchase. */
  disputeReinstated: boolean;
  /**
   * Current policy effect of the reversal state. Always an explicit
   * unavailable reason while #22930 is unresolved; null when no reversal
   * applies (purchase rows without refunds/disputes).
   */
  policyEffect: { status: "unavailable"; reason: PaymentStatePolicyEffectReason } | null;
  /** Structured support state; user-facing copy lives in the UI, never in data. */
  supportState: "none" | "contact_support";
  /** Provider transaction reference (Stripe payment intent / OxaPay track id). */
  providerTxRef: string;
}

interface ReversalAggregate {
  cumulativeRefundedUsd: number;
  cumulativeDisputedUsd: number;
  cumulativeClawbackUsd: number;
  reinstatedUsd: number;
  disputeWithdrawn: boolean;
  disputeReinstated: boolean;
  lastReversalAt: number;
  /** The most recent reversal event by ledger time decides the visible state. */
  lastReversalSource: ReversalSource | null;
}

function emptyAggregate(): ReversalAggregate {
  return {
    cumulativeRefundedUsd: 0,
    cumulativeDisputedUsd: 0,
    cumulativeClawbackUsd: 0,
    reinstatedUsd: 0,
    disputeWithdrawn: false,
    disputeReinstated: false,
    lastReversalAt: 0,
    lastReversalSource: null,
  };
}

/**
 * Aggregates reversal ledger rows per Stripe payment intent. Reconciliation
 * refunds (`recon:*` keys, no `payment_intent_id` metadata) never enter: only
 * Stripe queue handler rows carry that metadata key.
 */
function aggregateReversals(
  rows: Array<{
    type: string;
    amount: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>,
): Map<string, ReversalAggregate> {
  const byIntent = new Map<string, ReversalAggregate>();
  for (const row of rows) {
    const metadata = row.metadata ?? {};
    const intentId = metadata.payment_intent_id;
    if (typeof intentId !== "string" || !intentId) continue;
    const source = metadata.source;
    if (!isReversalSource(source)) continue;
    const amount = Math.abs(Number(row.amount));
    if (!Number.isFinite(amount)) continue;
    const occurredAt = row.createdAt.getTime();
    const at = Number.isFinite(occurredAt) ? occurredAt : 0;

    const current = byIntent.get(intentId) ?? emptyAggregate();

    if (row.type === "clawback") {
      current.cumulativeClawbackUsd += amount;
      if (at >= current.lastReversalAt) {
        current.lastReversalAt = at;
        current.lastReversalSource = source;
      }
      // reversed_usd is the provider-cumulative snapshot; the latest row by
      // ledger time carries the authoritative cumulative value.
      const reversed = Number(metadata.reversed_usd);
      if (Number.isFinite(reversed) && reversed >= 0) {
        if (source === "charge.refunded") {
          current.cumulativeRefundedUsd = Math.max(current.cumulativeRefundedUsd, reversed);
        } else {
          current.cumulativeDisputedUsd = Math.max(current.cumulativeDisputedUsd, reversed);
        }
      }
      if (source !== "charge.refunded") {
        current.disputeWithdrawn = true;
      }
    } else if (row.type === "refund" && source === "charge.dispute.funds_reinstated") {
      current.disputeWithdrawn = true;
      current.disputeReinstated = true;
      current.reinstatedUsd += amount;
      if (at >= current.lastReversalAt) {
        current.lastReversalAt = at;
        current.lastReversalSource = source;
      }
    }
    byIntent.set(intentId, current);
  }
  return byIntent;
}

/**
 * Chronological reversal→state precedence: the most recent authoritative
 * reversal event decides the visible state.
 */
function reversalStatus(reversal: ReversalAggregate, amountCents: number): PaymentStateStatus {
  switch (reversal.lastReversalSource) {
    case "charge.dispute.funds_reinstated":
      return "dispute_reinstated";
    case "charge.dispute.funds_withdrawn":
      return "dispute_withdrawn";
    case "charge.refunded": {
      const amountUsd = amountCents / 100;
      const fullyReversed = reversal.cumulativeRefundedUsd + 1e-9 >= amountUsd - 1e-9;
      return fullyReversed ? "refunded" : "partially_refunded";
    }
    default:
      return "succeeded";
  }
}

/** Maps a payment-request authority status onto the visible state vocabulary. */
function derivePaymentRequestState(
  status: string,
  settlementTxRef: string | null,
  reversal: ReversalAggregate | undefined,
  amountCents: number,
): PaymentStateStatus {
  const succeeded = status === "settled" && Boolean(settlementTxRef);
  if (succeeded && reversal && reversal.lastReversalSource) {
    return reversalStatus(reversal, amountCents);
  }
  switch (status) {
    case "settled":
      return "succeeded";
    case "pending":
    case "delivered":
      return "pending";
    case "failed":
      return "failed";
    case "canceled":
    case "expired":
      return "canceled";
    default:
      return "unavailable";
  }
}

/**
 * Maps a checkout-order authority status onto the visible state vocabulary.
 * A settled order with a bound payment intent is durable server authority —
 * it needs no receipt to be a success (legacy orders never project one).
 */
function deriveCheckoutOrderState(
  status: string,
  stripePaymentIntentId: string | null,
  reversal: ReversalAggregate | undefined,
  amountCents: number,
): PaymentStateStatus {
  const succeeded = status === "settled" && Boolean(stripePaymentIntentId);
  if (succeeded && reversal && reversal.lastReversalSource) {
    return reversalStatus(reversal, amountCents);
  }
  switch (status) {
    case "settled":
      return stripePaymentIntentId ? "succeeded" : "unavailable";
    case "quoted":
    case "provider_started":
    case "delivered":
      return "pending";
    case "provider_ambiguous":
      // The provider outcome is explicitly unknown — never a fake failure.
      return "unavailable";
    case "failed":
      return "failed";
    default:
      return "unavailable";
  }
}

function normalizeUppercaseCurrency(value: string): string {
  return value.trim().toUpperCase();
}

export class PaymentHistoryService {
  /**
   * Lists the organization's purchase payment states from server authorities.
   * Purchases are selected first (bounded); every reversal row for their
   * Stripe payment intents is then aggregated with no pre-aggregation
   * truncation, so a purchase's refund history cannot be split across a
   * query boundary.
   */
  async listPaymentStates(organizationId: string, limit = 50): Promise<PaymentStateRow[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 200);

    const requestRows = await dbRead
      .select({
        id: paymentRequests.id,
        provider: paymentRequests.provider,
        amountCents: paymentRequests.amount_cents,
        currency: paymentRequests.currency,
        status: paymentRequests.status,
        settledAt: paymentRequests.settled_at,
        settlementTxRef: paymentRequests.settlement_tx_ref,
        createdAt: paymentRequests.created_at,
      })
      .from(paymentRequests)
      .where(eq(paymentRequests.organization_id, organizationId))
      .orderBy(desc(paymentRequests.created_at))
      .limit(boundedLimit);

    const orderRows = await dbRead
      .select({
        id: stripeCheckoutOrders.id,
        stripePaymentIntentId: stripeCheckoutOrders.stripe_payment_intent_id,
        chargeAmountCents: stripeCheckoutOrders.charge_amount_cents,
        currency: stripeCheckoutOrders.currency,
        status: stripeCheckoutOrders.status,
        settledAt: stripeCheckoutOrders.settled_at,
        createdAt: stripeCheckoutOrders.created_at,
      })
      .from(stripeCheckoutOrders)
      .where(eq(stripeCheckoutOrders.organization_id, organizationId))
      .orderBy(desc(stripeCheckoutOrders.created_at))
      .limit(boundedLimit);

    // Stripe reversal lookup keys: real payment intents only. OxaPay/x402/
    // wallet-native purchases have no Stripe charge webhook path, so no
    // reversal can legitimately reference them (their grants key on the
    // synthetic `payment-request:{org}:{provider}:{id}` string).
    const stripeIntentIds = new Set<string>();
    for (const request of requestRows) {
      if (request.provider === "stripe" && request.settlementTxRef) {
        stripeIntentIds.add(request.settlementTxRef);
      }
    }
    for (const order of orderRows) {
      if (order.stripePaymentIntentId) {
        stripeIntentIds.add(order.stripePaymentIntentId);
      }
    }

    let reversalRows: Array<{
      type: string;
      amount: string;
      metadata: Record<string, unknown> | null;
      createdAt: Date;
    }> = [];
    if (stripeIntentIds.size > 0) {
      reversalRows = await dbRead
        .select({
          type: creditTransactions.type,
          amount: creditTransactions.amount,
          metadata: creditTransactions.metadata,
          createdAt: creditTransactions.created_at,
        })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.organization_id, organizationId),
            inArray(creditTransactions.type, ["clawback", "refund"]),
            inArray(sql`${creditTransactions.metadata}->>'payment_intent_id'`, [
              ...stripeIntentIds,
            ]),
          ),
        )
        .orderBy(desc(creditTransactions.created_at))
        .limit(1000);
    }

    const reversals = aggregateReversals(reversalRows);

    // Receipts join by payment_request_id (provider-scoped), never by intent.
    const requestIds = requestRows.map((row) => row.id);
    const receiptRows = requestIds.length
      ? await dbRead
          .select({
            paymentRequestId: paymentRequestReceipts.payment_request_id,
            id: paymentRequestReceipts.id,
          })
          .from(paymentRequestReceipts)
          .where(
            and(
              eq(paymentRequestReceipts.organization_id, organizationId),
              inArray(paymentRequestReceipts.payment_request_id, requestIds),
            ),
          )
      : [];
    const receiptsByRequest = new Map(receiptRows.map((row) => [row.paymentRequestId, row]));

    const rows: PaymentStateRow[] = [];
    for (const request of requestRows) {
      const receipt = receiptsByRequest.get(request.id) ?? null;
      const amountCents = Number(request.amountCents);
      const reversalKey = request.provider === "stripe" ? request.settlementTxRef : null;
      const reversal = reversalKey ? reversals.get(reversalKey) : undefined;
      const reversed = Boolean(reversal?.lastReversalSource);
      rows.push({
        id: `payment_request:${request.id}`,
        surface: "payment_request",
        authorityId: request.id,
        receiptId: receipt?.id ?? null,
        provider: request.provider,
        amountCents,
        currency: normalizeUppercaseCurrency(request.currency),
        eventTime: (request.settledAt ?? request.createdAt).toISOString(),
        eventTimeKind: request.settledAt ? "settlement" : "creation",
        paymentState: derivePaymentRequestState(
          request.status,
          request.settlementTxRef,
          reversal,
          amountCents,
        ),
        cumulativeRefundedUsd: reversal?.cumulativeRefundedUsd ?? 0,
        cumulativeDisputedUsd: reversal?.cumulativeDisputedUsd ?? 0,
        cumulativeClawbackUsd: reversal?.cumulativeClawbackUsd ?? 0,
        reinstatedUsd: reversal?.reinstatedUsd ?? 0,
        disputeReinstated: reversal?.disputeReinstated ?? false,
        policyEffect: reversed
          ? {
              status: "unavailable",
              reason: POLICY_EFFECT_REASONS.refundPolicyPending,
            }
          : null,
        supportState: reversed ? "contact_support" : "none",
        providerTxRef: request.settlementTxRef ?? "",
      });
    }

    for (const order of orderRows) {
      const amountCents = Number(order.chargeAmountCents);
      const reversal = order.stripePaymentIntentId
        ? reversals.get(order.stripePaymentIntentId)
        : undefined;
      const reversed = Boolean(reversal?.lastReversalSource);
      rows.push({
        id: `checkout_order:${order.id}`,
        surface: "checkout_order",
        authorityId: order.id,
        receiptId: null,
        provider: "stripe",
        amountCents,
        currency: normalizeUppercaseCurrency(order.currency),
        eventTime: (order.settledAt ?? order.createdAt).toISOString(),
        eventTimeKind: order.settledAt ? "settlement" : "creation",
        paymentState: deriveCheckoutOrderState(
          order.status,
          order.stripePaymentIntentId,
          reversal,
          amountCents,
        ),
        cumulativeRefundedUsd: reversal?.cumulativeRefundedUsd ?? 0,
        cumulativeDisputedUsd: reversal?.cumulativeDisputedUsd ?? 0,
        cumulativeClawbackUsd: reversal?.cumulativeClawbackUsd ?? 0,
        reinstatedUsd: reversal?.reinstatedUsd ?? 0,
        disputeReinstated: reversal?.disputeReinstated ?? false,
        policyEffect: reversed
          ? {
              status: "unavailable",
              reason: POLICY_EFFECT_REASONS.refundPolicyPending,
            }
          : null,
        supportState: reversed ? "contact_support" : "none",
        providerTxRef: order.stripePaymentIntentId ?? "",
      });
    }

    rows.sort((a, b) => {
      const timeDelta = Date.parse(b.eventTime) - Date.parse(a.eventTime);
      return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id);
    });
    return rows.slice(0, boundedLimit);
  }
}

export const paymentHistoryService = new PaymentHistoryService();
