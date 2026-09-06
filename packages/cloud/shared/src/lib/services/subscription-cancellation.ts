/** Executes manager-authorized organization period-end cancellation and retrieves uncertain outcomes through the same durable command owner. Recovery never invents session authority or sends a provider mutation. */
import { ElizaError } from "@elizaos/core";
import {
  assertCancellationClaimCurrent,
  type CancellationClaim,
  type CancellationIdentity,
  claimCancellation,
  finalizeCancellation,
  listCancellationRecovery,
  type PrepareCancellationInput,
  prepareCancellation,
  readCancellation,
  releaseCancellation,
  rotateCancellationRecovery,
} from "../../db/repositories/subscription-cancellation";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import type { OrganizationSubscriptionCancellationDto } from "../types/cloud-api";
import { logger } from "../utils/logger";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";

function toDto(command: BillingSubscriptionCommand): OrganizationSubscriptionCancellationDto {
  if (
    command.kind !== "cancel" ||
    command.subscription_id === null ||
    command.expected_subscription_revision === null ||
    command.status === "SUCCEEDED"
  )
    throw new ElizaError("Cancellation command state is unavailable", {
      code: "SUBSCRIPTION_CANCELLATION_REOBSERVE",
    });
  return {
    commandId: command.id,
    subscriptionId: command.subscription_id,
    status: command.status,
    expectedSubscriptionRevision: String(command.expected_subscription_revision),
    resultSubscriptionRevision:
      command.result_subscription_revision === null
        ? null
        : String(command.result_subscription_revision),
  };
}
async function executeClaim(
  input: CancellationIdentity,
  claim: CancellationClaim,
  revalidateSession: (() => Promise<void>) | null,
) {
  let sessionFailure = false;
  async function verifySession() {
    if (revalidateSession === null) return;
    try {
      await revalidateSession();
    } catch (error) {
      // error-policy:J2 preserve the actual credential boundary failure after releasing this attempt.
      sessionFailure = true;
      throw error;
    }
  }
  try {
    await verifySession();
    await assertCancellationClaimCurrent(input, claim);
    const stripe = requireStripe();
    async function verifyCustomer() {
      const raw = await stripe.customers.retrieve(claim.source.stripe_customer_id);
      validateCancellationCustomer({
        raw,
        source: claim.source,
        organizationCustomerId: claim.organizationCustomerId,
        environment: getCloudAwareEnv(),
      });
    }
    await verifyCustomer();
    let raw = await stripe.subscriptions.retrieve(claim.source.stripe_subscription_id);
    const initial = validatePeriodEndCancellationObservation({
      source: claim.source,
      organizationCustomerId: claim.organizationCustomerId,
      environment: getCloudAwareEnv(),
      raw,
      observedAt: new Date(),
      requireScheduled: false,
    });
    if (!initial.scheduled && claim.canDispatch && revalidateSession !== null) {
      await verifyCustomer();
      await verifySession();
      await assertCancellationClaimCurrent(input, claim, true);
      // Stripe has no local lifecycle-revision CAS. A concurrent remote period/plan change
      // is detected by the final retrieval and prevents local publication, even after an accepted mutation.
      await stripe.subscriptions.update(
        claim.source.stripe_subscription_id,
        { cancel_at_period_end: true },
        { idempotencyKey: claim.command.provider_idempotency_key },
      );
      raw = await stripe.subscriptions.retrieve(claim.source.stripe_subscription_id);
    } else if (!initial.scheduled) {
      await releaseCancellation(input, claim);
      return toDto(await readCancellation({ ...input, commandId: claim.command.id }));
    }
    await verifyCustomer();
    await verifySession();
    return toDto(await finalizeCancellation(input, claim, raw));
  } catch (error) {
    // error-policy:J1 the committed OUTCOME_UNKNOWN command is the visible result
    // of an unconfirmed provider attempt; no source or success is fabricated.
    logger.warn("[Subscription Cancellation] Provider attempt remains unconfirmed", {
      commandId: claim.command.id,
      code: error instanceof ElizaError ? error.code : "PROVIDER_OUTCOME_UNKNOWN",
    });
    await releaseCancellation(input, claim);
    if (sessionFailure) throw error;
    return toDto(await readCancellation({ ...input, commandId: claim.command.id }));
  }
}
export async function submitOrganizationSubscriptionCancellation(
  input: PrepareCancellationInput,
  revalidateSession: () => Promise<void>,
): Promise<OrganizationSubscriptionCancellationDto> {
  await revalidateSession();
  const command = await prepareCancellation(input);
  if (command.status !== "PREPARED" && command.status !== "OUTCOME_UNKNOWN") return toDto(command);
  const claim = await claimCancellation({ ...input, commandId: command.id });
  if (!claim) return toDto(await readCancellation({ ...input, commandId: command.id }));
  return executeClaim(input, claim, revalidateSession);
}
export async function readOrganizationSubscriptionCancellation(
  input: CancellationIdentity & { commandId: string },
): Promise<OrganizationSubscriptionCancellationDto> {
  return toDto(await readCancellation(input));
}
export async function recoverOrganizationSubscriptionCancellations(
  limit: number,
): Promise<{ inspected: number; applied: number; pending: number; unavailable: number }> {
  const result = { inspected: 0, applied: 0, pending: 0, unavailable: 0 };
  for (const command of await listCancellationRecovery(limit)) {
    await rotateCancellationRecovery(command);
    result.inspected++;
    const identity = {
      organizationId: command.organization_id,
      actorId: command.requested_by_user_id,
    };
    try {
      const claim = await claimCancellation({ ...identity, commandId: command.id });
      if (!claim) {
        result.pending++;
        continue;
      }
      const dto = await executeClaim(identity, claim, null);
      if (dto.status === "APPLIED") result.applied++;
      else result.pending++;
    } catch (error) {
      // error-policy:J4 unavailable actor/source authority retains explicit pending recovery,
      // and inspection rotation prevents one unverifiable command starving other organizations.
      logger.warn("[Subscription Cancellation] Recovery authority unavailable", {
        commandId: command.id,
        code: error instanceof ElizaError ? error.code : "RECOVERY_UNAVAILABLE",
      });
      result.unavailable++;
    }
  }
  return result;
}
