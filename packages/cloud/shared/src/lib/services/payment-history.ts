/**
 * Read-only payment-state projection unifying provider-neutral receipts
 * (#22427), Stripe checkout orders, and refund/dispute credit-ledger rows
 * into the customer-visible billing history surface for #22966 (U15b).
 *
 * Every row is derived exclusively from server-authoritative tables; client
 * redirect payloads never influence a state. Settled provider-neutral
 * payment requests project from their immutable receipt (amount, currency,
 * settlement time, provider); a settled request without its receipt is an
 * explicit unavailable state, never a fabricated success. Reversal amounts
 * keep the ledger's three distinct authorities separate: provider-cumulative
 * reversed USD (per charge/dispute authority, summed across authorities),
 * applied credit clawbacks (credit units — NOT USD for credit packs), and
 * the unrecovered shortfall recorded by the clawback mutation. Policy
 * effects are never invented: while the refund/chargeback entitlement
 * decision (#22930) is unresolved, every reversal row reports an explicit
 * unavailable policy effect.
 *
 * Purchase identity is typed and provider-scoped: Stripe rows unify on the
 * payment intent id; OxaPay rows join through `payment_request_id`, whose
 * grants carry the synthetic `payment-request:{org}:oxapay:{id}` key that
 * can never collide with a real Stripe intent.
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
  "expired",
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
  /**
   * Event time of the row's current state: the provider settlement for
   * unreversed purchases; the latest reversal's ledger observation time once
   * a reversal decided the state. ISO string.
   */
  eventTime: string;
  /** Honest labeling of {@link eventTime}. */
  eventTimeKind: "provider_settlement" | "server_creation" | "reversal_ledger_observation";
  paymentState: PaymentStateStatus;
  /** Provider-cumulative refunded USD summed across distinct charge authorities. */
  cumulativeRefundedUsd: number;
  /** Provider-cumulative disputed USD summed across distinct dispute authorities. */
  cumulativeDisputedUsd: number;
  /** Credits actually removed by clawbacks (credit units — not USD for credit packs). */
  cumulativeClawbackCredits: number;
  /** Credits restored by dispute reinstatement (credit units). */
  reinstatedCredits: number;
  /** USD the clawback could not recover from the balance, recorded by the mutation. */
  unrecoveredShortfallUsd: number;
  /** True when a dispute reinstatement ledger row exists for this purchase. */
  disputeReinstated: boolean;
  /**
   * Current policy effect of the reversal state. Always an explicit
   * unavailable reason while #22930 is unresolved; null when no reversal
   * applies.
   */
  policyEffect: { status: "unavailable"; reason: PaymentStatePolicyEffectReason } | null;
  /** Structured support state; user-facing copy lives in the UI, never in data. */
  supportState: "none" | "contact_support";
}

interface ReversalAggregate {
  cumulativeRefundedUsd: number;
  cumulativeDisputedUsd: number;
  cumulativeClawbackCredits: number;
  reinstatedCredits: number;
  unrecoveredShortfallUsd: number;
  disputeWithdrawn: boolean;
  disputeReinstated: boolean;
  lastReversalAt: number;
  /** Ledger row id of the latest reversal — stable tie-breaker for equal timestamps. */
  lastReversalRowId: string;
  lastReversalSource: ReversalSource | null;
}

