/**
 * Cache-gated admission for organization-funded inference.
 *
 * The warm Worker path reads only pricing, affiliate-policy, and balance
 * caches before acquiring a Durable Object lease. Post-provider accounting
 * replays one deterministic debit identity; the lease alarm is the durable
 * backstop when a response-side task disappears.
 */

import { calculateCost, normalizeModelName } from "../pricing";
import { createCreditReservationSettler } from "../utils/credit-reservation";
import type { AffiliateBillingAttribution } from "./affiliate-billing-attribution";
import { AFFILIATE_PAYOUT_CONTRACT_VERSION } from "./affiliate-payout-outbox";
import type { BillingContext, FlatBillingCost } from "./ai-billing";
import {
  getAffiliatePayoutSourceId,
  InsufficientCreditsError,
  isSubscriptionFundedOrganization,
  reserveCredits,
  reserveFlatUsageCredits,
} from "./ai-billing";
import { AiPricingCacheUnavailableError, AiPricingCacheWarmingError } from "./ai-pricing/cache";
import {
  COST_BUFFER,
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  MIN_RESERVATION,
} from "./credits";
import {
  acquireInferenceAdmissionLease,
  InferenceAdmissionGateUnavailableError,
  type InferenceAdmissionLease,
  InferenceAdmissionLeaseRejectedError,
  inferenceSettlementAmounts,
  markInferenceAdmissionLeaseDispatched,
  settleInferenceAdmissionLease,
} from "./inference-admission-gate";
import {
  InferenceAffiliateCacheUnavailableError as AffiliateCacheUnavailableError,
  InferenceAffiliateCacheWarmingError as AffiliateCacheWarmingError,
  getCachedInferenceAffiliateAttribution,
} from "./inference-affiliate-cache";
import type { InferenceAdmissionSnapshot } from "./inference-auth-cache";
import { isDeferredAdmissionEnabled, isOrgAdmissionRefused } from "./inference-billing-deferred";
import {
  createOptimisticDebitSettler,
  debitInferenceCost,
  type GateBalanceSnapshot,
  getGateBalanceHint,
  InferenceBalanceCacheWarmingError,
  isOptimisticBackstopAvailable,
  isOptimisticBillingEnabled,
  isOptimisticEligible,
  resolveSafeBalanceThresholdUsd,
  scheduleOrgBalanceHintHydration,
  writePendingInferenceCharge,
} from "./inference-billing-fast-path";
import {
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler,
  resolveInferenceBillingLedger,
} from "./inference-billing-ledger";

export type InferenceAdmissionMode =
  | "durable_object_debit"
  | "durable_object_affiliate_debit"
  | "synchronous_db_ledger"
  | "synchronous_kv_ledger"
  | "synchronous_reservation";

export interface OrganizationInferenceAdmission {
  mode: InferenceAdmissionMode;
  settle(actualCostUsd: number): Promise<CreditReconciliationResult | null>;
  /** Conservatively settle provider work whose exact usage is unavailable. */
  settleUnknown(): Promise<CreditReconciliationResult | null>;
  /** Durably record provider acceptance before streamed output is delivered. */
  markProviderDispatched?(): Promise<void>;
  /**
   * Reservation-compatible view for accounting that must reconcile before a
   * payout. Affiliate billing passes this to `billUsage`, which then waits for
   * the same first-call settlement promise before minting earnings.
   */
  reservation?: CreditReservation;
  /** Immutable affiliate policy selected before provider dispatch. */
  affiliateAttribution?: AffiliateBillingAttribution | null;
}

export interface OrganizationInferenceAdmissionParams {
  context: BillingContext & {
    provider: string;
    billingSource: string;
    requestId: string;
  };
  apiKeyId?: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Fixed provider-priced operation; skips token-price calculation. */
  flatCost?: FlatBillingCost;
  affiliateCode?: string | null;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /** Combined auth-cache projection; skips the separate balance KV read. */
  admissionSnapshot?: InferenceAdmissionSnapshot;
}

/** Retryable signal preserving route compatibility while identifying pricing hydration. */
export class InferencePricingCacheWarmingError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AiPricingCacheWarmingError) {
    super();
    this.name = "InferencePricingCacheWarmingError";
  }
}

/** Retryable signal for a configured Worker cache that cannot serve pricing. */
export class InferencePricingCacheUnavailableError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AiPricingCacheUnavailableError) {
    super();
    this.name = "InferencePricingCacheUnavailableError";
  }
}

/** Retryable signal identifying a cold affiliate pricing-policy cache. */
export class InferenceAffiliateCacheWarmingError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AffiliateCacheWarmingError) {
    super();
    this.name = "InferenceAffiliateCacheWarmingError";
  }
}

