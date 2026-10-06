import { expect, test } from "bun:test";
import { organizationDowngradeIntentDigest } from "./organization-downgrade-intent";
import { observeOrganizationScheduleCustomerTerms } from "./organization-schedule-quote-terms";
import { scheduleCustomerTestObservation } from "./organization-schedule-test-fixture";
import { settlementDigest } from "./settlement-digest";

test("customer inheritance preserves discount and payment IDs while hashing private location/tax context", () => {
  const raw = scheduleCustomerTestObservation("cus_original");
  Object.assign(raw, {
    address: { line1: "Private billing street" },
    discount: { id: "di_customer" },
    invoice_settings: { default_payment_method: { id: "pm_customer" } },
    tax_ids: {
      object: "list",
      has_more: false,
      data: [{ id: "txi_customer", object: "tax_id", value: "private-tax-value" }],
    },
  });
  const snapshot = observeOrganizationScheduleCustomerTerms(raw);
  expect(snapshot.discountId).toBe("di_customer");
  expect(snapshot.defaultPaymentMethod).toBe("pm_customer");
  expect(JSON.stringify(snapshot)).not.toContain("Private billing street");
  expect(JSON.stringify(snapshot)).not.toContain("private-tax-value");
  const before = snapshot.financialContextDigest;
  Object.assign(raw, { address: { line1: "Changed billing street" } });
  expect(observeOrganizationScheduleCustomerTerms(raw).financialContextDigest).not.toBe(before);
});
test("incomplete tax identity pages and legacy customer sources fail before schedule review", () => {
  for (const change of [
    { tax_ids: { object: "list", has_more: true, data: [] } },
    { default_source: "src_legacy" },
    { deleted: true },
    { currency: "eur" },
  ])
    expect(() =>
      observeOrganizationScheduleCustomerTerms({
        ...scheduleCustomerTestObservation("cus_original"),
        ...change,
      }),
    ).toThrow();
});
test("customer inherited discounts and credit balances affect binding without being cleared", () => {
  const raw = scheduleCustomerTestObservation("cus_original");
  const baseline = settlementDigest(observeOrganizationScheduleCustomerTerms(raw));
  for (const change of [
    { discount: { id: "di_inherited" } },
    { balance: -100 },
    { invoice_credit_balance: { usd: 100 } },
    { invoice_settings: { default_payment_method: "pm_changed" } },
    { tax_exempt: "exempt" },
  ])
    expect(
      settlementDigest(observeOrganizationScheduleCustomerTerms({ ...raw, ...change })),
    ).not.toBe(baseline);
  expect(observeOrganizationScheduleCustomerTerms(raw).discountId).toBeNull();
});
test("versioned downgrade intent retains historical digest and binds new original terms", () => {
  const input = {
    organizationId: "organization",
    actorId: "actor",
    quoteId: "quote",
    reviewDigest: "review",
    sourceDigest: "source",
    providerBinding: {
      sourcePriceId: "price_pro",
      targetPriceId: "price_plus",
      sourceProductId: "prod_pro",
      targetProductId: "prod_plus",
      livemode: false,
      apiVersion: "2024-11-20.acacia" as const,
    },
  };
  const historical = settlementDigest({ version: 1, kind: "organization_downgrade", ...input });
  expect(organizationDowngradeIntentDigest(input)).toBe(historical);
  expect(organizationDowngradeIntentDigest({ ...input, retainedTermsDigest: null })).toBe(
    historical,
  );
  expect(() => organizationDowngradeIntentDigest({ ...input, retainedTermsDigest: "" })).toThrow();
  const bound = organizationDowngradeIntentDigest({
    ...input,
    retainedTermsDigest: "a".repeat(64),
  });
  expect(bound).not.toBe(historical);
  expect(
    organizationDowngradeIntentDigest({ ...input, retainedTermsDigest: "b".repeat(64) }),
  ).not.toBe(bound);
});
