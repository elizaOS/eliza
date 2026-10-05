/** Synthetic complete observations for private schedule provider tests; no provider I/O. */

import { projectOriginalScheduleResponse } from "./organization-schedule-effect-origin";
import { captureOrganizationScheduleQuoteTerms } from "./organization-schedule-quote-terms";
import { scheduleCustomerTestObservation } from "./organization-schedule-test-fixture";
export function subscriptionFixture() {
  return {
    id: "sub_original",
    object: "subscription",
    livemode: false,
    customer: "cus_original",
    status: "active",
    current_period_start: 100,
    current_period_end: 200,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    on_behalf_of: null,
    transfer_data: null,
    application_fee_percent: null,
    schedule: null,
    pending_update: null,
    pause_collection: null,
    application: null,
    currency: "usd",
    collection_method: "charge_automatically",
    days_until_due: null,
    automatic_tax: { enabled: false, liability: null },
    billing_cycle_anchor: 100,
    billing_cycle_anchor_config: null,
    billing_thresholds: null,
    default_payment_method: "pm_original",
    default_source: null,
    default_tax_rates: [],
    description: "Original description",
    discount: null,
    discounts: [],
    invoice_settings: { account_tax_ids: null, issuer: { type: "self" } },
    metadata: { organization: "original" },
    next_pending_invoice_item_invoice: null,
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: "off",
    },
    items: {
      has_more: false,
      data: [
        {
          id: "si_original",
          object: "subscription_item",
          quantity: 1,
          billing_thresholds: null,
          discounts: [],
          tax_rates: [],
          metadata: { item: "original" },
          price: {
            id: "price_pro",
            product: "prod_pro",
            livemode: false,
            currency: "usd",
            unit_amount: 10000,
            tax_behavior: "unspecified",
            type: "recurring",
            billing_scheme: "per_unit",
            transform_quantity: null,
            recurring: {
              interval: "month",
              interval_count: 1,
              usage_type: "licensed",
              trial_period_days: null,
            },
          },
        },
      ],
    },
  };
}

export function originalScheduleTestInput(
  change?: (f: {
    subscription: ReturnType<typeof subscriptionFixture>;
    customer: ReturnType<typeof scheduleCustomerTestObservation>;
    phase: Record<string, unknown>;
    defaults: Record<string, unknown>;
  }) => void,
) {
  const subscription = subscriptionFixture(),
    customer = scheduleCustomerTestObservation("cus_original"),
    observedAt = new Date(150000);
  const defaults: Record<string, unknown> = {
    application_fee_percent: null,
    automatic_tax: { enabled: false, liability: null },
    billing_cycle_anchor: "automatic",
    billing_thresholds: null,
    collection_method: "charge_automatically",
    default_payment_method: "pm_original",
    description: "Original description",
    invoice_settings: { account_tax_ids: null, days_until_due: null, issuer: { type: "self" } },
    on_behalf_of: null,
    transfer_data: null,
  };
  const phase: Record<string, unknown> = {
    add_invoice_items: [],
    application_fee_percent: null,
    billing_cycle_anchor: null,
    billing_thresholds: null,
    collection_method: null,
    coupon: null,
    currency: "usd",
    default_payment_method: null,
    default_tax_rates: [],
    description: null,
    discounts: [],
    start_date: 100,
    end_date: 200,
    invoice_settings: null,
    metadata: null,
    on_behalf_of: null,
    proration_behavior: "create_prorations",
    transfer_data: null,
    trial_end: null,
    items: [
      {
        billing_thresholds: null,
        discounts: [],
        metadata: null,
        plan: "price_pro",
        price: "price_pro",
        quantity: 1,
        tax_rates: [],
      },
    ],
  };
  change?.({ subscription, customer, phase, defaults });
  const originalTerms = captureOrganizationScheduleQuoteTerms({
    rawSubscription: subscription,
    rawCustomer: customer,
    observedAt,
  });
  const schedule = {
    id: "sub_sched_owned",
    object: "subscription_schedule",
    customer: "cus_original",
    subscription: "sub_original",
    livemode: false,
    created: 101,
    application: null,
    status: "active",
    canceled_at: null,
    completed_at: null,
    released_at: null,
    released_subscription: null,
    end_behavior: "release",
    current_phase: { start_date: 100, end_date: 200 },
    phases: [phase],
    default_settings: defaults,
  };
  const raw = Object.defineProperty(structuredClone(schedule), "lastResponse", {
    value: {
      requestId: "req_original",
      statusCode: 200,
      apiVersion: "2024-11-20.acacia",
      idempotencyKey: "original-create",
    },
  });
  const originalRequest = {
    request: { kind: "schedule_create" as const, subscriptionId: "sub_original" },
    customerId: "cus_original",
    subscriptionId: "sub_original",
    livemode: false,
    providerIdempotencyKey: "original-create",
    startedAt: new Date(100500),
  };
  const originalReceipt = projectOriginalScheduleResponse({ raw, originalRequest, observedAt });
  return {
    originalTerms,
    originalReceipt,
    originalRequest,
    observedAt,
    evidence: { kind: "response" as const, raw },
    rawCurrentSchedule: schedule,
    rawSubscription: { ...subscription, schedule: "sub_sched_owned" },
    rawCustomer: customer,
    targetPriceId: "price_plus",
  };
}
