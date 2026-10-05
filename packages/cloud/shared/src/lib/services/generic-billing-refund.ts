/** Executes owner-authorized refunds through the existing command journal. Refunds preserve subscription access and never replenish infrastructure credit or consumed allowance. */
import type { AppBillingAdminOperation } from "@elizaos/cloud-sdk/app-billing-admin";
import type Stripe from "stripe";
import { writeTransaction } from "../../db/helpers";
import {
  type AppBillingOwner,
  appBillingAdminFailure,
  appBillingAdminRepository,
} from "../../db/repositories/app-billing-admin";
import { appBillingProviderBindings } from "../../db/repositories/app-billing-provider-bindings";
import {
  type AppBillingRefundSource,
  lockAppBillingRefundSource,
} from "../../db/repositories/app-billing-refund-source";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { createGenericBillingProvider } from "./generic-billing-provider";
import { settlementDigest } from "./settlement-digest";

function sourceIdentity(source: AppBillingRefundSource) {
  // Capability refreshes and sales disablement do not change historical payment ownership.
  return {
    paidPeriodId: source.paidPeriodId,
    merchant: source.merchant,
    scope: source.scope,
    invoice: source.invoice,
  };
}

async function authorize(owner: AppBillingOwner, command: BillingSubscriptionCommand) {
  const payload = command.request_payload;
  if (payload?.domain !== "admin" || payload.action !== "refund" || command.livemode === null)
    appBillingAdminFailure("Refund command lacks immutable payment authority");
  await writeTransaction(async (tx) => {
    const current = await lockAppBillingRefundSource(tx, owner, {
      clientRegistrationId: payload.clientRegistrationId,
      paidPeriodId: payload.source.paidPeriodId,
    });
    if (
      command.app_id !== owner.appId ||
      command.organization_id !== owner.organizationId ||
      command.merchant_id !== current.merchant.merchantId ||
      command.livemode !== current.merchant.livemode ||
      settlementDigest(sourceIdentity(current)) !== settlementDigest(sourceIdentity(payload.source))
    )
      appBillingAdminFailure("Refund source changed after its original authorization", "FORBIDDEN");
  });
  return payload;
}

export async function readAppBillingRefund(
  owner: AppBillingOwner,
  command: BillingSubscriptionCommand,
  stripeForMode: (livemode: boolean) => Promise<Stripe>,
): Promise<AppBillingAdminOperation> {
  const payload = await authorize(owner, command);
  const result = command.provider_result;
  if (command.status !== "SUCCEEDED" || result?.kind !== "refund")
    appBillingAdminFailure("Refund command has no durable provider receipt");
  const provider = createGenericBillingProvider(
    await stripeForMode(payload.source.merchant.livemode),
    payload.source.merchant,
    appBillingProviderBindings,
  );
  const observed = await provider.retrieveRefund(payload.source.scope, {
    ...payload.source.invoice,
    refundId: result.refundId,
  });
  if (
    observed.value.amountCents !== payload.amountCents ||
    observed.value.amountCents !== result.amountCents ||
    observed.value.chargeId !== result.chargeId ||
    observed.value.currency !== result.currency
  )
    appBillingAdminFailure("Refund receipt differs from the original payment intent");
  return {
    id: command.id,
    status: "refund",
    receipt: {
      refundId: result.refundId,
      paidPeriodId: payload.source.paidPeriodId,
      amountCents: observed.value.amountCents,
      currency: observed.value.currency,
      environment: payload.source.merchant.livemode ? "live" : "test",
      accessPolicy: payload.accessPolicy,
      providerStatus: observed.value.status ?? "unavailable",
    },
  };
}

export async function executeAppBillingRefund(
  owner: AppBillingOwner,
  claim: Awaited<ReturnType<typeof appBillingAdminRepository.claim>>,
  stripeForMode: (livemode: boolean) => Promise<Stripe>,
): Promise<AppBillingAdminOperation> {
  const { command, leaseToken, databaseNow } = claim;
  if (!leaseToken) return { id: command.id, status: "outcome_unknown", retryAfterSeconds: 90 };
  const payload = await authorize(owner, command);
  const provider = createGenericBillingProvider(
    await stripeForMode(payload.source.merchant.livemode),
    payload.source.merchant,
    appBillingProviderBindings,
  );
  const intent = {
    commandId: command.id,
    idempotencyKey: command.provider_idempotency_key,
    requestDigest: command.request_digest,
  };
  const input = { ...payload.source.invoice, amountCents: payload.amountCents };
  const discovered = await provider.discoverCreatedRefund(payload.source.scope, input, intent);
  if (
    discovered.value.status === "absent" &&
    (command.provider_started_at === null ||
      databaseNow.getTime() - command.provider_started_at.getTime() >= 23 * 60 * 60 * 1000)
  )
    return { id: command.id, status: "outcome_unknown", retryAfterSeconds: 90 };
  const created =
    discovered.value.status === "found"
      ? null
      : await provider.refund(payload.source.scope, input, intent);
  const refund = discovered.value.status === "found" ? discovered.value.object : created?.value;
  if (!refund) appBillingAdminFailure("Refund provider did not return a recoverable receipt");
  const digest = created ? created.digest : discovered.digest;
  await appBillingAdminRepository.finish(owner, command, leaseToken, digest, async (tx) => {
    const current = await lockAppBillingRefundSource(tx, owner, {
      clientRegistrationId: payload.clientRegistrationId,
      paidPeriodId: payload.source.paidPeriodId,
    });
    if (
      settlementDigest(sourceIdentity(current)) !== settlementDigest(sourceIdentity(payload.source))
    )
      appBillingAdminFailure(
        "Refund source changed while provider outcome was observed",
        "FORBIDDEN",
      );
    return {
      result: {
        kind: "refund",
        refundId: refund.refundId,
        chargeId: refund.chargeId,
        amountCents: refund.amountCents,
        currency: refund.currency,
      },
      value: refund.refundId,
    };
  });
  const finished = await appBillingAdminRepository.claim(owner, command.id);
  return readAppBillingRefund(owner, finished.command, stripeForMode);
}
