/** Synthetic complete pinned billing observations for schedule tests; no provider I/O. */
export function scheduleCustomerTestObservation(customerId: string, livemode = false) {
  return {
    id: customerId,
    object: "customer",
    livemode,
    default_source: null,
    invoice_settings: { default_payment_method: null },
    discount: null,
    currency: "usd",
    balance: 0,
    tax_exempt: "none",
    address: null,
    shipping: null,
    tax_ids: { object: "list", has_more: false, data: [] },
  };
}
export function completeScheduleSubscriptionTestObservation<
  T extends { current_period_start: number; items: { data: { price: object }[] } },
>(source: T) {
  for (const item of source.items.data) {
    Object.assign(item.price, { tax_behavior: "unspecified" });
    Object.assign(item, { billing_thresholds: null, discounts: [], tax_rates: [], metadata: {} });
  }
  return Object.assign(source, {
    application: null,
    currency: "usd",
    collection_method: "charge_automatically",
    days_until_due: null,
    automatic_tax: { enabled: false, liability: null },
    billing_cycle_anchor: source.current_period_start,
    billing_cycle_anchor_config: null,
    billing_thresholds: null,
    default_payment_method: "pm_original",
    default_source: null,
    default_tax_rates: [],
    description: null,
    discount: null,
    discounts: [],
    invoice_settings: { account_tax_ids: null, issuer: { type: "self" } },
    metadata: {},
    next_pending_invoice_item_invoice: null,
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    payment_settings: null,
  });
}
