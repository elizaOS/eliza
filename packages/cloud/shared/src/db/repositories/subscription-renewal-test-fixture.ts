/** Creates real historical source authority and complete plain Stripe renewal observations for isolated database and transport tests. */

import { randomUUID } from "node:crypto";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import { subscriptionAuthorityRepository } from "./subscription-authority";
import { seedCancellationTestAccount } from "./subscription-cancellation-test-fixture";
import { subscriptionEntitlementsRepository } from "./subscription-entitlements";
export async function seedRenewalTestAccount(
  queryOverride?: (query: string, values: unknown[]) => Promise<unknown>,
) {
  const fixture = await seedCancellationTestAccount(queryOverride);
  const start = Math.floor(Date.now() / 1000) - 60,
    end = start + 30 * 86400;
  const source = (
    await subscriptionAuthorityRepository.advance({
      organizationId: fixture.input.organizationId,
      subscriptionId: fixture.input.subscriptionId,
      expectedRevision: 1,
      source: "reconciliation",
      observation: "authoritative_provider_retrieval",
      values: {
        ...fixture.source,
        current_period_start: new Date((start - 30 * 86400) * 1000),
        current_period_end: new Date(start * 1000),
      },
    })
  ).subscription;
  await subscriptionEntitlementsRepository.rebuild({
    organizationId: source.organization_id,
    sourceSubscriptionId: source.id,
    sourceSubscriptionRevision: 2,
    expectedProjectionRevision: 1,
  });
  return { source, ...renewalPaidObjects(source, fixture.provider, { start, end }) };
}
/** Provider-only fixture: does not publish or rewrite historical source rows. */
export function renewalPaidObjects(
  source: Pick<
    BillingSubscription,
    "stripe_customer_id" | "stripe_subscription_id" | "stripe_subscription_item_id" | "plan_key"
  >,
  provider: Awaited<ReturnType<typeof seedCancellationTestAccount>>["provider"],
  period: { start: number; end: number },
) {
  const { start, end } = period;
  const amount = source.plan_key === "pro_monthly" ? 10000 : 3000;
  const suffix = randomUUID().replaceAll("-", ""),
    invoiceId = `in_${suffix}`,
    piId = `pi_${suffix}`,
    chargeId = `ch_${suffix}`;
  const subscription = {
    ...provider,
    current_period_start: start,
    current_period_end: end,
    latest_invoice: invoiceId,
    collection_method: "charge_automatically",
  };
  const price = { ...subscription.items.data[0]!.price, active: false, object: "price" };
  const customer = { id: source.stripe_customer_id, object: "customer", livemode: false };
  const invoice = {
    id: invoiceId,
    object: "invoice",
    subscription: source.stripe_subscription_id,
    customer: customer.id,
    livemode: false,
    billing_reason: "subscription_cycle",
    status: "paid",
    paid: true,
    paid_out_of_band: false,
    collection_method: "charge_automatically",
    currency: "usd",
    amount_paid: amount,
    amount_due: amount,
    total: amount,
    subtotal: amount,
    amount_remaining: 0,
    starting_balance: 0,
    ending_balance: 0,
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    discount: null,
    discounts: [],
    total_discount_amounts: [],
    tax: null,
    total_tax_amounts: [],
    automatic_tax: { enabled: false },
    application: null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: null,
    issuer: { type: "self" },
    payment_intent: piId,
    charge: chargeId,
    status_transitions: { paid_at: start + 1 },
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${suffix}`,
          type: "subscription",
          subscription: source.stripe_subscription_id,
          subscription_item: source.stripe_subscription_item_id,
          quantity: 1,
          proration: false,
          currency: "usd",
          amount: amount,
          discount_amounts: [],
          tax_amounts: [],
          period: { start, end },
          price: { id: price.id, product: price.product },
        },
      ],
    },
  };
  const paymentIntent = {
    id: piId,
    object: "payment_intent",
    status: "succeeded",
    customer: customer.id,
    invoice: invoiceId,
    latest_charge: chargeId,
    livemode: false,
    currency: "usd",
    amount: amount,
    amount_received: amount,
    amount_capturable: 0,
    application: null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: null,
  };
  const charge = {
    id: chargeId,
    object: "charge",
    status: "succeeded",
    customer: customer.id,
    invoice: invoiceId,
    payment_intent: piId,
    livemode: false,
    currency: "usd",
    amount: amount,
    amount_captured: amount,
    amount_refunded: 0,
    captured: true,
    paid: true,
    refunded: false,
    disputed: false,
    refunds: { has_more: false, data: [] },
    application: null,
    application_fee: null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer: null,
    transfer_data: null,
  };
  return {
    subscription,
    invoice,
    customer,
    paymentIntent,
    charge,
    price,
    product: { id: price.product, object: "product", livemode: false, active: false },
  };
}
