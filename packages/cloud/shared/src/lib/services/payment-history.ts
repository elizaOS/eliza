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
 * reversed amounts in the charge's own currency (per charge/dispute
 * authority, summed across authorities; Stripe minor units divided by 100,
 * charge currency despite the legacy `reversed_usd` metadata key), applied
 * credit clawbacks (credit units — NOT USD for credit packs), and the
 * unrecovered credit-unit shortfall currently outstanding on the clawback
 * ledger: derived as max cumulative clawback target minus net applied
 * credits, so later rows that carry earlier under-recovery in their
 * cumulative snapshots are never double-counted. Policy effects are never
 * invented: while the refund/chargeback entitlement decision (#22930) is
 * unresolved, every reversal row reports an explicit unavailable policy
 * effect.
 *
 * Purchase identity is typed and provider-scoped: Stripe rows unify on the
 * payment intent id; OxaPay rows join through `payment_request_id`, whose
 * grants carry the synthetic `payment-request:{org}:oxapay:{id}` key that
 * can never collide with a real Stripe intent.
 */

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
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
  /**
   * Provider-cumulative refunded amount in the purchase's own currency
   * (major units), summed across distinct charge authorities. NOT USD unless
   * the charge itself is USD — Stripe's `amount_refunded` minor units carry
   * the charge currency despite the legacy `reversed_usd` metadata key.
   */
  cumulativeRefundedChargeCurrency: number;
  /**
   * Provider-cumulative disputed amount in the purchase's own currency
   * (major units), summed across distinct dispute authorities. NOT USD
   * unless the charge itself is USD.
   */
  cumulativeDisputedChargeCurrency: number;
  /** Credits actually removed by clawbacks (credit units — not USD for credit packs). */
  cumulativeClawbackCredits: number;
  /** Credits restored by dispute reinstatement (credit units). */
  reinstatedCredits: number;
  /**
   * Clawback target the org balance could not cover, still outstanding now
   * (CREDIT units — the clawback target is denominated in granted credits,
   * never provider currency). Derived as max cumulative clawback target
   * minus net applied clawback credits, so per-row shortfall snapshots that
   * already fold in earlier under-recovery are not double-counted; legacy
   * rows without a recorded target fall back to the chronologically last
   * shortfall snapshot. NOT USD even though the ledger metadata key is
   * `unrecovered_clawback_usd`.
   */
  unrecoveredShortfallCredits: number;
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
  cumulativeRefundedChargeCurrency: number;
  cumulativeDisputedChargeCurrency: number;
  cumulativeClawbackCredits: number;
  reinstatedCredits: number;
  /** Outstanding credit-unit clawback shortfall — derived after the row pass. */
  unrecoveredShortfallCredits: number;
  /**
   * Per-authority clawback debt for the intent. A dispute reinstatement
   * overturns only ITS OWN dispute (matched via the row's `reference`
   * authority); other authorities' targets survive it. `maxTarget` is the
   * max cumulative clawback target the authority recorded (per-authority
   * cumulative snapshots are monotone; the max tolerates out-of-order
   * arrival), null for legacy rows written before the target metadata
   * existed.
   */
  authorityDebt: Map<
    string,
    {
      kind: "charge" | "dispute";
      maxTarget: number | null;
      applied: number;
      reinstated: number;
    }
  >;
  /** Whether ANY clawback row on the intent recorded a cumulative target. */
  sawAnyTarget: boolean;
  /**
   * Reinstatement credits per dispute authority. Rows arrive newest-first,
   * so a reinstatement may be seen before its dispute's clawback row; these
   * are applied to the authority's debt in the derivation pass.
   */
  pendingReinstated: Map<string, number>;
  /**
   * Shortfall snapshot of the chronologically newest clawback row that
   * recorded one (credit units) — legacy fallback for intents where NO
   * row ever carried a cumulative target. Rows arrive newest-first, so the
   * first snapshot seen wins; zero is a valid snapshot (an earlier
   * shortfall was cleared).
   */
  lastShortfallSnapshotCredits: number | null;
  /**
   * Reinstatement credits recorded strictly AFTER the newest shortfall
   * snapshot row (legacy fallback only).
   */
  reinstatedCreditsSinceSnapshot: number;
  disputeReinstated: boolean;
  lastReversalAt: number;
  /** Ledger row id of the latest reversal — stable tie-breaker for equal timestamps. */
  lastReversalRowId: string;
  lastReversalSource: ReversalSource | null;
}