function emptyAggregate(): ReversalAggregate {
  return {
    cumulativeRefundedUsd: 0,
    cumulativeDisputedUsd: 0,
    cumulativeClawbackCredits: 0,
    reinstatedCredits: 0,
    unrecoveredShortfallUsd: 0,
    disputeWithdrawn: false,
    disputeReinstated: false,
    lastReversalAt: -1,
    lastReversalRowId: "",
    lastReversalSource: null,
  };
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Aggregates reversal ledger rows per Stripe payment intent.
 *
 * Provider-cumulative amounts are aggregated per authority first, then
 * summed: Stripe keys refund idempotency on `charge.id + cumulative
 * amount_refunded` and disputes on `dispute.id`, so the authoritative
 * cumulative value for each charge/dispute is the max snapshot observed for
 * that authority, and multiple charges/disputes under one intent add up.
 * The authority identity is parsed from `metadata.reference`
 * ("charge {id}" / "dispute {id} (...)"), falling back to the row's
 * idempotency key (`stripe_payment_intent_id`) when the reference is absent.
 */
function aggregateReversals(
  rows: Array<{
    id: string;
    type: string;
    amount: string;
    stripePaymentIntentId: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>,
): Map<string, ReversalAggregate> {
  const byIntent = new Map<string, ReversalAggregate>();
  // intent -> source class -> authority id -> max provider-cumulative snapshot
  const perAuthority = new Map<string, Map<"refund" | "dispute", Map<string, number>>>();

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
      current.cumulativeClawbackCredits += amount;
      const shortfall = finiteNumber(metadata.unrecovered_clawback_usd);
      if (shortfall !== null && shortfall > 0) {
        current.unrecoveredShortfallUsd += shortfall;
      }
      if (
        at > current.lastReversalAt ||
        (at === current.lastReversalAt && row.id > current.lastReversalRowId)
      ) {
        current.lastReversalAt = at;
        current.lastReversalRowId = row.id;
        current.lastReversalSource = source;
      }
      if (source !== "charge.refunded") {
        current.disputeWithdrawn = true;
      }
    } else if (row.type === "refund" && source === "charge.dispute.funds_reinstated") {
      current.disputeWithdrawn = true;
      current.disputeReinstated = true;
      current.reinstatedCredits += amount;
      if (
        at > current.lastReversalAt ||
        (at === current.lastReversalAt && row.id > current.lastReversalRowId)
      ) {
        current.lastReversalAt = at;
        current.lastReversalRowId = row.id;
        current.lastReversalSource = source;
      }
    } else {
      continue;
    }

    // Provider-cumulative snapshot per authority.
    const reversed = finiteNumber(metadata.reversed_usd);
    if (reversed !== null && reversed >= 0 && source === "charge.refunded") {
      const authority = reversalAuthority(metadata, row.stripePaymentIntentId ?? row.id, "charge");
      const classes = perAuthority.get(intentId) ?? new Map();
      const refunds = classes.get("refund") ?? new Map<string, number>();
      refunds.set(authority, Math.max(refunds.get(authority) ?? 0, reversed));
      classes.set("refund", refunds);
      perAuthority.set(intentId, classes);
    }
    if (
      reversed !== null &&
      reversed >= 0 &&
      (source === "charge.dispute.funds_withdrawn" || source === "charge.dispute.funds_reinstated")
    ) {
      const authority = reversalAuthority(metadata, row.stripePaymentIntentId ?? row.id, "dispute");
      const classes = perAuthority.get(intentId) ?? new Map();
      const disputes = classes.get("dispute") ?? new Map<string, number>();
      disputes.set(authority, Math.max(disputes.get(authority) ?? 0, reversed));
      classes.set("dispute", disputes);
      perAuthority.set(intentId, classes);
    }

    byIntent.set(intentId, current);
  }

  for (const [intentId, classes] of perAuthority) {
    const agg = byIntent.get(intentId);
    if (!agg) continue;
    let refunded = 0;
    for (const v of classes.get("refund")?.values() ?? []) refunded += v;
    let disputed = 0;
    for (const v of classes.get("dispute")?.values() ?? []) disputed += v;
    agg.cumulativeRefundedUsd = refunded;
    agg.cumulativeDisputedUsd = disputed;
  }
  return byIntent;
}

/** Stable authority identity for per-charge/dispute cumulative snapshots. */
function reversalAuthority(
  metadata: Record<string, unknown>,
  fallback: string,
  kind: "charge" | "dispute",
): string {
  const reference = metadata.reference;
  if (typeof reference === "string" && reference.trim()) {
    const text = reference.trim();
    if (kind === "charge" && text.startsWith("charge ")) {
      return text;
    }
    if (kind === "dispute" && text.startsWith("dispute ")) {
      // "dispute dp_1 (charge ch_1)" — the dispute id is the authority.
      return text.split(" (")[0];
    }
  }
  return `${kind}:fallback:${fallback}`;
}

/**
 * Chronological reversal→state precedence: the most recent authoritative
 * reversal event decides the visible state (row id as the stable tie-breaker).
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

/**
 * Maps a payment-request authority status onto the visible state vocabulary.
 * A settled request is only a success through its immutable receipt —
 * #22427's authority — otherwise the authority is incomplete and the row is
 * explicitly unavailable.
 */
function derivePaymentRequestState(
  status: string,
  receiptPresent: boolean,
  reversal: ReversalAggregate | undefined,
  amountCents: number,
): PaymentStateStatus {
  if (status === "settled") {
    if (!receiptPresent) return "unavailable";
    if (reversal && reversal.lastReversalSource) {
      return reversalStatus(reversal, amountCents);
    }
    return "succeeded";
  }
  switch (status) {
    case "pending":
    case "delivered":
      return "pending";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "expired":
      return "expired";
    default:
      return "unavailable";
  }
}

