/** Runs bounded missed-event recovery using read-only provider requests on the existing cron lane; every claimed outcome is retained with primary lease and retry ownership. */
import { ElizaError } from "@elizaos/common";
import { z } from "zod";
import { findPurchasedSubscriptionContract } from "../../db/repositories/subscription-purchased-binding";
import {
  claimSubscriptionReconciliation,
  failSubscriptionReconciliation,
  finalizeSubscriptionReconciliation,
  listDueSubscriptionReconciliations,
} from "../../db/repositories/subscription-reconciliation";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { createStripeRecoveryClient } from "../stripe";
import { logger } from "../utils/logger";
import { retrievePaidRenewalObjects } from "./stripe-paid-renewal-objects";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import { validateStripeTerminalObservation } from "./stripe-terminal-lifecycle";
import { resolveSubscriptionProviderBinding } from "./subscription-catalog";
import {
  assertCheckoutProviderAuthority,
  checkoutContractEnvironment,
} from "./subscription-checkout-contract";

export async function recoverMissedSubscriptionEvents() {
  const deadline = Date.now() + 20_000;
  const candidates = await listDueSubscriptionReconciliations(5);
  const results: Array<{ attemptId: string; disposition: string }> = [];
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const claim = await claimSubscriptionReconciliation(candidate);
    if (!claim) continue;
    try {
      const configuredEnvironment = getCloudAwareEnv();
      const contract = await findPurchasedSubscriptionContract(claim.source);
      const stripe = createStripeRecoveryClient(deadline);
      if (contract)
        assertCheckoutProviderAuthority(
          contract,
          (await stripe.accounts.retrieve(null)).id,
          configuredEnvironment,
        );
      const environment = contract
        ? checkoutContractEnvironment(contract, configuredEnvironment)
        : configuredEnvironment;
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
      const receipt =
        raw.status === "canceled" || raw.status === "incomplete_expired"
          ? await finalizeSubscriptionReconciliation(claim, {
              kind: "terminal",
              value: validateStripeTerminalObservation(raw, claim.source, environment),
            })
          : await (async () => {
              const period = z
                .object({ current_period_end: z.number().int().nonnegative().safe() })
                .safeParse(raw);
              if (
                raw.status === "active" &&
                period.success &&
                period.data.current_period_end * 1000 !== claim.source.current_period_end?.getTime()
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
              const value = validatePeriodEndCancellationObservation({
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
      logger.warn("[Subscription Recovery] Observation could not be finalized", {
        attemptId: claim.attemptId,
        code,
        error,
      });
      try {
        const receipt = await failSubscriptionReconciliation(claim, "unavailable", code);
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
  return {
    status: results.some((result) => !["applied", "no_change"].includes(result.disposition))
      ? ("degraded" as const)
      : ("ok" as const),
    attempts: results,
  };
}
