/** Maps plan allowance or provider-cost credit funding, with one request receipt. */
import { createHash } from "node:crypto";

import { readStewardSessionToken } from "@elizaos/cloud-shared/auth";
import { verifyStewardTokenCached } from "@elizaos/cloud-shared/lib/auth/steward-client";
import { isSubscriptionFundedReservation } from "@elizaos/cloud-shared/lib/services/allowance-first-credits";
import { InsufficientCreditsError } from "@elizaos/cloud-shared/lib/services/credits";
import { callMapsRequestAllowance } from "@elizaos/cloud-shared/lib/services/inference-admission-gate";
import type { InferenceAdmissionSnapshot } from "@elizaos/cloud-shared/lib/services/inference-auth-cache";
import type { InferenceCredentialCheck } from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";
import type {
  MapsOperation,
  MapsPriceObserver,
  MapsProviderPrice,
} from "@elizaos/cloud-shared/lib/services/maps/contract";
import type {
  MapsAllowanceRequest,
  MapsUsageOutcome,
} from "@elizaos/cloud-shared/lib/services/maps-request-policy";
import {
  admitOrganizationInference,
  type OrganizationInferenceAdmission,
} from "@elizaos/cloud-shared/lib/services/organization-inference-admission";
import { withOrganizationPolicyReadAdmission } from "@elizaos/cloud-shared/lib/services/organization-policy-admission";
import { requireOrganizationPolicyBalance } from "@elizaos/cloud-shared/lib/services/organization-quota-policy";
import { readOrganizationEntitlementSummary } from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
import {
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
  resolveInferenceCredentialAdmissionDenial,
} from "./generative-route-auth";

