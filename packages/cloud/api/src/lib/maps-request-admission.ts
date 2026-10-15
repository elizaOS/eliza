/** P-56 Maps admission: separate request units, no inference credit reservation/debit. */

import { readStewardSessionToken } from "@elizaos/cloud-shared/auth";
import { verifyStewardTokenCached } from "@elizaos/cloud-shared/lib/auth/steward-client";
import { callMapsRequestAllowance } from "@elizaos/cloud-shared/lib/services/inference-admission-gate";
import {
  type InferenceCredentialCheck,
  isInferenceStrongRevocationEnabled,
} from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";
import type { MapsOperation } from "@elizaos/cloud-shared/lib/services/maps/contract";
import type {
  MapsAllowanceRequest,
  MapsUsageOutcome,
} from "@elizaos/cloud-shared/lib/services/maps-request-policy";
import { withOrganizationPolicyReadAdmission } from "@elizaos/cloud-shared/lib/services/organization-policy-admission";
import { readOrganizationEntitlementSummary } from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { requireGenerativeRouteCaller } from "./generative-route-auth";

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
  return { ...caller.user, credential };
}
export type MapsCompletion = (outcome: MapsUsageOutcome) => Promise<void>;
export async function admitMapsRequest(
  c: AppContext,
  caller: MapsCaller,
  operation: MapsOperation,
): Promise<MapsCompletion> {
  if (!isInferenceStrongRevocationEnabled() || !caller.credential)
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
  const request = await withOrganizationPolicyReadAdmission(
    caller.organization_id,
    undefined,
    async (policy) => {
      const summary = await readOrganizationEntitlementSummary(
        caller.organization_id,
      );
      if (
        !policy.subscriptionFunded ||
        !["active", "trialing"].includes(summary.plan.status)
      )
        throw new MapsAdmissionError(
          403,
          "subscription_required",
          "An active Eliza subscription is required for Maps.",
        );
      if (operation === "coverage") return null;
      if (!summary.rateTier)
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
          planKey: summary.rateTier,
          subscriptionFunded: true,
        },
      };
      let response: Response;
      try {
        response = await callMapsRequestAllowance(admission);
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
  return async (outcome) => {
    if (!request) return;
    const response = await callMapsRequestAllowance(request, outcome);
    if (!response.ok) throw new Error("Maps usage outcome was not recorded");
  };
}
