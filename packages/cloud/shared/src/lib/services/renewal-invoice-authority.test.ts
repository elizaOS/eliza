/** Original grant evidence must be copied, owner-bound, private-field-free and tamper evident. */
import { expect, test } from "bun:test";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import {
  bindRenewalInvoiceAuthority,
  createRenewalInvoiceAuthority,
} from "./renewal-invoice-authority";

const source = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  stripe_customer_id: "cus_original",
  stripe_subscription_id: "sub_original",
  stripe_subscription_item_id: "si_original",
  provider_environment: "test",
  current_period_start: new Date(1700000000000),
  current_period_end: new Date(1702592000000),
} as BillingSubscription;
function fixture() {
  return createRenewalInvoiceAuthority({
    kind: "renewal_invoice_authority",
    version: 1,
    organizationId: source.organization_id,
    subscriptionId: source.id,
    providerAccountId: "acct_original",
    invoiceId: "in_original",
    customerId: "cus_original",
    providerSubscriptionId: "sub_original",
    subscriptionItemId: "si_original",
    invoiceLineId: "il_original",
    priceId: "price_original",
    productId: "prod_original",
    livemode: false,
    currency: "usd",
    periodStart: 1700000000,
    periodEnd: 1702592000,
    invoiceTotal: 3000,
    amountPaid: 3000,
    paymentIntentId: "pi_original",
    chargeId: "ch_original",
    adjustmentDigest: null,
    settlementDigest: null,
    grantDigest: "a".repeat(64),
  });
}
test("copies original evidence, preserving unknown merchant rather than inventing one", () => {
  const original = fixture();
  const copied = bindRenewalInvoiceAuthority(
    original,
    source,
    original.invoiceId,
    original.grantDigest,
  );
  original.invoiceLineId = "il_changed";
  expect(copied.invoiceLineId).toBe("il_original");
  const { digest: _, ...body } = copied;
  expect(
    createRenewalInvoiceAuthority({ ...body, providerAccountId: null }).providerAccountId,
  ).toBeNull();
});
for (const key of [
  "organizationId",
  "subscriptionId",
  "customerId",
  "providerSubscriptionId",
  "subscriptionItemId",
  "invoiceId",
  "grantDigest",
  "periodStart",
  "periodEnd",
  "livemode",
] as const) {
  test(`rehashed foreign ${key} still cannot bind to the original grant`, () => {
    const { digest: _, ...body } = fixture();
    const changed = { ...body };
    if (key === "livemode") changed[key] = true;
    else if (key === "periodStart" || key === "periodEnd") changed[key] += 1;
    else if (key === "grantDigest") changed[key] = "b".repeat(64);
    else if (key === "organizationId" || key === "subscriptionId")
      changed[key] = "00000000-0000-4000-8000-000000000003";
    else changed[key] += "foreign";
    expect(() =>
      bindRenewalInvoiceAuthority(
        createRenewalInvoiceAuthority(changed),
        source,
        "in_original",
        body.grantDigest,
      ),
    ).toThrow();
  });
}
test("tampering, private extra fields, unsafe times and fabricated zero-due capture reject", () => {
  const original = fixture();
  expect(() =>
    bindRenewalInvoiceAuthority(
      { ...original, amountPaid: 4000 },
      source,
      original.invoiceId,
      original.grantDigest,
    ),
  ).toThrow();
  expect(() =>
    bindRenewalInvoiceAuthority(
      Object.assign({}, original, { memo: "private" }),
      source,
      original.invoiceId,
      original.grantDigest,
    ),
  ).toThrow();
  const { digest: _, ...body } = original;
  expect(() =>
    createRenewalInvoiceAuthority({ ...body, periodEnd: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
  expect(() => createRenewalInvoiceAuthority({ ...body, amountPaid: 0 })).toThrow();
  const credit = createRenewalInvoiceAuthority({
    ...body,
    amountPaid: 0,
    paymentIntentId: null,
    chargeId: null,
  });
  expect(credit.paymentIntentId).toBeNull();
});
