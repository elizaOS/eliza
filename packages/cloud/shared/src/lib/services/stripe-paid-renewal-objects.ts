/** Retrieves complete paid-renewal authority through a caller-owned Stripe client without initiating payments or inventing provider events. */
import type Stripe from "stripe";
import { findPurchasedSubscriptionContract } from "../../db/repositories/subscription-purchased-binding";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { renewalInvoiceSchema, renewalUnavailable } from "./stripe-paid-renewal-validation";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";
import {
  assertCheckoutProviderAuthority,
  checkoutContractEnvironment,
} from "./subscription-checkout-contract";
export async function retrievePaidRenewalObjects(
  source: BillingSubscription,
  invoiceId: string,
  stripe: Stripe,
) {
  assertOrganizationSubscription(source);
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const invoiceParsed = renewalInvoiceSchema.safeParse(invoice);
  if (!invoiceParsed.success) renewalUnavailable("unsupported_canonical_invoice");
  const contract = await findPurchasedSubscriptionContract(source);
  const environment = getCloudAwareEnv();
  const providerAccountId = contract ? (await stripe.accounts.retrieve(null)).id : undefined;
  if (contract) {
    if (!providerAccountId) renewalUnavailable("purchased_binding_account_missing");
    assertCheckoutProviderAuthority(contract, providerAccountId, environment);
  }
  const binding = resolveSubscriptionProviderBinding(
    contract ? checkoutContractEnvironment(contract, environment) : environment,
    source.plan_key,
    source.catalog_version,
  );
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const [subscription, customer, paymentIntent, charge, price, product] = await Promise.all([
    stripe.subscriptions.retrieve(source.stripe_subscription_id),
    stripe.customers.retrieve(source.stripe_customer_id),
    stripe.paymentIntents.retrieve(invoiceParsed.data.payment_intent),
    stripe.charges.retrieve(invoiceParsed.data.charge),
    stripe.prices.retrieve(binding.priceId),
    stripe.products.retrieve(binding.productId),
  ]);
  // Archiving a historical price prevents new purchases, not renewal of existing subscriptions.
  if (
    price.id !== binding.priceId ||
    price.product !== binding.productId ||
    price.livemode !== binding.expectedLivemode ||
    price.currency !== "usd" ||
    price.unit_amount !== plan.amountCents ||
    price.type !== "recurring" ||
    price.billing_scheme !== "per_unit" ||
    price.transform_quantity !== null ||
    !price.recurring ||
    price.recurring.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.recurring.trial_period_days !== null ||
    product.id !== binding.productId ||
    ("deleted" in product && product.deleted) ||
    !("livemode" in product) ||
    product.livemode !== binding.expectedLivemode
  )
    renewalUnavailable("historical_catalog_binding_mismatch");
  return { invoice, subscription, customer, paymentIntent, charge, providerAccountId };
}
