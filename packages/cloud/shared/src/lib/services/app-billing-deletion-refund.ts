/** Recovers previously dispatched administration refunds using provider reads only. Absence never authorizes a new refund after account fencing. */
import type Stripe from "stripe";
import { appBillingAdminFailure } from "../../db/repositories/app-billing-admin";
import type { AppBillingDeletionRecoveryAuthority } from "../../db/repositories/app-billing-deletion-authority";
import { appBillingDeletionRefundRepository } from "../../db/repositories/app-billing-deletion-refund";
import { appBillingProviderBindings } from "../../db/repositories/app-billing-provider-bindings";
import { createGenericBillingProvider } from "./generic-billing-provider";
import { getAppBillingStripe } from "./generic-billing-runtime-config";

export async function recoverAppBillingRefundForDeletion(
  commandId: string,
  authority: AppBillingDeletionRecoveryAuthority,
  stripeForMode: (livemode: boolean) => Promise<Stripe> = getAppBillingStripe,
) {
  const snapshot = await appBillingDeletionRefundRepository.inspect(commandId, authority);
  if (snapshot.kind === "superseded") return { status: "superseded" as const };
  if (snapshot.kind === "leased")
    return { status: "unresolved" as const, reason: "execution_leased" as const };
  const { command, payload, source } = snapshot;
  const provider = createGenericBillingProvider(
    await stripeForMode(source.merchant.livemode),
    source.merchant,
    appBillingProviderBindings,
  );
  const discovery =
    command.status === "OUTCOME_UNKNOWN"
      ? await provider.discoverCreatedRefund(
          source.scope,
          { ...source.invoice, amountCents: payload.amountCents },
          {
            commandId: command.id,
            idempotencyKey: command.provider_idempotency_key,
            requestDigest: command.request_digest,
          },
        )
      : null;
  if (discovery?.value.status === "absent")
    return { status: "unresolved" as const, reason: "provider_absent" as const };
  const refundId =
    discovery?.value.status === "found"
      ? discovery.value.object.refundId
      : command.provider_result?.kind === "refund"
        ? command.provider_result.refundId
        : null;
  if (!refundId) appBillingAdminFailure("Original refund has no recoverable provider receipt");
  const observation = await provider.retrieveRefund(source.scope, { ...source.invoice, refundId });
  // A changing provider status between discovery and readback requires another read pass.
  if (
    discovery?.value.status === "found" &&
    JSON.stringify(discovery.value.object) !== JSON.stringify(observation.value)
  )
    return { status: "unresolved" as const, reason: "provider_changed" as const };
  const found =
    discovery?.value.status === "found"
      ? { ...discovery, value: { status: "found" as const, object: discovery.value.object } }
      : null;
  const record = await appBillingDeletionRefundRepository.record(
    snapshot,
    authority,
    observation,
    found,
  );
  const providerStatus = observation.value.status;
  return providerStatus === "succeeded" ||
    providerStatus === "failed" ||
    providerStatus === "canceled"
    ? { status: "terminal" as const, providerStatus, observationId: record.id }
    : {
        status: "unresolved" as const,
        reason: "provider_pending" as const,
        providerStatus,
        observationId: record.id,
      };
}
