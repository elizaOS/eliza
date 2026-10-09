/** Verifies exact reviewed historical provider identities using the canonical Acacia adapter and no provider mutations. */
import type Stripe from "stripe";
import { z } from "zod";
import { appBillingConflict } from "../../db/repositories/app-subscription-authority";
import type { AppBillingImportManifest } from "./generic-billing-import-manifest";
import {
  type BillingProviderMerchant,
  type BillingProviderPlan,
  type BillingProviderScope,
  createGenericBillingProvider,
} from "./generic-billing-provider";

const object = z.object({
  id: z.string(),
  customer: z
    .union([z.string(), z.object({ id: z.string() })])
    .transform((value) => (typeof value === "string" ? value : value.id)),
  livemode: z.boolean(),
});
export async function verifyAppBillingImportProvider(input: {
  stripe: Stripe;
  merchant: BillingProviderMerchant;
  scope: BillingProviderScope;
  plan: BillingProviderPlan;
  manifest: AppBillingImportManifest;
}) {
  const original = input.manifest.provider;
  const provider = createGenericBillingProvider(input.stripe, input.merchant, {
    async resolveBinding(request) {
      if (
        !original ||
        request.merchantId !== input.merchant.merchantId ||
        request.providerAccountId !== input.merchant.stripeAccountId ||
        request.livemode !== input.merchant.livemode
      )
        return null;
      const matches =
        request.objectType === "customer"
          ? request.objectId === original.customerId
          : request.objectType === "subscription" && request.objectId === original.subscriptionId;
      return matches
        ? {
            appId: input.scope.appId,
            billingAccountId: input.scope.billingAccountId,
            scopeId: request.objectType === "customer" ? null : input.scope.scopeId,
          }
        : null;
    },
  });
  const merchant = await provider.verifyMerchant();
  const plan = await provider.verifyPlan(input.plan);
  if (!original) return { merchant, plan, subscription: null, invoice: null };
  const options: Stripe.RequestOptions = {
    apiVersion: "2024-11-20.acacia",
    ...(input.merchant.kind === "connected"
      ? { stripeAccount: input.merchant.stripeAccountId }
      : {}),
  };
  let foundOriginal = false;
  for await (const raw of input.stripe.subscriptions.list(
    { customer: original.customerId, status: "all", limit: 100 },
    options,
  )) {
    const row = object.parse(raw);
    if (row.id === original.subscriptionId) foundOriginal = true;
    if (
      row.id !== original.subscriptionId ||
      row.customer !== original.customerId ||
      row.livemode !== input.merchant.livemode
    )
      appBillingConflict(
        "Historical Stripe customer has other subscriptions; isolate ownership before enabling app billing",
      );
  }
  if (!foundOriginal)
    appBillingConflict("Historical customer does not enumerate its reviewed subscription");
  for await (const raw of input.stripe.invoices.list(
    { customer: original.customerId, limit: 100 },
    options,
  )) {
    const row = object
      .extend({ subscription: z.union([z.string(), z.object({ id: z.string() })]).nullable() })
      .parse(raw);
    const subscriptionId =
      typeof row.subscription === "string" ? row.subscription : row.subscription?.id;
    if (
      subscriptionId !== original.subscriptionId ||
      row.customer !== original.customerId ||
      row.livemode !== input.merchant.livemode
    )
      appBillingConflict(
        "Historical Stripe customer contains unrelated invoices; app portal access cannot be granted",
      );
  }
  const subscription = await provider.retrieveSubscription(input.scope, {
    subscriptionId: original.subscriptionId,
    customerId: original.customerId,
    plan: input.plan,
  });
  if (
    subscription.value.quantity !== input.manifest.quantity ||
    subscription.value.latestInvoiceId !== original.invoiceId
  )
    appBillingConflict("Reviewed subscription quantity or latest invoice changed before import");
  const trial = input.manifest.trial;
  if (subscription.value.trialStart !== null || subscription.value.trialEnd !== null) {
    if (
      !trial ||
      subscription.value.trialStart === null ||
      subscription.value.trialEnd === null ||
      subscription.value.trialStart * 1000 < Date.parse(trial.startsAt) ||
      subscription.value.trialEnd * 1000 !== Date.parse(trial.endsAt)
    )
      appBillingConflict(
        "Historical provider trial does not preserve the reviewed original trial interval",
      );
  } else if (subscription.value.status === "trialing")
    appBillingConflict("Historical provider trial dates are unavailable");
  const invoice = original.invoiceId
    ? await provider.retrieveInvoice(input.scope, {
        invoiceId: original.invoiceId,
        subscriptionId: original.subscriptionId,
        customerId: original.customerId,
        plan: input.plan,
      })
    : null;
  const currentSubscription = await provider.retrieveSubscription(input.scope, {
    subscriptionId: original.subscriptionId,
    customerId: original.customerId,
    plan: input.plan,
  });
  if (currentSubscription.digest !== subscription.digest)
    appBillingConflict(
      "Historical subscription changed while verifying its payment evidence; review the current state before import",
    );
  return { merchant, plan, subscription: currentSubscription, invoice };
}
