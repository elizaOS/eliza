/** Pinned synthetic paid invoice shared by validation and atomic publication tests. */
import type { seedOrganizationUpgradeTestAccount } from "./organization-upgrade-test-fixture";
export function upgradePaidObjects(
  f: Awaited<ReturnType<typeof seedOrganizationUpgradeTestAccount>>,
) {
  const source = f.captured.source,
    review = f.review;
  const line = (price: string, amount: number) => ({
    id: `il_${price}`,
    type: "subscription",
    subscription: source.stripe_subscription_id,
    subscription_item: source.stripe_subscription_item_id,
    price: { id: price },
    quantity: 1,
    currency: "usd",
    amount,
    discount_amounts: [],
    tax_amounts: [],
    period: {
      start: review.prorationDate,
      end: Math.floor(source.current_period_end!.getTime() / 1000),
    },
    proration: true,
  });
  const raw = {
    id: "in_upgrade",
    object: "invoice",
    status: "paid",
    livemode: false,
    customer: source.stripe_customer_id,
    subscription: source.stripe_subscription_id,
    currency: "usd",
    charge: "ch_upgrade",
    payment_intent: "pi_upgrade",
    paid: true,
    paid_out_of_band: false,
    amount_paid: 3500,
    amount_due: 3500,
    amount_remaining: 0,
    billing_reason: "subscription_update",
    subtotal: 3500,
    subtotal_excluding_tax: 3500,
    total: 3500,
    tax: 0,
    total_discount_amounts: [] as { amount: number }[],
    total_tax_amounts: [] as { amount: number; inclusive: boolean; tax_rate: string }[],
    period_start: review.prorationDate,
    period_end: Math.floor(source.current_period_end!.getTime() / 1000),
    hosted_invoice_url: null,
    collection_method: "charge_automatically",
    on_behalf_of: null,
    transfer_data: null,
    application_fee_amount: null,
    starting_balance: 0,
    automatic_tax: { enabled: false, status: null as string | null },
    lines: { has_more: false, data: [line("price_plus", -1500), line("price_pro", 5000)] },
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    created: review.prorationDate,
    status_transitions: {
      finalized_at: review.prorationDate,
      paid_at: review.prorationDate,
      voided_at: null,
      marked_uncollectible_at: null,
    },
  };
  const rawSubscription = structuredClone({
    ...f.provider,
    collection_method: "charge_automatically",
  });
  Object.assign(rawSubscription.items.data[0]!.price, {
    id: f.providerBinding.targetPriceId,
    product: f.providerBinding.targetProductId,
    unit_amount: f.review.targetBaseAmountCents,
  });
  return { rawInvoice: raw, rawSubscription };
}
