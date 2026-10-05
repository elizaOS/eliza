/** Bridges the existing chat billing callbacks to paired app allowance and developer infrastructure funding. */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { appsRepository } from "../../db/repositories/apps";
import {
  type AppInferenceFundingActor,
  type AppInferenceFundingRequest,
  appInferenceFundingService,
} from "./app-inference-funding";
import type { CreditReconciliationResult } from "./credits";

/** Verified delegated customer identity; developer authority is resolved separately by inference authentication. */
export interface AppInferenceDelegatedActor
  extends Omit<AppInferenceFundingActor, "developerOrganizationId"> {
  /** Revalidates revocable registered-client and delegated-user authority immediately before dispatch. */
  revalidate(): Promise<void>;
}

/** App funding always verifies the current key binding on the primary, independently of optional auth caches. */
export async function appInferenceDeveloperScope(apiKeyId: string | null): Promise<string | null> {
  return apiKeyId ? ((await appsRepository.findByApiKeyIdForWrite(apiKeyId))?.id ?? null) : null;
}

function money(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0)
    throw new ElizaError("Inference cost must be a finite nonnegative amount", {
      code: "APP_INFERENCE_AMOUNT",
    });
  return new Decimal(cost).toDecimalPlaces(6, Decimal.ROUND_CEIL).toFixed(6);
}

export async function admitAppSubscriptionInference(input: {
  actor: AppInferenceDelegatedActor;
  developerOrganizationId: string;
  developerAppScopeId: string | null;
  logicalOperationId: string;
  requestDigest: string;
  estimatedCostUsd: number;
  revalidateDeveloperCredential(): Promise<void>;
}) {
  if (input.developerAppScopeId !== input.actor.appId)
    throw new ElizaError("Inference requires the developer credential registered to this app", {
      code: "APP_INFERENCE_DEVELOPER_SCOPE",
    });
  money(input.estimatedCostUsd);
  const request: AppInferenceFundingRequest = {
    actor: {
      appId: input.actor.appId,
      billingAccountId: input.actor.billingAccountId,
      productFamilyKey: input.actor.productFamilyKey,
      environment: input.actor.environment,
      developerOrganizationId: input.developerOrganizationId,
      actorUserId: input.actor.actorUserId,
    },
    logicalOperationId: input.logicalOperationId,
    requestDigest: input.requestDigest,
    estimatedAmountUsd: money(Math.max(input.estimatedCostUsd, 0.000001)),
  };
  const funding = await appInferenceFundingService.reserve(request);
  if (!funding.dispatchGranted)
    throw new ElizaError(
      funding.status === "reserved"
        ? "This inference operation has already been admitted; its provider outcome is pending reconciliation"
        : "This inference operation has already completed",
      {
        code:
          funding.status === "reserved"
            ? "APP_INFERENCE_OUTCOME_UNKNOWN"
            : "APP_INFERENCE_OPERATION_COMPLETE",
      },
    );
  let dispatched = false;
  let dispatchClaimed = false;
  async function settle(actualCost: number): Promise<CreditReconciliationResult> {
    const actual = money(actualCost);
    const result =
      actualCost === 0
        ? await appInferenceFundingService.release(request)
        : await appInferenceFundingService.settle({ ...request, actualAmountUsd: actual });
    return {
      reservedAmount: Number(funding.reservedAmountUsd),
      actualCost: Number(actual),
      collectedAmount: Number(result.collectedAmountUsd),
      reservationTransactionId: result.infrastructureDebitTransactionId,
      settlementTransactionIds: [
        result.infrastructureDebitTransactionId,
        ...(result.infrastructureRefundTransactionId
          ? [result.infrastructureRefundTransactionId]
          : []),
      ],
      adjustmentType:
        result.uncollectedOverageUsd !== "0.000000"
          ? "uncollected_overage"
          : result.infrastructureRefundTransactionId
            ? "refund"
            : "none",
    };
  }
  return {
    settle,
    /** Unknown accepted usage retains both reservations until an authoritative actual outcome arrives. */
    settleUnknown: async (): Promise<CreditReconciliationResult | null> =>
      dispatched ? null : settle(0),
    markProviderDispatched: async () => {
      if (dispatchClaimed)
        throw new ElizaError("This inference operation has already claimed provider dispatch", {
          code: "APP_INFERENCE_OUTCOME_UNKNOWN",
        });
      // Claim synchronously before revocation checks yield so concurrent callbacks cannot both dispatch.
      dispatchClaimed = true;
      try {
        await input.actor.revalidate();
      } catch (cause) {
        // error-policy:J2 Preserve the revocation failure while exposing a safe typed inference denial.
        throw new ElizaError("App delegation is no longer authorized for inference", {
          code: "APP_INFERENCE_DELEGATION_REVOKED",
          cause,
        });
      }
      await input.revalidateDeveloperCredential();
      await appInferenceFundingService.assertDispatchCurrent(request);
      dispatched = true;
    },
  };
}

/** Translates only typed app-funding denials; unexpected database failures remain unavailable. */
export function appInferenceErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ElizaError) || !error.code.startsWith("APP_INFERENCE_")) return null;
  const status = [
    "APP_INFERENCE_PAIR_CONFLICT",
    "APP_INFERENCE_RESERVATION",
    "APP_INFERENCE_PROJECTION_UNAVAILABLE",
  ].includes(error.code)
    ? 503
    : [
          "APP_INFERENCE_OUTCOME_UNKNOWN",
          "APP_INFERENCE_OPERATION_COMPLETE",
          "APP_INFERENCE_REPLAY_CONFLICT",
        ].includes(error.code)
      ? 409
      : [
            "APP_INFERENCE_ALLOWANCE_INSUFFICIENT",
            "APP_INFERENCE_INFRASTRUCTURE_INSUFFICIENT",
          ].includes(error.code)
        ? 402
        : ["APP_INFERENCE_REQUEST", "APP_INFERENCE_AMOUNT", "APP_INFERENCE_ENVIRONMENT"].includes(
              error.code,
            )
          ? 400
          : 403;
  return Response.json(
    { error: { code: error.code, type: "app_inference_error", message: error.message } },
    { status },
  );
}
