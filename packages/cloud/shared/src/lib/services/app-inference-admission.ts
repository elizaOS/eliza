/**
 * Cache-gated admission for monetized-app inference in Workers.
 *
 * The request promise reads only cached policy and a Durable Object balance
 * lease. Atomic app accounting starts after provider work under `waitUntil`;
 * the lease alarm replays the same server-generated reservation identity if
 * that post-response task disappears.
 */

import type { App } from "../../db/repositories/apps";
import { createCreditReservationSettler } from "../utils/credit-reservation";
import { logger } from "../utils/logger";
import { computeInferenceCharge, isAppMonetizationActive } from "./app-credit-math";
import { appCreditsService } from "./app-credits";
import { projectAppUsageForDebit } from "./app-usage-projections";
import {
  type CreditReconciliationResult,
  creditsService,
  InsufficientCreditsError,
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
  type InferenceAdmissionSnapshot,
  invalidateOrgBalanceHint,
  writeOrgBalanceHint,
} from "./inference-auth-cache";
import { clearOrgAdmissionRefused, markOrgAdmissionRefused } from "./inference-billing-deferred";
import {
  getGateBalanceHint,
  InferenceBalanceCacheWarmingError,
} from "./inference-billing-fast-path";

export interface AppInferenceAdmissionExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface AppInferenceAdmissionParams {
  app: App;
  appId: string;
  userId: string;
  organizationId: string;
  estimatedBaseCostUsd: number;
  description: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  requestId: string;
  model: string;
  provider: string;
  billingSource: string;
  affiliateCode?: string | null;
  executionCtx: AppInferenceAdmissionExecutionContext;
  /** Combined auth-cache projection; skips the separate balance KV read. */
  admissionSnapshot?: InferenceAdmissionSnapshot;
}

export interface AppInferenceAdmission {
  mode: "deferred_app_reservation";
  estimatedTotalCostUsd: number;
  settle(actualBaseCostUsd: number): Promise<CreditReconciliationResult | null>;
  settleUnknown(): Promise<CreditReconciliationResult | null>;
  markProviderDispatched(): Promise<void>;
}

/**
 * App markup and affiliate markup are separate cashable allocations. Until a
 * single atomic composite charge owns both splits, accepting both could mint
 * one payout without collecting the other.
 */
export class InferenceAppAffiliateUnsupportedError extends Error {
  constructor(readonly appId: string) {
    super("App monetization and affiliate attribution cannot be combined for one inference charge");
    this.name = "InferenceAppAffiliateUnsupportedError";
  }
}

/** Enforce the composite-allocation guard for Worker and non-Worker callers. */
export function assertInferenceAppAffiliateSupported(
  appId: string,
  affiliateCode: string | null | undefined,
): void {
  if (affiliateCode?.trim()) {
    throw new InferenceAppAffiliateUnsupportedError(appId);
  }
}

const balanceRefreshes = new Map<string, Promise<void>>();

function chargeForBaseCost(app: App, baseCostUsd: number): number {
  return computeInferenceCharge(baseCostUsd, {
    monetizationEnabled: isAppMonetizationActive(app),
    platformOffsetAmount: app.platform_offset_amount,
    purchaseSharePercentage: app.purchase_share_percentage,
    inferenceMarkupPercentage: app.inference_markup_percentage,
  }).totalCost;
}

function refreshBalanceHintAfterSettlement(organizationId: string): Promise<void> {
  const existing = balanceRefreshes.get(organizationId);
  if (existing) return existing;
  const balanceAt = Date.now();
  const refresh = creditsService
    .getOrganizationBalanceSnapshot(organizationId)
    .then(async (snapshot) => {
      await writeOrgBalanceHint(organizationId, snapshot.balanceUsd, balanceAt, snapshot.revision);
      clearOrgAdmissionRefused(organizationId);
    })
    .catch(async (error) => {
      markOrgAdmissionRefused(organizationId);
      let invalidationError: unknown;
      try {
        await invalidateOrgBalanceHint(organizationId);
      } catch (cause) {
        invalidationError = cause;
      }
      logger.warn("[AppInferenceAdmission] Balance-hint refresh failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (invalidationError !== undefined) {
        throw new AggregateError(
          [error, invalidationError],
          "Balance refresh and fail-closed invalidation both failed",
        );
      }
      // error-policy:J2 the database settlement is complete, but cache repair
      // must remain retryable before the refusal guard can be cleared.
      throw error;
    })
    .finally(() => {
      balanceRefreshes.delete(organizationId);
    });
  balanceRefreshes.set(organizationId, refresh);
  return refresh;
}

async function blockAppAdmissionAfterFailure(
  organizationId: string,
  failure: unknown,
): Promise<never> {
  markOrgAdmissionRefused(organizationId);
  try {
    await invalidateOrgBalanceHint(organizationId);
  } catch (invalidationError) {
    throw new AggregateError(
      [failure, invalidationError],
      "App accounting and fail-closed cache invalidation both failed",
    );
  }
  throw failure;
}

/** Test hook: isolate post-settlement cache refresh state between cases. */
export function __clearAppInferenceAdmissionStateForTests(): void {
  balanceRefreshes.clear();
}

/**
 * Admit a monetized-app request from cached money state only.
 *
 * A full balance-cache miss throws `InferenceBalanceCacheWarmingError` through
 * `getGateBalanceHint`, after registering its authoritative hydration. A cached
 * insufficient balance throws the same typed 402 error as synchronous app
 * reservation without starting model work.
 */