/**
 * Maps a checkout-order authority status onto the visible state vocabulary.
 * A settled order with a bound payment intent is durable server authority —
 * legacy orders never project a receipt, so receipt absence is not an error
 * for this surface.
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
   * Purchases are selected first (bounded); reversal rows are then fetched in
   * id-ordered batches covering EVERY selected intent with no truncation, so
   * a purchase's refund history cannot be split across a query boundary.
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

    // Reversals: batched by intent until every selected intent is covered.
    // No global row cap — an org with deep refund history on one purchase
    // must not lose older rows to a sibling purchase's volume.
    const reversalRows: Array<{
      id: string;
      type: string;
      amount: string;
      stripePaymentIntentId: string | null;
      metadata: Record<string, unknown> | null;
      createdAt: Date;
    }> = [];
    const intentList = [...stripeIntentIds];
    const BATCH = 100;
    for (let i = 0; i < intentList.length; i += BATCH) {
      const slice = intentList.slice(i, i + BATCH);
      const rows = await dbRead
        .select({
          id: creditTransactions.id,
          type: creditTransactions.type,
          amount: creditTransactions.amount,
          stripePaymentIntentId: creditTransactions.stripe_payment_intent_id,
          metadata: creditTransactions.metadata,
          createdAt: creditTransactions.created_at,
        })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.organization_id, organizationId),
            inArray(creditTransactions.type, ["clawback", "refund"]),
            inArray(sql`${creditTransactions.metadata}->>'payment_intent_id'`, slice),
          ),
        )
        .orderBy(desc(creditTransactions.created_at), desc(creditTransactions.id));
      reversalRows.push(...rows);
    }

    const reversals = aggregateReversals(reversalRows);

    // Receipts join by payment_request_id (provider-scoped), never by intent.
    const requestIds = requestRows.map((row) => row.id);
    const receiptRows = requestIds.length
      ? await dbRead
          .select({
            paymentRequestId: paymentRequestReceipts.payment_request_id,
            id: paymentRequestReceipts.id,
            provider: paymentRequestReceipts.provider,
            amountCents: paymentRequestReceipts.amount_cents,
            currency: paymentRequestReceipts.currency,
            settledAt: paymentRequestReceipts.settled_at,
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
      const reversalKey = request.provider === "stripe" ? request.settlementTxRef : null;
      const reversal = reversalKey ? reversals.get(reversalKey) : undefined;
      const reversed = Boolean(reversal?.lastReversalSource);
      // Settled requests project purchase facts from the immutable receipt:
      // amount, currency, settlement time, and provider all prefer the
      // receipt (#22427 authority) over the mutable request row.
      const amountCents = receipt ? Number(receipt.amountCents) : Number(request.amountCents);
      const settlementAt = receipt ? receipt.settledAt : request.settledAt;
      const paymentState = derivePaymentRequestState(
        request.status,
        receipt !== null,
        reversal,
        amountCents,
      );
      const eventTime = reversal?.lastReversalSource
        ? new Date(reversal.lastReversalAt).toISOString()
        : settlementAt
          ? settlementAt.toISOString()
          : request.createdAt.toISOString();
      const eventTimeKind: PaymentStateRow["eventTimeKind"] = reversal?.lastReversalSource
        ? "reversal_ledger_observation"
        : settlementAt
          ? "provider_settlement"
          : "server_creation";
      rows.push({
        id: `payment_request:${request.id}`,
        surface: "payment_request",
        authorityId: request.id,
        receiptId: receipt?.id ?? null,
        provider: receipt ? receipt.provider : request.provider,
        amountCents,
        currency: receipt
          ? normalizeUppercaseCurrency(receipt.currency)
          : normalizeUppercaseCurrency(request.currency),
        eventTime,
        eventTimeKind,
        paymentState,
        cumulativeRefundedUsd: reversal?.cumulativeRefundedUsd ?? 0,
        cumulativeDisputedUsd: reversal?.cumulativeDisputedUsd ?? 0,
        cumulativeClawbackCredits: reversal?.cumulativeClawbackCredits ?? 0,
        reinstatedCredits: reversal?.reinstatedCredits ?? 0,
        unrecoveredShortfallUsd: reversal?.unrecoveredShortfallUsd ?? 0,
        disputeReinstated: reversal?.disputeReinstated ?? false,
        policyEffect: reversed
          ? {
              status: "unavailable",
              reason: POLICY_EFFECT_REASONS.refundPolicyPending,
            }
          : null,
        supportState: reversed ? "contact_support" : "none",
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
        eventTime: reversal?.lastReversalSource
          ? new Date(reversal.lastReversalAt).toISOString()
          : order.settledAt
            ? order.settledAt.toISOString()
            : order.createdAt.toISOString(),
        eventTimeKind: reversal?.lastReversalSource
          ? "reversal_ledger_observation"
          : order.settledAt
            ? "provider_settlement"
            : "server_creation",
        paymentState: deriveCheckoutOrderState(
          order.status,
          order.stripePaymentIntentId,
          reversal,
          amountCents,
        ),
        cumulativeRefundedUsd: reversal?.cumulativeRefundedUsd ?? 0,
        cumulativeDisputedUsd: reversal?.cumulativeDisputedUsd ?? 0,
        cumulativeClawbackCredits: reversal?.cumulativeClawbackCredits ?? 0,
        reinstatedCredits: reversal?.reinstatedCredits ?? 0,
        unrecoveredShortfallUsd: reversal?.unrecoveredShortfallUsd ?? 0,
        disputeReinstated: reversal?.disputeReinstated ?? false,
        policyEffect: reversed
          ? {
              status: "unavailable",
              reason: POLICY_EFFECT_REASONS.refundPolicyPending,
            }
          : null,
        supportState: reversed ? "contact_support" : "none",
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
