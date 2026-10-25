/** Bounded read-only original-grant observation recovery on the existing maintenance lane. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { observeAndRecordRenewalAdjustment } from "../../db/repositories/subscription-adjustment-observations";
import {
  claimRenewalAdjustment,
  deferUnavailableRenewalAdjustment,
  failRenewalAdjustment,
  listDueRenewalAdjustmentGrants,
  readAdjustmentIncidentSource,
} from "../../db/repositories/subscription-adjustment-recovery";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import { createStripeRecoveryClient } from "../stripe";

async function report(
  input: { organizationId: string; grantId: string },
  reason: "original_unavailable" | "observation_unavailable",
) {
  const source = await readAdjustmentIncidentSource(input);
  await operations.openIncident({
    organizationId: source.organizationId,
    subscriptionId: source.subscriptionId,
    commandId: null,
    eventReceiptId: null,
    kind: "reconciliation",
    severity: "warning",
    fingerprint: createHash("sha256")
      .update(`renewal-adjustment:${source.organizationId}:${source.grantId}:${reason}`)
      .digest("hex"),
    context: { reason, observedBy: "renewal_adjustment_maintenance", grantId: source.grantId },
    nextRetryAt: null,
    now: new Date(),
  });
}

export async function recoverRenewalAdjustmentObservations() {
  const deadline = Date.now() + 20_000;
  const candidates = await listDueRenewalAdjustmentGrants(5);
  const attempts: Array<{ grantId: string; attemptId?: string; disposition: string }> = [];
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    let claim: Awaited<ReturnType<typeof claimRenewalAdjustment>>;
    try {
      claim = await claimRenewalAdjustment(candidate);
    } catch (error) {
      // error-policy:J1 Claim authority failures remain visible without starving later grants.
      // Database and unexpected errors fail the lane rather than becoming missing evidence.
      if (
        !(error instanceof ElizaError) ||
        ![
          "SUBSCRIPTION_ADJUSTMENT_CLAIM_UNAVAILABLE",
          "SUBSCRIPTION_ADJUSTMENT_OBSERVATION_UNAVAILABLE",
          "SUBSCRIPTION_RENEWAL_DETAILS_CONFLICT",
          "SUBSCRIPTION_SETTLEMENT_DETAILS_CONFLICT",
          "SUBSCRIPTION_RENEWAL_AUTHORITY_CONFLICT",
          "SUBSCRIPTION_ORGANIZATION_SOURCE_UNAVAILABLE",
        ].includes(error.code)
      )
        throw error;
      await report(candidate, "original_unavailable");
      await deferUnavailableRenewalAdjustment(candidate);
      attempts.push({ grantId: candidate.grantId, disposition: "original_unavailable" });
      continue;
    }
    if (!claim) continue;
    try {
      await observeAndRecordRenewalAdjustment(
        claim.request,
        createStripeRecoveryClient(deadline),
        claim.identity,
      );
      attempts.push({
        grantId: candidate.grantId,
        attemptId: claim.identity.attemptId,
        disposition: "recorded",
      });
    } catch {
      // error-policy:J1 Preserve a durable incident before backoff; unknown provider outcomes never post money.
      await report(candidate, "observation_unavailable");
      try {
        await failRenewalAdjustment(claim.identity, "provider_unavailable");
      } catch (failure) {
        // error-policy:J1 Expired/superseded attempts remain owned by their generation for later reclaim.
        if (
          !(failure instanceof ElizaError) ||
          failure.code !== "SUBSCRIPTION_ADJUSTMENT_LEASE_LOST"
        )
          throw failure;
        attempts.push({
          grantId: candidate.grantId,
          attemptId: claim.identity.attemptId,
          disposition: "lease_lost",
        });
        continue;
      }
      attempts.push({
        grantId: candidate.grantId,
        attemptId: claim.identity.attemptId,
        disposition: "unavailable",
      });
    }
  }
  return {
    status: attempts.some((a) => a.disposition !== "recorded") ? "degraded" : "ok",
    attempts,
  };
}