/** Retryable signal for an affiliate policy cache that cannot serve safely. */
export class InferenceAffiliateCacheUnavailableError extends InferenceBalanceCacheWarmingError {
  constructor(readonly cause: AffiliateCacheUnavailableError) {
    super();
    this.name = "InferenceAffiliateCacheUnavailableError";
  }
}

/** The request cannot safely defer its durable charge in this Worker. */
export class InferenceAdmissionUnavailableError extends InferenceBalanceCacheWarmingError {
  constructor() {
    super();
    this.name = "InferenceAdmissionUnavailableError";
  }
}

async function reserveSynchronously(
  params: OrganizationInferenceAdmissionParams,
  subscriptionFunded?: boolean,
): Promise<OrganizationInferenceAdmission> {
  const context = {
    ...params.context,
    affiliateCode: params.affiliateCode ?? undefined,
  };
  const reservation = params.flatCost
    ? await reserveFlatUsageCredits(context, params.flatCost, {
        idempotencyKey: params.context.requestId,
        subscriptionFunded,
      })
    : await reserveCredits(context, params.estimatedInputTokens, params.estimatedOutputTokens, {
        subscriptionFunded,
      });
  const settle = createCreditReservationSettler(reservation);
  return {
    mode: "synchronous_reservation",
    settle,
    settleUnknown: () => settle(reservation.reservedAmount),
    affiliateAttribution: reservation.affiliateAttribution ?? null,
    reservation: {
      reservedAmount: reservation.reservedAmount,
      reservationTransactionId: reservation.reservationTransactionId,
      affiliateAttribution: reservation.affiliateAttribution ?? null,
      affiliatePayoutSourceId: reservation.affiliatePayoutSourceId ?? null,
      reconcile: async (actualCostUsd) => (await settle(actualCostUsd)) ?? undefined,
    },
  };
}

function attachInferenceAdmissionLease(
  admission: OrganizationInferenceAdmission,
  lease: InferenceAdmissionLease,
): OrganizationInferenceAdmission {
  const settleAuthoritatively = admission.settle;
  const settleUnknownAuthoritatively = admission.settleUnknown;
  type SettlementChoice = { kind: "actual"; actualCostUsd: number } | { kind: "unknown" };
  let choice: SettlementChoice | undefined;
  let settlement: Promise<CreditReconciliationResult | null> | null = null;
  const markProviderDispatched = () => markInferenceAdmissionLeaseDispatched(lease);
  const run = (requestedChoice: SettlementChoice): Promise<CreditReconciliationResult | null> => {
    choice ??= requestedChoice;
    if (settlement) return settlement;
    const selected = choice;
    const current = (async () => {
      if (selected.kind === "unknown" || selected.actualCostUsd > 0) {
        await markProviderDispatched();
      }
      const reconciliation =
        selected.kind === "actual"
          ? await settleAuthoritatively(selected.actualCostUsd)
          : await settleUnknownAuthoritatively();
      const actualCostUsd =
        selected.kind === "actual"
          ? selected.actualCostUsd
          : Math.max(lease.estimatedCostUsd, reconciliation?.actualCost ?? 0);
      const amounts = inferenceSettlementAmounts(lease, actualCostUsd, reconciliation);
      await settleInferenceAdmissionLease(lease, amounts.balanceBackedUsd, amounts.gateConsumedUsd);
      return reconciliation;
    })();
    settlement = current;
    current.then(
      () => undefined,
      () => {
        // error-policy:J5 the caller observes the settlement failure. Retrying
        // reuses authoritative idempotency and repairs the still-held lease.
        if (settlement === current) settlement = null;
      },
    );
    return current;
  };
  const settle = (actualCostUsd: number): Promise<CreditReconciliationResult | null> =>
    run({ kind: "actual", actualCostUsd });
  const settleUnknown = (): Promise<CreditReconciliationResult | null> => run({ kind: "unknown" });
  if (admission.reservation) {
    admission.reservation.reconcile = async (actualCostUsd) =>
      (await settle(actualCostUsd)) ?? undefined;
  }
  return {
    ...admission,
    settle,
    settleUnknown,
    markProviderDispatched,
  };
}

/**
 * Admit one organization-credit inference request.
 *
 * Worker requests acquire one exact balance lease before dispatch and perform
 * their deterministic debit after provider work. Valid affiliate attribution
 * selects the atomic debit-plus-payout lane; non-Worker callers keep
 * synchronous reservation compatibility.
 */
