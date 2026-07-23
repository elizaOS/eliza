/**
 * Cache-gated admission for organization-funded inference.
 *
 * The warm Worker path reads only the balance hint and immediately starts a
 * durable pending-charge admission under `waitUntil`; Postgres reservation and
 * settlement remain the fail-closed fallback for non-eligible requests. This
 * keeps the money policy identical across OpenAI, Anthropic, and shared-runtime
 * chat surfaces instead of letting each route drift into a different gate.
 */

import { calculateCost, normalizeModelName } from "../pricing";
import { createCreditReservationSettler } from "../utils/credit-reservation";
import type { BillingContext } from "./ai-billing";
import { reserveCredits } from "./ai-billing";
import type { CreditReconciliationResult } from "./credits";
import {
  createDeferredAdmissionSettler,
  type DeferredAdmissionOutcome,
  isDeferredAdmissionEnabled,
  isOrgAdmissionRefused,
} from "./inference-billing-deferred";
import {
  createOptimisticDebitSettler,
  getGateBalanceUsd,
  isOptimisticBackstopAvailable,
  isOptimisticBillingEnabled,
  isOptimisticEligible,
  resolveSafeBalanceThresholdUsd,
  writePendingInferenceCharge,
} from "./inference-billing-fast-path";
import {
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler,
  resolveInferenceBillingLedger,
} from "./inference-billing-ledger";

export type InferenceAdmissionMode =
  | "deferred_db_ledger"
  | "deferred_kv_ledger"
  | "synchronous_db_ledger"
  | "synchronous_kv_ledger"
  | "synchronous_reservation";

export interface OrganizationInferenceAdmission {
  mode: InferenceAdmissionMode;
  settle(actualCostUsd: number): Promise<CreditReconciliationResult | null>;
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
  affiliateCode?: string | null;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

async function reserveSynchronously(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  const reservation = await reserveCredits(
    {
      ...params.context,
      affiliateCode: params.affiliateCode ?? undefined,
    },
    params.estimatedInputTokens,
    params.estimatedOutputTokens,
  );
  return {
    mode: "synchronous_reservation",
    settle: createCreditReservationSettler(reservation),
  };
}

/**
 * Admit one organization-credit inference request.
 *
 * Affiliate-marked requests retain the synchronous reservation because their
 * markup and earnings clamp are reservation-coupled. For ordinary production
 * requests, a warm balance hint is the only pre-model read; the ledger write
 * and actual-cost debit are ordered under the post-response settler.
 */
export async function admitOrganizationInference(
  params: OrganizationInferenceAdmissionParams,
): Promise<OrganizationInferenceAdmission> {
  const workerHotPath = typeof params.executionCtx?.waitUntil === "function";
  const optimisticAllowed = isOptimisticBillingEnabled() && (params.affiliateCode ?? null) === null;
  if (!optimisticAllowed) {
    // Optimistic billing OFF (or affiliate-marked) means the operator chose the
    // synchronous-reserve semantics everywhere, Workers included. Failing the
    // request instead would turn the standard flag rollback into an outage.
    return await reserveSynchronously(params);
  }

  const normalizedModel = normalizeModelName(params.context.model);
  const { totalCost: estimatedCostUsd } = await calculateCost(
    normalizedModel,
    params.context.provider,
    params.estimatedInputTokens,
    params.estimatedOutputTokens,
    params.context.billingSource,
  );
  const thresholdUsd = resolveSafeBalanceThresholdUsd();
  const useDbLedger = resolveInferenceBillingLedger() === "db";
  const canDefer =
    isDeferredAdmissionEnabled() &&
    workerHotPath &&
    (useDbLedger || isOptimisticBackstopAvailable());

  // A recently refused org skips the deferred fast path entirely (mirrors the
  // chat/completions envelope): the synchronous reserve is the authoritative
  // 402 producer, and the blocklist keeps a drained org from farming the
  // deferred window while its balance hint is stale.
  if (canDefer && isOrgAdmissionRefused(params.context.organizationId)) {
    return await reserveSynchronously(params);
  }

  const balanceUsd = await getGateBalanceUsd(params.context.organizationId, {
    executionCtx: params.executionCtx,
    cacheOnly: canDefer,
  });
  if (
    !isOptimisticEligible({
      enabled: true,
      useAppCredits: false,
      balanceUsd,
      thresholdUsd,
      estimatedCostUsd,
    })
  ) {
    // SAFE_BALANCE_THRESHOLD is a "skip the sync reserve" bar, not a
    // service-eligibility floor: a funded org below it must still be served
    // through the fail-closed Postgres reservation (which produces the real
    // 402 when the balance genuinely cannot cover the request).
    return await reserveSynchronously(params);
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
    const admission: Promise<DeferredAdmissionOutcome> = useDbLedger
      ? admitInferenceChargeViaLedger({
          charge,
          estimatedCostUsd,
          thresholdUsd,
        })
      : writePendingInferenceCharge({ ...charge, estimatedCostUsd }, Date.now()).then(
          (admitted) => ({ admitted }),
        );
    params.executionCtx.waitUntil(admission);
    return {
      mode: useDbLedger ? "deferred_db_ledger" : "deferred_kv_ledger",
      settle: createDeferredAdmissionSettler({
        admission,
        onAdmitted: useDbLedger
          ? createLedgerDebitSettler(charge)
          : createOptimisticDebitSettler(debit),
        fallback: debit,
      }),
    };
  }

  if (useDbLedger) {
    const admission = await admitInferenceChargeViaLedger({
      charge,
      estimatedCostUsd,
      thresholdUsd,
    });
    if (admission.admitted) {
      return {
        mode: "synchronous_db_ledger",
        settle: createLedgerDebitSettler(charge),
      };
    }
    return await reserveSynchronously(params);
  }

  if (isOptimisticBackstopAvailable()) {
    const admitted = await writePendingInferenceCharge({ ...charge, estimatedCostUsd }, Date.now());
    if (admitted) {
      return {
        mode: "synchronous_kv_ledger",
        settle: createOptimisticDebitSettler(debit),
      };
    }
  }

  return await reserveSynchronously(params);
}