export async function admitAppInferenceCacheOnly(
  params: AppInferenceAdmissionParams,
): Promise<AppInferenceAdmission> {
  assertInferenceAppAffiliateSupported(params.appId, params.affiliateCode);

  const reservedBaseCostUsd = Math.max(params.estimatedBaseCostUsd, MIN_RESERVATION);
  const estimatedTotalCostUsd = chargeForBaseCost(params.app, reservedBaseCostUsd);
  const balanceHint = params.admissionSnapshot
    ? params.admissionSnapshot.balance
    : await getGateBalanceHint(params.organizationId, {
        cacheOnly: true,
        executionCtx: params.executionCtx,
      });
  if (balanceHint.balanceUsd < estimatedTotalCostUsd) {
    throw new InsufficientCreditsError(
      estimatedTotalCostUsd,
      balanceHint.balanceUsd,
      "cached_balance_gate",
    );
  }
  const leaseCostUsd = Math.max(estimatedTotalCostUsd, MIN_RESERVATION);
  let inferenceLease: InferenceAdmissionLease;
  try {
    inferenceLease = await acquireInferenceAdmissionLease({
      organizationId: params.organizationId,
      requestId: params.requestId,
      balanceUsd: balanceHint.balanceUsd,
      balanceRevision: balanceHint.balanceRevision,
      estimatedCostUsd: leaseCostUsd,
      recovery: {
        version: 1,
        kind: "app",
        organizationId: params.organizationId,
        requestId: params.requestId,
        userId: params.userId,
        model: params.model,
        provider: params.provider,
        billingSource: params.billingSource,
        description: params.description,
        ...(params.metadata && { metadata: params.metadata }),
        appId: params.appId,
        estimatedBaseCostUsd: params.estimatedBaseCostUsd,
        appPolicy: {
          name: params.app.name,
          creatorUserId: params.app.created_by_user_id,
          monetizationEnabled: params.app.monetization_enabled,
          reviewStatus: params.app.review_status ?? null,
          platformOffsetAmount: params.app.platform_offset_amount ?? null,
          purchaseSharePercentage: params.app.purchase_share_percentage ?? null,
          inferenceMarkupPercentage: params.app.inference_markup_percentage ?? null,
        },
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
      throw new InferenceBalanceCacheWarmingError();
    }
    throw error;
  }

  let settlement: Promise<CreditReconciliationResult | null> | null = null;
  let firstActualBaseCostUsd: number | null = null;
  let usageProjectionTransactionId: string | null = null;

  const settle = async (actualBaseCostUsd: number): Promise<CreditReconciliationResult | null> => {
    let reservation: Awaited<ReturnType<typeof appCreditsService.reserveInferenceCredits>>;
    try {
      reservation = await appCreditsService.reserveInferenceCredits({
        appId: params.appId,
        userId: params.userId,
        organizationId: params.organizationId,
        // Recovery and the normal settler must quote the same immutable
        // estimate. Actual usage is applied only by reconciliation below.
        estimatedBaseCost: params.estimatedBaseCostUsd,
        description: params.description,
        idempotencyKey: params.requestId,
        retainChargeOnPostDebitFailure: true,
        metadata: params.metadata,
        app: params.app,
      });
      usageProjectionTransactionId = reservation.reservationTransactionId ?? null;
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        markOrgAdmissionRefused(params.organizationId);
        await invalidateOrgBalanceHint(params.organizationId);
        return {
          reservedAmount: 0,
          actualCost: chargeForBaseCost(params.app, actualBaseCostUsd),
          settlementTransactionIds: [],
          adjustmentType: "uncollected_overage",
        };
      }
      return await blockAppAdmissionAfterFailure(params.organizationId, error);
    }
    const reservationSettler = createCreditReservationSettler(reservation);
    try {
      const reconciliation = await reservationSettler(actualBaseCostUsd);
      await refreshBalanceHintAfterSettlement(params.organizationId);
      return reconciliation;
    } catch (error) {
      return await blockAppAdmissionAfterFailure(params.organizationId, error);
    }
  };

  const settleTerminal = (
    actualBaseCostUsd: number,
  ): Promise<CreditReconciliationResult | null> => {
    if (firstActualBaseCostUsd === null) firstActualBaseCostUsd = actualBaseCostUsd;
    if (settlement) return settlement;
    const current = (async () => {
      if ((firstActualBaseCostUsd ?? 0) > 0) {
        await markInferenceAdmissionLeaseDispatched(inferenceLease);
      }
      const reconciliation = await settle(firstActualBaseCostUsd ?? 0);
      const actualTotalCostUsd =
        reconciliation?.actualCost ?? chargeForBaseCost(params.app, firstActualBaseCostUsd ?? 0);
      const amounts = inferenceSettlementAmounts(
        inferenceLease,
        actualTotalCostUsd,
        reconciliation,
      );
      await settleInferenceAdmissionLease(
        inferenceLease,
        amounts.balanceBackedUsd,
        amounts.gateConsumedUsd,
      );
      if (usageProjectionTransactionId) {
        try {
          await projectAppUsageForDebit(usageProjectionTransactionId);
        } catch (error) {
          // error-policy:J7 the debit is the durable source event and the
          // reservation sweep retries projection; analytics cannot reopen a
          // completed money settlement or keep the gate lease held.
          logger.warn("[AppInferenceAdmission] Usage projection deferred to sweep", {
            transactionId: usageProjectionTransactionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return reconciliation;
    })();
    settlement = current;
    current.then(
      () => undefined,
      () => {
        // error-policy:J5 the caller observes the original rejection; reset
        // only so a keyed settlement retry can heal its partial commit.
        if (settlement === current) settlement = null;
      },
    );
    return current;
  };

  return {
    mode: "deferred_app_reservation",
    estimatedTotalCostUsd,
    settle: settleTerminal,
    settleUnknown: () => settleTerminal(reservedBaseCostUsd),
    markProviderDispatched: () => markInferenceAdmissionLeaseDispatched(inferenceLease),
  };
}
