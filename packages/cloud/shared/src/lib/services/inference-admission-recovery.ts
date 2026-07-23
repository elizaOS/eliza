/**
 * Reconstructs durable accounting for an expired inference admission lease.
 *
 * Durable Objects invoke this only from alarms, never from the provider-facing
 * request. Each recovery lane reuses its production idempotency key and returns
 * the authoritative post-accounting balance revision that proves the specific
 * lease can leave the gate.
 */

import { type App, appsRepository } from "../../db/repositories/apps";
import {
  type AffiliateBillingAttribution,
  isAffiliateBillingAttribution,
} from "./affiliate-billing-attribution";
import { AFFILIATE_PAYOUT_CONTRACT_VERSION } from "./affiliate-payout-outbox";
import { type AppCreditReservationAccountingApp, appCreditsService } from "./app-credits";
import { type CreditReconciliationResult, creditsService, MIN_RESERVATION } from "./credits";
import { debitInferenceCost } from "./inference-billing-fast-path";

interface RecoveryBase {
  version: 1;
  organizationId: string;
  requestId: string;
  userId: string;
  model: string;
  provider: string;
  billingSource: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface OrganizationInferenceAdmissionRecovery extends RecoveryBase {
  kind: "organization";
  accounting:
    | { kind: "direct_debit" }
    | {
        kind: "affiliate_debit";
        attribution: AffiliateBillingAttribution;
        payoutSourceId: string;
      };
}

export interface AppInferenceAdmissionRecovery extends RecoveryBase {
  kind: "app";
  appId: string;
  estimatedBaseCostUsd: number;
  appPolicy: {
    name: App["name"];
    creatorUserId: App["created_by_user_id"];
    monetizationEnabled: boolean;
    reviewStatus: App["review_status"];
    platformOffsetAmount: App["platform_offset_amount"];
    purchaseSharePercentage: App["purchase_share_percentage"];
    inferenceMarkupPercentage: App["inference_markup_percentage"];
  };
}

export type InferenceAdmissionRecoveryContext =
  | OrganizationInferenceAdmissionRecovery
  | AppInferenceAdmissionRecovery;

export interface InferenceAdmissionRecoveryResult {
  balanceUsd: number;
  balanceRevision: string;
  /** Amount reflected in the authoritative organization balance. */
  collectedUsd: number;
  /**
   * Conservative capacity consumed by this lease. This can exceed the debit
   * actually collected when an overage was refused; releasing that difference
   * would let a stale gate balance fund more provider work.
   */
  gateConsumedUsd: number;
}

interface RecoveredCharge {
  collectedUsd: number;
  gateConsumedUsd: number;
}

function recoveredCharge(
  estimatedCostUsd: number,
  reconciliation: CreditReconciliationResult | null | void,
  fallbackCollectedUsd: number,
): RecoveredCharge {
  if (!reconciliation) {
    if (!Number.isFinite(fallbackCollectedUsd) || fallbackCollectedUsd < 0) {
      throw new Error("Inference recovery returned an invalid collected amount");
    }
    return {
      collectedUsd: fallbackCollectedUsd,
      gateConsumedUsd: Math.max(estimatedCostUsd, fallbackCollectedUsd),
    };
  }
  const actualCostUsd = reconciliation.actualCost;
  const collectedUsd =
    reconciliation.collectedAmount ??
    (reconciliation.adjustmentType === "uncollected_overage"
      ? fallbackCollectedUsd
      : actualCostUsd);
  if (
    !Number.isFinite(actualCostUsd) ||
    actualCostUsd < 0 ||
    !Number.isFinite(collectedUsd) ||
    collectedUsd < 0
  ) {
    throw new Error("Inference recovery returned invalid accounting amounts");
  }
  const replayedPartialCharge =
    reconciliation.adjustmentType === "none" && collectedUsd + 0.0000001 < estimatedCostUsd;
  if (reconciliation.adjustmentType === "uncollected_overage" || replayedPartialCharge) {
    return {
      collectedUsd,
      gateConsumedUsd: Math.max(estimatedCostUsd, actualCostUsd, collectedUsd),
    };
  }
  return {
    collectedUsd,
    gateConsumedUsd: collectedUsd,
  };
}

function assertRecoveredAmount(
  lane: "app",
  requestId: string,
  expectedUsd: number,
  recoveredUsd: number,
): void {
  if (
    !Number.isFinite(recoveredUsd) ||
    recoveredUsd <= 0 ||
    Math.abs(recoveredUsd - expectedUsd) > 0.000001
  ) {
    throw new Error(`${lane} inference recovery amount mismatch for ${requestId}`);
  }
}

async function recoverAffiliateDebit(
  context: OrganizationInferenceAdmissionRecovery,
  estimatedCostUsd: number,
  accounting: Extract<
    OrganizationInferenceAdmissionRecovery["accounting"],
    { kind: "affiliate_debit" }
  >,
): Promise<RecoveredCharge> {
  const attribution = accounting.attribution;
  const sourceId = accounting.payoutSourceId;
  if (
    !isAffiliateBillingAttribution(attribution) ||
    attribution.affiliateUserId === context.userId ||
    !sourceId ||
    sourceId.trim() !== sourceId
  ) {
    throw new Error("Affiliate inference recovery requires pinned attribution and payout identity");
  }
  const reconciliation = await creditsService.collectAffiliateInferenceFallback({
    organizationId: context.organizationId,
    userId: context.userId,
    requestId: context.requestId,
    model: context.model,
    provider: context.provider,
    billingSource: context.billingSource,
    actualCost: estimatedCostUsd,
    reservationMetadata: {
      ...(context.metadata ?? {}),
      affiliatePayout: {
        version: AFFILIATE_PAYOUT_CONTRACT_VERSION,
        sourceId,
        attribution,
        model: context.model,
      },
    },
  });
  return recoveredCharge(estimatedCostUsd, reconciliation, reconciliation.reservedAmount);
}

async function recoverAppReservation(
  context: AppInferenceAdmissionRecovery,
  estimatedCostUsd: number,
): Promise<RecoveredCharge> {
  if (
    !Number.isFinite(context.estimatedBaseCostUsd) ||
    context.estimatedBaseCostUsd < 0 ||
    context.appPolicy.name.trim() === "" ||
    context.appPolicy.creatorUserId.trim() === ""
  ) {
    throw new Error("App inference recovery policy is invalid");
  }
  const current = await appsRepository.findByIdInOrganizationForWrite(
    context.appId,
    context.organizationId,
  );
  const pinnedPolicy = {
    id: context.appId,
    name: context.appPolicy.name,
    created_by_user_id: context.appPolicy.creatorUserId,
    monetization_enabled: context.appPolicy.monetizationEnabled,
    review_status: context.appPolicy.reviewStatus,
    platform_offset_amount: context.appPolicy.platformOffsetAmount,
    purchase_share_percentage: context.appPolicy.purchaseSharePercentage,
    inference_markup_percentage: context.appPolicy.inferenceMarkupPercentage,
  };
  const pinnedApp: AppCreditReservationAccountingApp = current
    ? { ...current, ...pinnedPolicy }
    : {
        ...pinnedPolicy,
        // The charge-time creator liability survives app deletion. Only the
        // FK-backed app shadow and usage counters become inapplicable.
        persistAppEarnings: false,
      };
  const reservation = await appCreditsService.reserveInferenceCredits({
    appId: context.appId,
    userId: context.userId,
    organizationId: context.organizationId,
    estimatedBaseCost: context.estimatedBaseCostUsd,
    description: context.description,
    idempotencyKey: context.requestId,
    retainChargeOnPostDebitFailure: true,
    metadata: context.metadata,
    app: pinnedApp,
  });
  assertRecoveredAmount("app", context.requestId, estimatedCostUsd, reservation.reservedAmount);
  const reconciliation = await reservation.reconcile(
    Math.max(context.estimatedBaseCostUsd, MIN_RESERVATION),
  );
  return recoveredCharge(estimatedCostUsd, reconciliation, reservation.reservedAmount);
}

async function recoverOrganizationCharge(
  context: OrganizationInferenceAdmissionRecovery,
  estimatedCostUsd: number,
): Promise<RecoveredCharge> {
  if (context.accounting.kind === "affiliate_debit") {
    return await recoverAffiliateDebit(context, estimatedCostUsd, context.accounting);
  }
  const outcome = await debitInferenceCost(
    {
      requestId: context.requestId,
      organizationId: context.organizationId,
      userId: context.userId,
      model: context.model,
      provider: context.provider,
      billingSource: context.billingSource,
    },
    estimatedCostUsd,
    "backstop",
  );
  const collectedUsd = outcome.collectedAmountUsd;
  if (
    !Number.isFinite(outcome.attemptedAmountUsd) ||
    outcome.attemptedAmountUsd < 0 ||
    !Number.isFinite(collectedUsd) ||
    collectedUsd < 0
  ) {
    throw new Error("Direct inference recovery returned invalid accounting amounts");
  }
  const partiallyCollected =
    collectedUsd + 0.0000001 < Math.max(estimatedCostUsd, outcome.attemptedAmountUsd);
  return {
    collectedUsd,
    gateConsumedUsd:
      outcome.status === "uncollected" || partiallyCollected
        ? Math.max(estimatedCostUsd, outcome.attemptedAmountUsd, collectedUsd)
        : collectedUsd,
  };
}

/**
 * Materialize or replay the exact accounting operation for one expired lease.
 * A returned balance snapshot is request-specific proof: callers must not clear
 * a lease merely because an unrelated organization revision advanced.
 */
export async function recoverExpiredInferenceAdmissionLease(
  context: InferenceAdmissionRecoveryContext,
  estimatedCostUsd: number,
): Promise<InferenceAdmissionRecoveryResult> {
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd <= 0) {
    throw new Error("Inference admission recovery cost must be positive");
  }

  const recovered =
    context.kind === "app"
      ? await recoverAppReservation(context, estimatedCostUsd)
      : await recoverOrganizationCharge(context, estimatedCostUsd);

  const snapshot = await creditsService.getOrganizationBalanceSnapshot(context.organizationId);
  return {
    balanceUsd: snapshot.balanceUsd,
    balanceRevision: snapshot.revision,
    collectedUsd: recovered.collectedUsd,
    gateConsumedUsd: recovered.gateConsumedUsd,
  };
}
