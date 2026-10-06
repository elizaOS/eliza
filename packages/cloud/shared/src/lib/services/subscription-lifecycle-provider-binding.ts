/** Retained purchased/account authority for lifecycle reads and locked publication. */
import type Stripe from "stripe";
import type { Database, DbTransaction } from "../../db/client";
import { findSubscriptionRenewalBinding } from "../../db/repositories/subscription-purchased-binding";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";
import { assertCheckoutProviderAuthority } from "./subscription-checkout-contract";

export async function retrieveSubscriptionLifecycleBinding(
  source: BillingSubscription,
  stripe: Pick<Stripe, "accounts">,
) {
  const configured = getCloudAwareEnv();
  const { contract, environment } = await findSubscriptionRenewalBinding(source, configured);
  const providerAccountId = contract ? (await stripe.accounts.retrieve(null)).id : undefined;
  if (contract) {
    if (!providerAccountId) renewalUnavailable("purchased_binding_account_missing");
    assertCheckoutProviderAuthority(contract, providerAccountId, configured);
  }
  return { environment, providerAccountId };
}
/** Recompute from the locked captured source; never trust an environment passed across provider I/O. */
export async function resolveSubscriptionLifecycleBinding(
  source: BillingSubscription,
  providerAccountId: string | undefined,
  database: Database | DbTransaction,
) {
  const configured = getCloudAwareEnv();
  const { contract, environment } = await findSubscriptionRenewalBinding(
    source,
    configured,
    database,
  );
  if (contract) {
    if (!providerAccountId) renewalUnavailable("purchased_binding_account_missing");
    assertCheckoutProviderAuthority(contract, providerAccountId, configured);
  }
  return environment;
}
