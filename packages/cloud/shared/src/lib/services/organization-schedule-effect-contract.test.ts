/** Financial request scope and exact retained settings; no provider or database calls. */
import { expect, test } from "bun:test";
import {
  assertScheduleRequestScope,
  organizationScheduleEffectReceiptSchema,
  organizationScheduleEffectRequestSchema,
  scheduleEffectRequestDigest,
} from "./organization-schedule-effect-contract";

function request() {
  return {
    kind: "schedule_configure" as const,
    scheduleId: "sub_sched_original",
    params: {
      end_behavior: "release" as const,
      proration_behavior: "none" as const,
      phases: [
        {
          start_date: 100,
          end_date: 200,
          items: [
            {
              price: "price_pro",
              quantity: 1 as const,
              discounts: [{ discount: "di_item" }],
              tax_rates: ["txr_item"],
              metadata: { category: "original" },
            },
          ],
          proration_behavior: "none" as const,
          automatic_tax: { enabled: true, liability: { type: "self" as const } },
          default_payment_method: "pm_original",
          default_tax_rates: ["txr_original"],
          discounts: [{ discount: "di_original" }],
          metadata: { original: "retained" },
          description: "Existing description",
          invoice_settings: {
            account_tax_ids: ["txi_original"],
            issuer: { type: "self" as const },
          },
        },
        {
          start_date: 200,
          iterations: 1 as const,
          items: [{ price: "price_plus", quantity: 1 as const }],
          proration_behavior: "none" as const,
        },
      ],
    },
  };
}
const scope = {
  subscriptionId: "sub_original",
  sourcePriceId: "price_pro",
  targetPriceId: "price_plus",
  periodStart: new Date(100000),
  periodEnd: new Date(200000),
  predecessorScheduleId: "sub_sched_original",
};
test("explicitly retained phase settings survive validation and participate in request identity", () => {
  const raw = request(),
    parsed = organizationScheduleEffectRequestSchema.parse(raw);
  expect(parsed).toEqual(raw);
  expect(assertScheduleRequestScope({ ...scope, request: parsed })).toEqual(raw);
  const changed = request();
  changed.params.phases[0]!.description = "changed";
  expect(scheduleEffectRequestDigest(parsed)).not.toBe(
    scheduleEffectRequestDigest(organizationScheduleEffectRequestSchema.parse(changed)),
  );
});
test("create scope binds the original subscription without configuration or borrowed provenance", () => {
  const raw = { kind: "schedule_create" as const, subscriptionId: "sub_original" };
  expect(
    assertScheduleRequestScope({ ...scope, predecessorScheduleId: null, request: raw }),
  ).toEqual(raw);
  expect(() => assertScheduleRequestScope({ ...scope, request: raw })).toThrow();
  expect(() =>
    assertScheduleRequestScope({
      ...scope,
      predecessorScheduleId: null,
      request: { ...raw, subscriptionId: "sub_foreign" },
    }),
  ).toThrow();
  expect(() => organizationScheduleEffectRequestSchema.parse({ ...raw, phases: [] })).toThrow();
});
test("unknown provider fields and charge-producing schedule behavior are rejected", () => {
  const raw = request();
  for (const params of [
    { ...raw.params, end_behavior: "cancel" },
    { ...raw.params, proration_behavior: "always_invoice" },
    { ...raw.params, on_behalf_of: "acct_foreign" },
    { ...raw.params, default_settings: { application_fee_percent: 5 } },
  ])
    expect(() => organizationScheduleEffectRequestSchema.parse({ ...raw, params })).toThrow();
  for (const extras of [
    { duration: { interval: "month", interval_count: 1 } },
    { add_invoice_items: [{ price: "price_extra" }] },
    { transfer_data: { destination: "acct_foreign" } },
    { secret: "not-a-wire-field" },
  ])
    expect(() =>
      organizationScheduleEffectRequestSchema.parse({
        ...raw,
        params: {
          ...raw.params,
          phases: [{ ...raw.params.phases[0], ...extras }, raw.params.phases[1]],
        },
      }),
    ).toThrow();
});
test("phase boundaries, prices, quantity, trials and duration remain tied to the review", () => {
  const raw = request();
  const variants = [
    { ...raw, scheduleId: "sub_sched_foreign" },
    {
      ...raw,
      params: {
        ...raw.params,
        phases: [{ ...raw.params.phases[0], end_date: 199 }, raw.params.phases[1]],
      },
    },
    {
      ...raw,
      params: {
        ...raw.params,
        phases: [raw.params.phases[0], { ...raw.params.phases[1], start_date: 199 }],
      },
    },
    {
      ...raw,
      params: {
        ...raw.params,
        phases: [raw.params.phases[0], { ...raw.params.phases[1], trial_end: 210 }],
      },
    },
    {
      ...raw,
      params: {
        ...raw.params,
        phases: [
          raw.params.phases[0],
          { ...raw.params.phases[1], items: [{ price: "price_foreign", quantity: 1 }] },
        ],
      },
    },
    {
      ...raw,
      params: {
        ...raw.params,
        phases: [
          raw.params.phases[0],
          { ...raw.params.phases[1], items: [{ price: "price_plus", quantity: 2 }] },
        ],
      },
    },
    {
      ...raw,
      params: {
        ...raw.params,
        phases: [raw.params.phases[0], { ...raw.params.phases[1], end_date: 300 }],
      },
    },
  ];
  for (const variant of variants)
    expect(() =>
      assertScheduleRequestScope({
        ...scope,
        request: organizationScheduleEffectRequestSchema.parse(variant),
      }),
    ).toThrow();
});
test("normalized receipt shape cannot confuse signed event evidence and direct responses", () => {
  const raw = {
    kind: "response",
    scheduleId: "sub_sched_original",
    customerId: "cus_original",
    subscriptionId: "sub_original",
    livemode: false,
    apiVersion: "2024-11-20.acacia",
    providerRequestId: "req_original",
    providerIdempotencyKey: "original-request",
    eventId: null,
    evidenceDigest: "a".repeat(64),
    observedAt: new Date().toISOString(),
  };
  expect(organizationScheduleEffectReceiptSchema.parse(raw)).toEqual(raw);
  for (const extras of [
    { eventId: "evt_foreign" },
    { kind: "event" },
    { apiVersion: "latest" },
    { providerRequestId: null },
    { providerRaw: { private: "data" } },
  ])
    expect(() => organizationScheduleEffectReceiptSchema.parse({ ...raw, ...extras })).toThrow();
});