export async function admitOrganizationInference(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  const executionCtx = params.executionCtx;
  const workerHotPath = typeof executionCtx?.waitUntil === "function";
  const affiliateMarked = Boolean(params.affiliateCode?.trim());
  const subscriptionFunded = await isSubscriptionFundedOrganization(params.context.organizationId);
  if (subscriptionFunded) {
    return await reserveSynchronously(params, true);
  }
  if (workerHotPath && executionCtx && isOrgAdmissionRefused(params.context.organizationId)) {
    // A prior deferred write or fallback charge was refused. Its settler
    // invalidated the balance hint, so a later retry will hydrate authoritative
    // state under waitUntil; this request must not bypass the refusal with a
    // synchronous database reserve on the model hot path.
    scheduleOrgBalanceHintHydration(params.context.organizationId, executionCtx);
    throw new InferenceAdmissionUnavailableError();
  }
  if (!workerHotPath && affiliateMarked) {
    return await reserveSynchronously(params, false);
  }
  if (!isOptimisticBillingEnabled()) {
    if (workerHotPath) throw new InferenceAdmissionUnavailableError();
    return await reserveSynchronously(params, false);
  }

  const thresholdUsd = resolveSafeBalanceThresholdUsd();
  const useDbLedger = resolveInferenceBillingLedger() === "db";
  const canDefer = isDeferredAdmissionEnabled() && workerHotPath;
  if (workerHotPath && !canDefer) {
    throw new InferenceAdmissionUnavailableError();
  }

  const normalizedModel = normalizeModelName(params.context.model);
  let estimatedCostUsd: number;
  let balanceHint: GateBalanceSnapshot;
  let affiliateAttribution: AffiliateBillingAttribution | null = null;
  try {
    const [cost, gateBalance, resolvedAffiliateAttribution] = await Promise.all([
      params.flatCost
        ? Promise.resolve(params.flatCost)
        : calculateCost(
            normalizedModel,
            params.context.provider,
            params.estimatedInputTokens,
            params.estimatedOutputTokens,
            params.context.billingSource,
            {
              cacheOnly: canDefer,
              executionCtx: params.executionCtx,
            },
          ),
      params.admissionSnapshot
        ? Promise.resolve(params.admissionSnapshot.balance)
        : getGateBalanceHint(params.context.organizationId, {
            executionCtx: params.executionCtx,
            cacheOnly: canDefer,
          }),
      affiliateMarked && params.executionCtx
        ? getCachedInferenceAffiliateAttribution({
            affiliateCode: params.affiliateCode,
            organizationId: params.context.organizationId,
            userId: params.context.userId,
            executionCtx: params.executionCtx,
          })
        : null,
    ]);
    affiliateAttribution = resolvedAffiliateAttribution;
    const affiliateMarkupPercent = affiliateAttribution?.markupPercent ?? 0;
    const markedUpEstimate = cost.totalCost * (1 + affiliateMarkupPercent);
    estimatedCostUsd =
      affiliateMarked && !params.flatCost
        ? Math.max(markedUpEstimate * COST_BUFFER, MIN_RESERVATION)
        : markedUpEstimate;
    balanceHint = gateBalance;
  } catch (error) {
    if (error instanceof AiPricingCacheWarmingError) {
      throw new InferencePricingCacheWarmingError(error);
    }
    if (error instanceof AiPricingCacheUnavailableError) {
      throw new InferencePricingCacheUnavailableError(error);
    }
    if (error instanceof AffiliateCacheWarmingError) {
      throw new InferenceAffiliateCacheWarmingError(error);
    }
    if (error instanceof AffiliateCacheUnavailableError) {
      throw new InferenceAffiliateCacheUnavailableError(error);
    }
    throw error;
  }

  const requiredLeaseUsd = Math.max(estimatedCostUsd, MIN_RESERVATION);
  if (canDefer) {
    // The Durable Object serializes every in-flight estimate, so the KV
    // optimistic-billing safety cushion is neither needed nor correct here.
    // Applying the production $5 cushion would reject an otherwise affordable
    // request from every lower-balance organization.
    if (balanceHint.balanceUsd < requiredLeaseUsd) {
      throw new InsufficientCreditsError(
        requiredLeaseUsd,
        balanceHint.balanceUsd,
        "cached_balance_gate",
      );
    }
  } else if (
    !isOptimisticEligible({
      enabled: true,
      useAppCredits: false,
      balanceUsd: balanceHint.balanceUsd,
      thresholdUsd,
      estimatedCostUsd,
    })
  ) {
    return await reserveSynchronously(params, false);
  }

  let inferenceLease: InferenceAdmissionLease | undefined;
  if (canDefer && params.executionCtx) {
    try {
      inferenceLease = await acquireInferenceAdmissionLease({
        organizationId: params.context.organizationId,
        requestId: params.context.requestId,
        balanceUsd: balanceHint.balanceUsd,
        balanceRevision: balanceHint.balanceRevision,
        estimatedCostUsd: requiredLeaseUsd,
        recovery: {
          version: 1,
          kind: "organization",
          organizationId: params.context.organizationId,
          requestId: params.context.requestId,
          userId: params.context.userId,
          model: params.context.model,
          provider: params.context.provider,
          billingSource: params.context.billingSource,
          description: params.context.description ?? `Inference request: ${params.context.model}`,
          ...(params.context.metadata && {
            metadata: params.context.metadata,
          }),
          accounting: affiliateAttribution
            ? {
                kind: "affiliate_debit",
                attribution: affiliateAttribution,
                payoutSourceId: getAffiliatePayoutSourceId(params.context),
              }
            : { kind: "direct_debit" },
        },
        executionCtx: params.executionCtx,
      });
    } catch (error) {
      if (error instanceof InferenceAdmissionLeaseRejectedError) {
        throw new InsufficientCreditsError(
          error.requiredUsd,
          error.availableUsd,
          "cached_balance_gate",
        );
      }
      if (error instanceof InferenceAdmissionGateUnavailableError) {
        throw new InferenceAdmissionUnavailableError();
      }
      throw error;
    }
  }

  const charge = {
    requestId: params.context.requestId,
    organizationId: params.context.organizationId,
    userId: params.context.userId,
    apiKeyId: params.apiKeyId ?? params.context.apiKeyId ?? null,
    model: params.context.model,
    provider: params.context.provider,
    billingSource: params.context.billingSource,
  };
  const debit = {
    requestId: charge.requestId,
    organizationId: charge.organizationId,
    userId: charge.userId,
    model: charge.model,
    provider: charge.provider,
    billingSource: charge.billingSource,
  };

  if (canDefer && params.executionCtx) {
    if (!inferenceLease) {
      throw new InferenceAdmissionUnavailableError();
    }
    if (affiliateAttribution) {
      const affiliatePayoutSourceId = getAffiliatePayoutSourceId(params.context);
      const reservationMetadata = {
        ...(params.context.metadata ?? {}),
        affiliatePayout: {
          version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
          sourceId: affiliatePayoutSourceId,
          attribution: affiliateAttribution,
          model: params.context.model,
        },
      };
      const settle = (actualCostUsd: number) =>
        creditsService.collectAffiliateInferenceFallback({
          organizationId: charge.organizationId,
          userId: charge.userId,
          requestId: charge.requestId,
          model: charge.model,
          provider: charge.provider,
          billingSource: charge.billingSource,
          actualCost: actualCostUsd,
          reservationMetadata,
        });
      const result: OrganizationInferenceAdmission = {
        mode: "durable_object_affiliate_debit",
        settle,
        settleUnknown: () => settle(estimatedCostUsd),
        reservation: {
          reservedAmount: estimatedCostUsd,
          reservationTransactionId: null,
          affiliateAttribution,
          affiliatePayoutSourceId,
          reconcile: settle,
        },
        affiliateAttribution,
      };
      return attachInferenceAdmissionLease(result, inferenceLease);
    }

    const settle = async (actualCostUsd: number): Promise<CreditReconciliationResult> => {
      if (actualCostUsd <= 0) {
        return {
          reservedAmount: 0,
          actualCost: 0,
          settlementTransactionIds: [],
          adjustmentType: "none",
        };
      }
      const outcome = await debitInferenceCost(debit, actualCostUsd, "deferred");
      return {
        reservedAmount: outcome.collectedAmountUsd,
        actualCost: actualCostUsd,
        collectedAmount: outcome.collectedAmountUsd,
        settlementTransactionIds: outcome.transactionId ? [outcome.transactionId] : [],
        adjustmentType:
          outcome.status === "collected" && outcome.collectedAmountUsd + 0.000001 >= actualCostUsd
            ? "none"
            : "uncollected_overage",
      };
    };
    return attachInferenceAdmissionLease(
      {
        mode: "durable_object_debit",
        settle,
        settleUnknown: () => settle(estimatedCostUsd),
        reservation: {
          reservedAmount: estimatedCostUsd,
          reservationTransactionId: null,
          affiliateAttribution: null,
          affiliatePayoutSourceId: null,
          reconcile: settle,
        },
        affiliateAttribution: null,
      },
      inferenceLease,
    );
  }

  if (useDbLedger) {
    const admission = await admitInferenceChargeViaLedger({
      charge,
      estimatedCostUsd,
      thresholdUsd,
    });
    if (admission.admitted) {
      const settle = createLedgerDebitSettler(charge);
      return {
        mode: "synchronous_db_ledger",
        settle,
        settleUnknown: () => settle(estimatedCostUsd),
      };
    }
    return await reserveSynchronously(params, false);
  }

  if (isOptimisticBackstopAvailable()) {
    const admitted = await writePendingInferenceCharge({ ...charge, estimatedCostUsd }, Date.now());
    if (admitted) {
      const settle = createOptimisticDebitSettler(debit);
      return {
        mode: "synchronous_kv_ledger",
        settle,
        settleUnknown: () => settle(estimatedCostUsd),
      };
    }
  }

  return await reserveSynchronously(params, false);
}