function emptyAggregate(): ReversalAggregate {
  return {
    cumulativeRefundedChargeCurrency: 0,
    cumulativeDisputedChargeCurrency: 0,
    cumulativeClawbackCredits: 0,
    reinstatedCredits: 0,
    unrecoveredShortfallCredits: 0,
    authorityDebt: new Map(),
    sawAnyTarget: false,
    pendingReinstated: new Map(),
    lastShortfallSnapshotCredits: null,
    reinstatedCreditsSinceSnapshot: 0,
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
 * The production refund handler keys that column as
 * `stripe:refund:<charge id>:<cumulative amount_refunded>` (stripe-event.ts),
 * so a raw fallback would give every cumulative snapshot of one charge its
 * own authority and the per-authority max would degrade into a sum. The
 * fallback therefore strips the cumulative suffix under a strict
 * `stripe:refund:<id>:<cents>` contract and normalizes to the same
 * `charge <id>` form the reference path emits; keys that do not match the
 * contract (test rows, legacy spellings) keep the raw fallback unchanged.
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
      // The writer records each row's own shortfall snapshot
      // (requested − covered-by-balance at write time). A later row's
      // snapshot already carries any earlier under-recovery — its
      // requested_amount is a cumulative delta — so snapshots must never be
      // summed. Track the newest snapshot (rows are newest-first; zero is a
      // valid snapshot meaning an earlier shortfall was cleared) for the
      // legacy fallback, and per-authority targets for the derivation below.
      const shortfallRaw = metadata.unrecovered_clawback_usd;
      if (shortfallRaw !== undefined && shortfallRaw !== null) {
        const shortfall = finiteNumber(shortfallRaw);
        if (shortfall !== null && shortfall >= 0) {
          if (current.lastShortfallSnapshotCredits === null) {
            current.lastShortfallSnapshotCredits = shortfall;
          }
        }
      }
      const cumulativeTarget = finiteNumber(metadata.cumulative_clawback_target_usd);
      const hasTarget = cumulativeTarget !== null && cumulativeTarget > 0;
      if (hasTarget) {
        current.sawAnyTarget = true;
      }
      // Clawback rows are authority-scoped: refunds reference their charge,
      // dispute withdrawals/reinstatements their dispute.
      const authority = reversalAuthority(
        metadata,
        row.stripePaymentIntentId ?? row.id,
        source === "charge.refunded" ? "charge" : "dispute",
      );
      const debt = current.authorityDebt.get(authority) ?? {
        kind: source === "charge.refunded" ? ("charge" as const) : ("dispute" as const),
        maxTarget: null,
        applied: 0,
        reinstated: 0,
      };
      debt.applied += amount;
      if (hasTarget) {
        debt.maxTarget = Math.max(debt.maxTarget ?? 0, cumulativeTarget as number);
      }
      current.authorityDebt.set(authority, debt);
      if (
        at > current.lastReversalAt ||
        (at === current.lastReversalAt && row.id > current.lastReversalRowId)
      ) {
        current.lastReversalAt = at;
        current.lastReversalRowId = row.id;
        current.lastReversalSource = source;
      }
    } else if (row.type === "refund" && source === "charge.dispute.funds_reinstated") {
      current.disputeReinstated = true;
      current.reinstatedCredits += amount;
      // A reinstatement un-applies credits, so it grows outstanding debt by
      // the restored amount — but only ITS OWN dispute's: the row carries
      // the dispute's `reference`, so the credit lands on that authority.
      // Other authorities' targets survive the reinstatement. The clawback
      // row's authority may be spelled two ways across writer versions —
      // "dispute <id>" from its reference, or
      // "dispute:fallback:<idempotency key>" when the reference is absent
      // (the reinstatement's clawback_key metadata names that key). Credit
      // BOTH spellings: a credit only lands where a debt entry exists, so
      // equivalent spellings cannot double-count.
      const clawbackKey = metadata.clawback_key;
      const candidates = new Set<string>();
      candidates.add(reversalAuthority(metadata, row.stripePaymentIntentId ?? row.id, "dispute"));
      if (typeof clawbackKey === "string" && clawbackKey.trim()) {
        candidates.add(`dispute:fallback:${clawbackKey.trim()}`);
      }
      // Rows arrive newest-first, so the dispute's clawback row may not have
      // been seen yet — collect per-authority reinstatements and apply them
      // in the derivation pass below.
      for (const authority of candidates) {
        current.pendingReinstated.set(
          authority,
          (current.pendingReinstated.get(authority) ?? 0) + amount,
        );
      }
      // Legacy fallback: only reinstatements recorded after the newest
      // snapshot row (rows newest-first) re-add to the snapshot debt.
      if (current.lastShortfallSnapshotCredits === null) {
        current.reinstatedCreditsSinceSnapshot += amount;
      }
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
    agg.cumulativeRefundedChargeCurrency = refunded;
    agg.cumulativeDisputedChargeCurrency = disputed;
  }

  // Derive the outstanding credit-unit shortfall per authority. The
  // writer's debt semantics are authority-scoped: a refund clawback's
  // target belongs to its charge, a dispute's to the dispute, and a
  // reinstatement overturns only its OWN dispute (matched through the
  // row's `reference`). An authority is OVERTURNED when its own
  // reinstatements covered its applied clawbacks — its target then no
  // longer asserts debt. The surviving basis is the max target over
  // non-overturned authorities, minus the intent-wide net applied credits
  // (clawbacks − reinstatements): the writer's requested delta nets ALL
  // reversals across the intent, so applied credits are a shared pool.
  // Intents with no recorded target at all (legacy rows) fall back to the
  // newest shortfall snapshot plus reinstatements recorded after it.
  for (const agg of byIntent.values()) {
    let basis: number | null = null;
    for (const [authority, debt] of agg.authorityDebt) {
      const reinstated = debt.reinstated + (agg.pendingReinstated.get(authority) ?? 0);
      if (debt.kind === "dispute" && reinstated >= debt.applied && debt.applied > 0) {
        continue; // overturned — its own reinstatement closed its debt
      }
      if (debt.maxTarget !== null) {
        basis = Math.max(basis ?? 0, debt.maxTarget);
      }
    }
    if (basis !== null) {
      const netApplied = agg.cumulativeClawbackCredits - agg.reinstatedCredits;
      // The >= 0 clamp is defense in depth: an over-reinstatement that drove
      // netApplied past basis would otherwise surface as a negative
      // "unrecovered balance". Reviewer-verified 2026-08-28 that no current
      // writer can produce that state (M4 mutant survives unobserved), so it
      // is untestable at this seam without fabricating an unreachable input.
      agg.unrecoveredShortfallCredits = Math.max(basis - netApplied, 0);
    } else if (agg.sawAnyTarget) {
      // Every recorded target belonged to an overturned authority.
      agg.unrecoveredShortfallCredits = 0;
    } else if (agg.lastShortfallSnapshotCredits !== null) {
      agg.unrecoveredShortfallCredits = Math.max(
        agg.lastShortfallSnapshotCredits + agg.reinstatedCreditsSinceSnapshot,
        0,
      );
    } else {
      agg.unrecoveredShortfallCredits = 0;
    }
  }
  return byIntent;
}