export class MapsAdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export interface MapsCaller {
  id: string;
  organization_id: string;
  credential?: InferenceCredentialCheck;
  apiKeyId?: string | null;
  admissionSnapshot?: InferenceAdmissionSnapshot;
}
export async function authenticateMapsCaller(
  c: AppContext,
): Promise<MapsCaller> {
  // Reuse identity cache/revocation logic, but never invoke inference admission or its rate bucket.
  const caller = await requireGenerativeRouteCaller(c);
  let credential = caller.credential;
  if (!credential && caller.apiKeyId)
    credential = {
      kind: "api_key",
      credentialId: caller.apiKeyId,
      userId: caller.user.id,
    };
  if (!credential) {
    const token = readStewardSessionToken(c);
    const claims = token ? await verifyStewardTokenCached(c.env, token) : null;
    if (claims)
      credential = {
        kind: "steward_session",
        userId: caller.user.id,
        stewardUserId: claims.userId,
        issuedAt: claims.issuedAt,
      };
  }
  return {
    ...caller.user,
    credential,
    apiKeyId: caller.apiKeyId,
    admissionSnapshot: caller.admissionSnapshot,
  };
}
export type MapsCompletion = ((outcome: MapsUsageOutcome) => Promise<void>) & {
  recordProviderPrice?: MapsPriceObserver;
};
export async function admitMapsRequest(
  c: AppContext,
  caller: MapsCaller,
  operation: MapsOperation,
  quote?: () => MapsProviderPrice | undefined,
): Promise<MapsCompletion> {
  const namespace = c.env.INFERENCE_ADMISSION_GATES;
  if (!namespace || !caller.credential)
    throw new MapsAdmissionError(
      503,
      "maps_allowance_unconfigured",
      "Maps requires configured credential revocation and request allowance authority.",
    );
  if (c.req.raw.signal.aborted)
    throw new MapsAdmissionError(
      408,
      "maps_request_cancelled",
      "Maps request was cancelled before admission.",
    );
  const requestId = c.req.header("Idempotency-Key");
  if (
    operation !== "coverage" &&
    operation !== "viewport" &&
    (!requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
  )
    throw new MapsAdmissionError(
      400,
      "maps_request_id_required",
      "Supply a unique Idempotency-Key for each Maps operation; do not replay an admitted request.",
    );
  // Current policy writers do not synchronously publish every generation to the DO.
  // Keep the primary read lock through durable admission: cached generation equality
  // is not a revocation fence. This is deliberately not a cache-only latency claim.
  let creditFunded = false;
  let price: MapsProviderPrice | undefined;
  const request = await withOrganizationPolicyReadAdmission(
    caller.organization_id,
    undefined,
    async (policy, transaction) => {
      const summary = await readOrganizationEntitlementSummary(
        caller.organization_id,
        { transaction },
      );
      const activePlan = ["active", "trialing"].includes(summary.plan.status);
      if (activePlan !== policy.subscriptionFunded)
        throw new MapsAdmissionError(
          503,
          "maps_allowance_unconfigured",
          "Maps funding state is temporarily unavailable.",
        );
      creditFunded = !activePlan;
      if (creditFunded) {
        if (requireOrganizationPolicyBalance(policy).balanceUsd <= 0)
          throw new MapsAdmissionError(
            402,
            "insufficient_credits",
            "Add balance or choose a plan to use Maps.",
          );
        if (operation !== "coverage" && operation !== "viewport") {
          price = quote?.();
          if (
            !price ||
            !Number.isFinite(price.amountUsd) ||
            price.amountUsd <= 0
          )
            throw new MapsAdmissionError(
              503,
              "maps_pricing_unavailable",
              "Maps pricing is temporarily unavailable.",
            );
        }
      }
      // Coverage and viewport copyright are metadata: entitled, never counted.
      if (operation === "coverage" || operation === "viewport") return null;
      // Inference rate overrides can change the tier without changing the subscribed plan.
      const planKey = creditFunded ? "default" : summary.plan.id;
      if (
        !creditFunded &&
        planKey !== "plus_monthly" &&
        planKey !== "pro_monthly"
      )
        throw new MapsAdmissionError(
          503,
          "maps_allowance_unconfigured",
          "Maps plan allowance is not configured.",
        );
      if (c.req.raw.signal.aborted)
        throw new MapsAdmissionError(
          408,
          "maps_request_cancelled",
          "Maps request was cancelled before admission.",
        );
      const admission: MapsAllowanceRequest = {
        organizationId: caller.organization_id,
        requestId: requestId!,
        operation,
        credential: {
          ...caller.credential!,
          organizationId: caller.organization_id,
        },
        policy: {
          ...policy.authority,
          planKey,
          subscriptionFunded: !creditFunded,
        },
      };
      let response: Response;
      try {
        response = await callMapsRequestAllowance(namespace, admission);
      } catch {
        // error-policy:J1 acknowledgement loss is unknown and must never trigger automatic replay.
        throw new MapsAdmissionError(
          503,
          "maps_admission_unknown",
          "Maps admission could not be confirmed. Do not replay this request ID.",
        );
      }
      if (!response.ok) {
        // The allowance authority answers JSON, but a crashed gate surfaces a
        // plain-text edge error page. A body parse failure must stay a
        // MapsAdmissionError, never an untyped throw past the route handler.
        const result = (await response.json().catch(() => null)) as {
          error?: { code?: string; retryAfterSeconds?: number };
          reason?: string;
        } | null;
        throw new MapsAdmissionError(
          response.status as 400 | 403 | 409 | 429 | 503,
          result?.error?.code ?? "maps_access_denied",
          result?.error?.code === "maps_allowance_unconfigured"
            ? "The operator must configure the Maps request allowance and authority."
            : "Maps request was not admitted.",
          {
            ...(result?.error?.retryAfterSeconds && {
              retryAfterSeconds: result.error.retryAfterSeconds,
            }),
          },
        );
      }
      const accepted = (await response.json().catch(() => null)) as {
        admitted?: boolean;
      } | null;
      if (accepted?.admitted !== true)
        throw new MapsAdmissionError(
          503,
          "maps_admission_unknown",
          "Maps admission was not confirmed. Do not replay this request ID.",
        );
      return admission;
    },
  );
  const record = async (outcome: MapsUsageOutcome) => {
    if (!request) return;
    const response = await callMapsRequestAllowance(
      namespace,
      request,
      outcome,
    );
    if (!response.ok) throw new Error("Maps usage outcome was not recorded");
  };
  let paid: OrganizationInferenceAdmission | undefined;
  if (creditFunded && request && price) {
    const credentialIdentity =
      request.credential.kind === "api_key"
        ? ["api_key", request.credential.credentialId]
        : [
            "steward_session",
            request.credential.stewardUserId,
            request.credential.issuedAt,
          ];
    const billingRequestId = createHash("sha256")
      .update(
        JSON.stringify([
          request.organizationId,
          credentialIdentity,
          request.requestId,
        ]),
      )
      .digest("hex");
    try {
      paid = await admitOrganizationInference({
        context: {
          organizationId: caller.organization_id,
          userId: caller.id,
          apiKeyId: caller.apiKeyId ?? null,
          requestId: `maps:${billingRequestId}`,
          provider: "google",
          // The Cloud gateway owns this published Google SKU quote.
          billingSource: "gateway",
          model: `google-maps/${price.sku}`,
          description: `Maps ${operation}`,
          metadata: {
            maps_operation: operation,
            google_sku: price.sku,
            price_version: price.priceVersion,
          },
        },
        apiKeyId: caller.apiKeyId,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        flatCost: {
          totalCost: price.amountUsd,
          baseTotalCost: price.amountUsd,
          platformMarkup: 0,
        },
        admissionSnapshot: caller.admissionSnapshot,
        credential: caller.credential,
        executionCtx: getGenerativeExecutionContext(c),
        atomicProviderBoundary: true,
        fundedBudgetEndpointType: "standard",
      });
      if (
        paid.mode === "durable_object_subscription_funding" ||
        isSubscriptionFundedReservation(paid.reservation)
      ) {
        await paid.settle(0);
        paid = undefined;
        throw new MapsAdmissionError(
          409,
          "maps_funding_changed",
          "Your plan changed. Try the Maps request again.",
        );
      }
    } catch (error) {
      try {
        await record("failed");
      } catch {
        logger.warn("[Maps] Unfunded request outcome remains unconfirmed", {
          operation,
        });
      }
      if (error instanceof InsufficientCreditsError)
        throw new MapsAdmissionError(
          402,
          "insufficient_credits",
          "Add balance or choose a plan to use Maps.",
        );
      const denial = resolveInferenceCredentialAdmissionDenial(error);
      if (denial)
        throw new MapsAdmissionError(
          denial.status,
          denial.code,
          denial.message,
        );
      throw error;
    }
  }
  let observedMicros = 0;
  let unresolvedRequest = false;
  let dispatchMarked: Promise<void> | undefined;
  const complete: MapsCompletion = async (outcome) => {
    if (paid) {
      if (unresolvedRequest) await paid.settleUnknown();
      else await paid.settle(observedMicros / 1_000_000);
    }
    await record(outcome);
  };
  if (paid && price) {
    const maximum = price;
    complete.recordProviderPrice = (observed) => {
      const micros = Math.round(observed.amountUsd * 1_000_000);
      if (
        !Number.isFinite(observed.amountUsd) ||
        observed.amountUsd < 0 ||
        !Number.isSafeInteger(micros) ||
        observedMicros + micros > Math.round(maximum.amountUsd * 1_000_000) ||
        observed.priceVersion !== maximum.priceVersion
      )
        throw new Error("Maps provider cost exceeded its admitted quote");
      observedMicros += micros;
      unresolvedRequest = false;
    };
    complete.recordProviderPrice.beforeRequest = async () => {
      dispatchMarked ??= paid!.markProviderDispatched?.() ?? Promise.resolve();
      await dispatchMarked;
      unresolvedRequest = true;
    };
    complete.recordProviderPrice.requestRejected = () => {
      unresolvedRequest = false;
    };
  }
  return complete;
}
