/** Runs bounded missed-event recovery using read-only provider requests on the existing cron lane; every claimed outcome is retained with primary lease and retry ownership, and policy failures open the same incident as the webhook owner. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { writeTransaction } from "../../db/helpers";
import { readConfiguredCancellationAuthority } from "../../db/repositories/configured-schedule-cancellation-authority";
import { findSubscriptionRenewalBinding } from "../../db/repositories/subscription-purchased-binding";
import {
  claimSubscriptionReconciliation,
  failSubscriptionReconciliation,
  finalizeSubscriptionReconciliation,
  listDueSubscriptionReconciliations,
} from "../../db/repositories/subscription-reconciliation";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { createStripeRecoveryClient } from "../stripe";
import { logger } from "../utils/logger";
import { observeConfiguredCancellation } from "./configured-schedule-cancellation";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { retrieveStripeDunningObservation } from "./stripe-dunning-objects";
import { retrievePaidRenewalObjects } from "./stripe-paid-renewal-objects";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import {
  hasInFlightScheduleCommand,
  unownedObservationDrift,
} from "./stripe-scheduled-cancellation-lifecycle";
import { validateStripeTerminalObservation } from "./stripe-terminal-lifecycle";
import { resolveSubscriptionProviderBinding } from "./subscription-catalog";
import { assertCheckoutProviderAuthority } from "./subscription-checkout-contract";
import { openSubscriptionIncident } from "./subscription-event-incidents";
import { subscriptionPolicyFailureReason, typedFailure } from "./subscription-lifecycle-failures";
import { findNextRenewalInvoice } from "./subscription-next-invoice";

export async function recoverMissedSubscriptionEvents() {
  const deadline = Date.now() + 20_000;
  const candidates = await listDueSubscriptionReconciliations(5);
  const results: Array<{ attemptId: string; disposition: string }> = [];
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const claim = await claimSubscriptionReconciliation(candidate);
    if (!claim) continue;
    try {
      assertOrganizationSubscription(claim.source);
      const configuredEnvironment = getCloudAwareEnv();
      const { contract, environment } = await findSubscriptionRenewalBinding(
        claim.source,
        configuredEnvironment,
      );
      const stripe = createStripeRecoveryClient(deadline);
      if (contract)
        assertCheckoutProviderAuthority(
          contract,
          (await stripe.accounts.retrieve(null)).id,
          configuredEnvironment,
        );
      const binding = resolveSubscriptionProviderBinding(
        environment,
        claim.source.plan_key,
        claim.source.catalog_version,
      );
      if (binding.expectedLivemode !== (claim.source.provider_environment === "live"))
        throw new ElizaError(
          "Recovery source environment differs from canonical provider configuration",
          { code: "SUBSCRIPTION_RECONCILIATION_UNAVAILABLE" },
        );
      const customer = await stripe.customers.retrieve(claim.source.stripe_customer_id);
      validateCancellationCustomer({
        raw: customer,
        source: claim.source,
        organizationCustomerId: claim.organizationCustomerId,
        environment,
      });
      const raw = await stripe.subscriptions.retrieve(claim.source.stripe_subscription_id);
      if (!["canceled", "incomplete_expired", "past_due", "unpaid", "active"].includes(raw.status))
        throw new ElizaError("Recovery observed a subscription status no owner supports", {
          code: "SUBSCRIPTION_RECONCILIATION_UNAVAILABLE",
          context: { reason: "unsupported_live_status", status: raw.status },
        });
      const livePeriod = z
        .object({ current_period_start: z.number().int().nonnegative().safe() })
        .safeParse(raw);
      const missedInterval =
        ["active", "past_due", "unpaid"].includes(raw.status) &&
        livePeriod.success &&
        claim.source.current_period_end !== null &&
        livePeriod.data.current_period_start * 1000 > claim.source.current_period_end.getTime();
      const nextInvoice = missedInterval
        ? await findNextRenewalInvoice({
            reader: stripe.invoices,
            subscriptionId: claim.source.stripe_subscription_id,
            customerId: claim.source.stripe_customer_id,
            livemode: claim.source.provider_environment === "live",
            paidPeriodEnd: claim.source.current_period_end!,
            observedAt: claim.observedAt,
          })
        : null;
      const receipt = nextInvoice
        ? nextInvoice.paid
          ? await finalizeSubscriptionReconciliation(claim, {
              kind: "paid_renewal",
              invoiceId: nextInvoice.invoiceId,
              objects: await retrievePaidRenewalObjects(
                claim.source,
                nextInvoice.invoiceId,
                stripe,
              ),
            })
          : await finalizeSubscriptionReconciliation(claim, {
              kind: "dunning",
              observation: await retrieveStripeDunningObservation(
                claim.source,
                raw,
                stripe,
                customer,
                { invoiceId: nextInvoice.invoiceId, observedAt: claim.observedAt },
              ),
            })
        : raw.status === "canceled" || raw.status === "incomplete_expired"
          ? await finalizeSubscriptionReconciliation(claim, {
              kind: "terminal",
              value: validateStripeTerminalObservation(raw, claim.source, environment),
            })
          : raw.status === "past_due" || raw.status === "unpaid"
            ? await finalizeSubscriptionReconciliation(claim, {
                kind: "dunning",
                observation: await retrieveStripeDunningObservation(
                  claim.source,
                  raw,
                  stripe,
                  customer,
                ),
              })
            : await (async () => {
                const period = z
                  .object({ current_period_end: z.number().int().nonnegative().safe() })
                  .safeParse(raw);
                if (
                  raw.status === "active" &&
                  period.success &&
                  period.data.current_period_end * 1000 !==
                    claim.source.current_period_end?.getTime()
                ) {
                  if (
                    typeof raw.latest_invoice !== "string" ||
                    !/^in_[A-Za-z0-9]+$/.test(raw.latest_invoice)
                  )
                    throw new ElizaError(
                      "Paid renewal recovery requires the current invoice identity",
                      { code: "SUBSCRIPTION_RECONCILIATION_UNAVAILABLE" },
                    );
                  const objects = await retrievePaidRenewalObjects(
                    claim.source,
                    raw.latest_invoice,
                    stripe,
                  );
                  return finalizeSubscriptionReconciliation(claim, {
                    kind: "paid_renewal",
                    invoiceId: raw.latest_invoice,
                    objects,
                  });
                }
                // Out-of-band plan or schedule changes are not ours to adopt.
                const authority = await writeTransaction((tx) =>
                  readConfiguredCancellationAuthority(tx, claim.source),
                );
                const drift = authority
                  ? null
                  : unownedObservationDrift(raw, claim.source, environment);
                if (
                  drift &&
                  (drift !== "cancellation_not_owned" ||
                    !(await hasInFlightScheduleCommand(claim.source)))
                )
                  throw new ElizaError("Recovery observed an out-of-band provider change", {
                    code: "SUBSCRIPTION_LIFECYCLE_UNSUPPORTED",
                    context: { reason: drift },
                  });
                const value = authority
                  ? observeConfiguredCancellation({
                      authority,
                      source: claim.source,
                      rawSubscription: raw,
                      rawSchedule: await stripe.subscriptionSchedules.retrieve(
                        authority.scheduleId,
                      ),
                      observedAt: new Date(),
                    })
                  : validatePeriodEndCancellationObservation({
                      raw,
                      source: claim.source,
                      organizationCustomerId: claim.organizationCustomerId,
                      environment,
                      observedAt: new Date(),
                      requireScheduled: claim.source.cancel_at_period_end,
                      allowRetainedCanceledAt: claim.source.canceled_at,
                    });
                return finalizeSubscriptionReconciliation(claim, {
                  kind: "owned_schedule",
                  scheduled: value.scheduled,
                  canceledAt: value.canceledAt,
                });
              })();
      results.push({ attemptId: receipt.id, disposition: receipt.disposition });
    } catch (error) {
      // error-policy:J1 The cron boundary retains this failed attempt and exposes its typed disposition, never a successful observation.
      const code =
        error instanceof ElizaError ? error.code : "SUBSCRIPTION_RECOVERY_OBSERVATION_FAILED";
      const policyReason = subscriptionPolicyFailureReason(error);
      logger.warn("[Subscription Recovery] Observation could not be finalized", {
        attemptId: claim.attemptId,
        subscriptionId: claim.subscriptionId,
        code,
        reason: typedFailure(error)?.reason ?? null,
        policyReason,
        error,
      });
      try {
        // Policy failures get the same operator incident the webhook owner opens.
        if (policyReason)
          await openSubscriptionIncident({
            source: claim,
            kind: "reconciliation",
            severity: "error",
            reason: policyReason,
            observedBy: "reconciliation",
          });
        const receipt = await failSubscriptionReconciliation(
          claim,
          policyReason ? "unsupported" : "unavailable",
          code,
        );
        results.push({ attemptId: receipt.id, disposition: receipt.disposition });
      } catch (bookkeepingError) {
        // error-policy:J2 Both the observation failure and its failed durable disposition remain visible to the cron owner.
        throw new ElizaError("Subscription recovery observation and receipt finalization failed", {
          code: "SUBSCRIPTION_RECONCILIATION_BOOKKEEPING_FAILED",
          context: { attemptId: claim.attemptId, observationCode: code },
          cause: new AggregateError([error, bookkeepingError], "Observation and receipt failures"),
        });
      }
    }
  }
  // Per-subscription degradation is reported, not raised: each failed attempt
  // is durably retained with backoff and, for policy failures, an incident.
  const degraded = results.filter(
    (result) => !["applied", "no_change"].includes(result.disposition),
  );
  if (degraded.length > 0)
    logger.warn("[Subscription Recovery] Some subscriptions could not be reconciled", {
      code: "subscription_recovery_degraded",
      attempts: degraded,
    });
  return {
    status: degraded.length > 0 ? ("degraded" as const) : ("ok" as const),
    attempts: results,
  };
}