/**
 * Stable authority identity for per-charge/dispute cumulative snapshots.
 * Falls back to the row's idempotency key when `metadata.reference` is
 * absent. Production refund rows key that column
 * `stripe:refund:<charge id>:<cumulative cents>`; the suffix is stripped
 * under that strict contract so cumulative snapshots of one charge share a
 * single authority (max, not sum), and the result is normalized to the
 * `charge <id>` form the reference path emits so mixed provenance also
 * collapses. Keys that do not match the contract keep the raw fallback.
 */
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
      // Producer contract (packages/cloud/api/src/queue/stripe-event.ts,
      // dispute handler): dispute rows ALWAYS set `metadata.reference`
      // (`dispute <id> (charge <id>)`) and their idempotency key
      // `stripe:dispute:<dispute id>` carries no cumulative suffix, so the
      // unique ledger index permits exactly one row per dispute. This branch
      // is therefore the only production path and never reaches the raw
      // `${kind}:fallback:` below, where two keys would sum instead of
      // max-collapse. If the producer ever moves to cumulative keys the way
      // refunds already have, this projection silently starts summing —
      // update the charge-side suffix-strip contract here in the same change.
      return text.split(" (")[0];
    }
  }
  if (kind === "charge") {
    // The cumulative suffix is cents, so anything nonnumeric means the key is
    // not a production refund snapshot; keep it as its own raw authority
    // rather than colliding with (and max-suppressing) a genuine charge row.
    const match = /^stripe:refund:([^:]+):([0-9]+)$/.exec(fallback);
    if (match) {
      return `charge ${match[1]}`;
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
      const amountMajor = amountCents / 100;
      const fullyReversed = reversal.cumulativeRefundedChargeCurrency + 1e-9 >= amountMajor - 1e-9;
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

interface RequestAuthorityRow {
  id: string;
  provider: PaymentRequestProvider;
  amountCents: number | bigint;
  currency: string;
  status: string;
  settledAt: Date | null;
  settlementTxRef: string | null;
  createdAt: Date;
}

interface OrderAuthorityRow {
  id: string;
  stripePaymentIntentId: string | null;
  chargeAmountCents: number | bigint;
  currency: string;
  status: string;
  settledAt: Date | null;
  createdAt: Date;
}

/**
 * Reversal aggregates for a set of Stripe intents, batched by intent until
 * every intent is covered. No global row cap — an org with deep refund
 * history on one purchase must not lose older rows to a sibling purchase's
 * volume.
 */
async function fetchReversalsByIntents(
  organizationId: string,
  intents: Iterable<string>,
): Promise<Map<string, ReversalAggregate>> {
  const reversalRows: Array<{
    id: string;
    type: string;
    amount: string;
    stripePaymentIntentId: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }> = [];
  const intentList = [...intents];
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
  return aggregateReversals(reversalRows);
}

/**
 * Projects one payment-request authority into its customer-visible row.
 * Purchase facts come from the immutable receipt when one exists (#22427
 * authority); the mutable request row is the legacy fallback only.
 */
function projectRequestRow(
  request: RequestAuthorityRow,
  receipt: {
    id: string;
    provider: PaymentRequestProvider;
    providerTxRef: string | null;
    amountCents: number | bigint;
    currency: string;
    settledAt: Date | null;
  } | null,
  reversal: ReversalAggregate | undefined,
): PaymentStateRow {
  // Reversal association follows the same immutable authority: when the
  // receipt exists, its provider and provider tx ref decide which Stripe
  // intent the reversals attach to.
  const reversed = Boolean(reversal?.lastReversalSource);
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
  return {
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
    cumulativeRefundedChargeCurrency: reversal?.cumulativeRefundedChargeCurrency ?? 0,
    cumulativeDisputedChargeCurrency: reversal?.cumulativeDisputedChargeCurrency ?? 0,
    cumulativeClawbackCredits: reversal?.cumulativeClawbackCredits ?? 0,
    reinstatedCredits: reversal?.reinstatedCredits ?? 0,
    unrecoveredShortfallCredits: reversal?.unrecoveredShortfallCredits ?? 0,
    disputeReinstated: reversal?.disputeReinstated ?? false,
    policyEffect: reversed
      ? {
          status: "unavailable",
          reason: POLICY_EFFECT_REASONS.refundPolicyPending,
        }
      : null,
    supportState: reversed ? "contact_support" : "none",
  };
}

/** Projects one checkout-order authority into its customer-visible row. */
function projectOrderRow(
  order: OrderAuthorityRow,
  reversal: ReversalAggregate | undefined,
): PaymentStateRow {
  const amountCents = Number(order.chargeAmountCents);
  const reversed = Boolean(reversal?.lastReversalSource);
  return {
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
    cumulativeRefundedChargeCurrency: reversal?.cumulativeRefundedChargeCurrency ?? 0,
    cumulativeDisputedChargeCurrency: reversal?.cumulativeDisputedChargeCurrency ?? 0,
    cumulativeClawbackCredits: reversal?.cumulativeClawbackCredits ?? 0,
    reinstatedCredits: reversal?.reinstatedCredits ?? 0,
    unrecoveredShortfallCredits: reversal?.unrecoveredShortfallCredits ?? 0,
    disputeReinstated: reversal?.disputeReinstated ?? false,
    policyEffect: reversed
      ? {
          status: "unavailable",
          reason: POLICY_EFFECT_REASONS.refundPolicyPending,
        }
      : null,
    supportState: reversed ? "contact_support" : "none",
  };
}

/** Maximum page size across the payment-states surfaces. */
export const PAYMENT_STATES_MAX_PAGE = 500;

export class PaymentHistoryService {
  /**
   * Lists the organization's purchase payment states from server authorities
   * as one page of a stable, exactly traversable ordering. The page window
   * is selected by ONE SQL UNION of both authority surfaces ranked by the
   * authority rows' own (created_at DESC, id DESC) — the full-precision
   * PostgreSQL timestamp and collation decide, never a JS-Date millisecond
   * truncation — windowed to global ranks [offset, offset + limit). Walking
   * pages (offset 0, limit, 2*limit, ...) visits every persisted purchase
   * exactly once, no matter how receipts/reversals later moved its derived
   * eventTime (#26752). Derived eventTime still orders the rows WITHIN a
   * page for display continuity.
   */
  async listPaymentStates(
    organizationId: string,
    limit = 50,
    offset = 0,
  ): Promise<PaymentStateRow[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), PAYMENT_STATES_MAX_PAGE);
    const boundedOffset = Math.max(offset, 0);

    // Window selection: rank the union in SQL. Each leg carries the key
    // columns (created_at, id) plus the surface discriminator — authority
    // ids are unique per TABLE, not across tables, so a raw UUID alone
    // cannot identify a row and the surface must travel with it (both as
    // the final SQL tie-breaker and to partition hydration). The outer
    // query orders by the SAME key and applies limit/offset, so the window
    // is exactly the page — no JS re-ranking that could disagree with SQL
    // across pages.
    const requestLeg = dbRead
      .select({
        id: paymentRequests.id,
        surface: sql`'payment_request'`.as("surface"),
        createdAt: paymentRequests.created_at,
      })
      .from(paymentRequests)
      .where(eq(paymentRequests.organization_id, organizationId));
    const orderLeg = dbRead
      .select({
        id: stripeCheckoutOrders.id,
        surface: sql`'checkout_order'`.as("surface"),
        createdAt: stripeCheckoutOrders.created_at,
      })
      .from(stripeCheckoutOrders)
      .where(eq(stripeCheckoutOrders.organization_id, organizationId));
    const ranked = requestLeg.unionAll(orderLeg).as("ranked_authorities");
    // The union's inferred selection carries the first leg's literal
    // surface type; the runtime value is either surface, so read the window
    // through a widened row type.
    const windowRows = (await dbRead
      .select({
        id: ranked.id,
        surface: ranked.surface,
        createdAt: ranked.createdAt,
      })
      .from(ranked)
      .orderBy(desc(ranked.createdAt), desc(ranked.id), desc(ranked.surface))
      .limit(boundedLimit)
      .offset(boundedOffset)) as Array<{
      id: string;
      surface: "payment_request" | "checkout_order";
      createdAt: Date;
    }>;

    // Partition the window by surface BEFORE hydration: a payment-request
    // id and a checkout-order id may collide as raw UUIDs, so each table is
    // queried only with ITS OWN window ids.
    const requestWindowIds = windowRows
      .filter((row) => row.surface === "payment_request")
      .map((row) => row.id);
    const orderWindowIds = windowRows
      .filter((row) => row.surface === "checkout_order")
      .map((row) => row.id);
    if (requestWindowIds.length === 0 && orderWindowIds.length === 0) return [];

    // Hydrate only the page's authority rows, then project exactly as
    // before: receipts by request id, reversals by every associated intent.
    const requestRows = requestWindowIds.length
      ? await dbRead
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
          .where(
            and(
              eq(paymentRequests.organization_id, organizationId),
              inArray(paymentRequests.id, requestWindowIds),
            ),
          )
      : [];

    const orderRows = orderWindowIds.length
      ? await dbRead
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
          .where(
            and(
              eq(stripeCheckoutOrders.organization_id, organizationId),
              inArray(stripeCheckoutOrders.id, orderWindowIds),
            ),
          )
      : [];

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

    // Receipts join by payment_request_id (provider-scoped), never by intent.
    // Their provider tx refs must ALSO feed the reversal lookup set: the
    // receipt is the immutable authority for which Stripe intent a settled
    // purchase's reversals attach to (it may diverge from the request row).
    const requestIds = requestRows.map((row) => row.id);
    const receiptRows = requestIds.length
      ? await dbRead
          .select({
            paymentRequestId: paymentRequestReceipts.payment_request_id,
            id: paymentRequestReceipts.id,
            provider: paymentRequestReceipts.provider,
            providerTxRef: paymentRequestReceipts.provider_tx_ref,
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

    // Receipt provider tx refs are immutable reversal-association authority:
    // they must be in the lookup set even when they diverge from the
    // request row's settlement tx ref (stale/migrated request rows).
    for (const receipt of receiptRows) {
      if (receipt.provider === "stripe" && receipt.providerTxRef) {
        stripeIntentIds.add(receipt.providerTxRef);
      }
    }

    // Reversals: batched by intent until every selected intent is covered
    // (see fetchReversalsByIntents — no global row cap).
    const reversals = await fetchReversalsByIntents(organizationId, stripeIntentIds);

    const rows: PaymentStateRow[] = [];
    for (const request of requestRows) {
      const receipt = receiptsByRequest.get(request.id) ?? null;
      // Reversal association follows the same immutable authority: when the
      // receipt exists, its provider and provider tx ref decide which Stripe
      // intent the reversals attach to; the mutable request row is the
      // legacy fallback only.
      const reversalKey = receipt
        ? receipt.provider === "stripe"
          ? receipt.providerTxRef
          : null
        : request.provider === "stripe"
          ? request.settlementTxRef
          : null;
      const reversal = reversalKey ? reversals.get(reversalKey) : undefined;
      rows.push(projectRequestRow(request, receipt, reversal));
    }

    for (const order of orderRows) {
      const reversal = order.stripePaymentIntentId
        ? reversals.get(order.stripePaymentIntentId)
        : undefined;
      rows.push(projectOrderRow(order, reversal));
    }

    // The window is already the exact page (SQL-ranked); order it for
    // display by derived eventTime with the stable row-id tie-break.
    rows.sort((a, b) => {
      const timeDelta = Date.parse(b.eventTime) - Date.parse(a.eventTime);
      return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id);
    });
    return rows;
  }

  /**
   * Total number of payment-state rows the organization can see across both
   * authority surfaces. Callers use it to size offset pagination of
   * {@link listPaymentStates}: `total` from this count is the real number of
   * persisted purchases, never the current page's length.
   */
  async countPaymentStates(organizationId: string): Promise<number> {
    const [requestCount] = await dbRead
      .select({ value: count() })
      .from(paymentRequests)
      .where(eq(paymentRequests.organization_id, organizationId));
    const [orderCount] = await dbRead
      .select({ value: count() })
      .from(stripeCheckoutOrders)
      .where(eq(stripeCheckoutOrders.organization_id, organizationId));
    return Number(requestCount?.value ?? 0) + Number(orderCount?.value ?? 0);
  }

  /**
   * Resolves one payment state by its stable `{surface}:{authorityId}` id,
   * scoped to the organization. Unlike the list, this is a direct indexed
   * lookup on the owning authority row — a persisted purchase stays reachable
   * from its stable detail id no matter how many newer purchases exist
   * (#26752), and a foreign org's id never resolves.
   */
  async findPaymentStateById(organizationId: string, id: string): Promise<PaymentStateRow | null> {
    const separator = id.indexOf(":");
    const surface = id.slice(0, separator);
    const authorityId = id.slice(separator + 1);

    if (surface === "payment_request" && authorityId) {
      const [request] = await dbRead
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
        .where(
          and(
            eq(paymentRequests.organization_id, organizationId),
            eq(paymentRequests.id, authorityId),
          ),
        );
      if (!request) return null;
      // Receipts join by payment_request_id (provider-scoped), never by intent.
      // The receipt is the immutable authority for which Stripe intent a
      // settled purchase's reversals attach to (it may diverge from the
      // request row).
      const [receipt] = await dbRead
        .select({
          id: paymentRequestReceipts.id,
          paymentRequestId: paymentRequestReceipts.payment_request_id,
          provider: paymentRequestReceipts.provider,
          providerTxRef: paymentRequestReceipts.provider_tx_ref,
          amountCents: paymentRequestReceipts.amount_cents,
          currency: paymentRequestReceipts.currency,
          settledAt: paymentRequestReceipts.settled_at,
        })
        .from(paymentRequestReceipts)
        .where(
          and(
            eq(paymentRequestReceipts.organization_id, organizationId),
            eq(paymentRequestReceipts.payment_request_id, authorityId),
          ),
        );
      const receiptRow = receipt ?? null;
      const reversalKey = receiptRow
        ? receiptRow.provider === "stripe"
          ? receiptRow.providerTxRef
          : null
        : request.provider === "stripe"
          ? request.settlementTxRef
          : null;
      const reversals = reversalKey
        ? await fetchReversalsByIntents(organizationId, [reversalKey])
        : null;
      return projectRequestRow(
        request,
        receiptRow
          ? {
              id: receiptRow.id,
              provider: receiptRow.provider,
              providerTxRef: receiptRow.providerTxRef,
              amountCents: receiptRow.amountCents,
              currency: receiptRow.currency,
              settledAt: receiptRow.settledAt,
            }
          : null,
        reversals?.get(reversalKey ?? "") ?? undefined,
      );
    }

    if (surface === "checkout_order" && authorityId) {
      const [order] = await dbRead
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
        .where(
          and(
            eq(stripeCheckoutOrders.organization_id, organizationId),
            eq(stripeCheckoutOrders.id, authorityId),
          ),
        );
      if (!order) return null;
      const reversals = order.stripePaymentIntentId
        ? await fetchReversalsByIntents(organizationId, [order.stripePaymentIntentId])
        : null;
      return projectOrderRow(order, reversals?.get(order.stripePaymentIntentId ?? "") ?? undefined);
    }

    return null;
  }
}

export const paymentHistoryService = new PaymentHistoryService();
