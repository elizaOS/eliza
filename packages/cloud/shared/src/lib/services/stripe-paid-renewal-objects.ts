/** Retrieves complete paid-renewal authority through a caller-owned Stripe client without initiating payments or inventing provider events. */
import type Stripe from "stripe";
import { readOriginalScheduledRenewalAuthority } from "../../db/repositories/organization-schedule-renewal-authority";
import { findSubscriptionRenewalBinding } from "../../db/repositories/subscription-purchased-binding";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { retrieveInvoiceBalanceHistory } from "./stripe-invoice-settlement";
import { renewalInvoiceSchema, renewalUnavailable } from "./stripe-paid-renewal-validation";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";
import { assertCheckoutProviderAuthority } from "./subscription-checkout-contract";
export async function retrievePaidRenewalObjects(
  source: BillingSubscription,
  invoiceId: string,
  stripe: Stripe,
) {
  assertOrganizationSubscription(source);
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const invoiceParsed = renewalInvoiceSchema.safeParse(invoice);
  if (!invoiceParsed.success) renewalUnavailable("unsupported_canonical_invoice");
  const configuredEnvironment = getCloudAwareEnv();
  const { contract, environment } = await findSubscriptionRenewalBinding(
    source,
    configuredEnvironment,
  );
  const providerAccountId = contract ? (await stripe.accounts.retrieve(null)).id : undefined;
  if (contract) {
    if (!providerAccountId) renewalUnavailable("purchased_binding_account_missing");
    assertCheckoutProviderAuthority(contract, providerAccountId, configuredEnvironment);
  }
  const scheduledContext = await readOriginalScheduledRenewalAuthority(source);
  const binding = scheduledContext
    ? {
        priceId: scheduledContext.providerBinding.targetPriceId,
        productId: scheduledContext.providerBinding.targetProductId,
        expectedLivemode: scheduledContext.providerBinding.livemode,
      }
    : resolveSubscriptionProviderBinding(environment, source.plan_key, source.catalog_version);
  const plan = resolveSubscriptionPlanDefinition(
    scheduledContext
      ? scheduledContext.command.organization_schedule_configuration_evidence!.targetPlanKey
      : source.plan_key,
    source.catalog_version,
  );
  const [subscription, customer, paymentIntent, charge, price, product] = await Promise.all([
    stripe.subscriptions.retrieve(source.stripe_subscription_id),
    stripe.customers.retrieve(source.stripe_customer_id),
    invoiceParsed.data.payment_intent
      ? stripe.paymentIntents.retrieve(invoiceParsed.data.payment_intent)
      : null,
    invoiceParsed.data.charge ? stripe.charges.retrieve(invoiceParsed.data.charge) : null,
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
  const scheduledSchedule = scheduledContext
    ? await stripe.subscriptionSchedules.retrieve(
        scheduledContext.scheduleId,
        {},
        { apiVersion: scheduledContext.providerBinding.apiVersion },
      )
    : undefined;
  const balanceHistory =
    invoiceParsed.data.starting_balance < 0
      ? await retrieveInvoiceBalanceHistory(
          source.stripe_customer_id,
          invoiceParsed.data.livemode,
          (customerId, params) => stripe.customers.listBalanceTransactions(customerId, params),
        )
      : undefined;
  return {
    balanceHistory,
    invoice,
    subscription,
    customer,
    paymentIntent,
    charge,
    providerAccountId,
    scheduledSchedule,
  };
}
