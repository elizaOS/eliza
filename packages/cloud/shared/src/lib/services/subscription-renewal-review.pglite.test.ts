/** Runs renewal review through primary authority transactions; the provider is a controlled read-only fixture. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "../../db/repositories/subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_renewalreview";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
let customer: unknown;
let subscription: unknown;
let preview: unknown;
let beforePreviewReturn = async () => {};
const customerRead = mock(async () => customer);
const subscriptionRead = mock(async () => subscription);
const previewRead = mock(async () => {
  await beforePreviewReturn();
  return preview;
});
const update = mock(async () => {
  throw new Error("Review must never mutate");
});
mock.module("../stripe", () => ({
  requireStripe: () => ({
    customers: { retrieve: customerRead },
    subscriptions: { retrieve: subscriptionRead, update },
    invoices: { createPreview: previewRead },
  }),
}));
let client: typeof import("../../db/client");
let repo: typeof import("../../db/repositories/subscription-cancellation");
let service: typeof import("./subscription-renewal-review");
beforeAll(async () => {
  client = await import("../../db/client");
  await installCancellationTestSchema((q) => client.getPgliteClientForTests().exec(q));
  repo = await import("../../db/repositories/subscription-cancellation");
  service = await import("./subscription-renewal-review");
}, 120_000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
  mock.restore();
});

async function fixture() {
  beforePreviewReturn = async () => {};
  const f = await seedCancellationTestAccount();
  const command = await repo.prepareCancellation(f.input);
  const claim = await repo.claimCancellation({ ...f.input, commandId: command.id });
  subscription = {
    ...f.provider,
    cancel_at_period_end: true,
    cancel_at: f.provider.current_period_end,
    canceled_at: Math.floor(Date.now() / 1000),
  };
  if (!claim) throw new Error("Missing fixture claim");
  await repo.finalizeCancellation(f.input, claim, subscription);
  customer = { id: f.source.stripe_customer_id, object: "customer", livemode: false };
  const invoice = {
    id: "upcoming_in_review",
    object: "invoice",
    status: "draft",
    livemode: false,
    customer: f.source.stripe_customer_id,
    subscription: f.source.stripe_subscription_id,
    currency: "usd",
    collection_method: "charge_automatically",
    on_behalf_of: null,
    transfer_data: null,
    application_fee_amount: null,
    automatic_tax: { enabled: true, status: "complete" },
    amount_due: 2640,
    subtotal: 3000,
    total: 3240,
    tax: 240,
    starting_balance: -600,
    total_discount_amounts: [],
    total_tax_amounts: [{ amount: 240, inclusive: false, tax_rate: "txr_fixture" }],
    lines: {
      has_more: false,
      data: [
        {
          type: "subscription",
          subscription: f.source.stripe_subscription_id,
          subscription_item: f.source.stripe_subscription_item_id,
          proration: false,
          currency: "usd",
          quantity: 1,
          amount: 3000,
          price: { id: "price_plus" },
          period: {
            start: f.provider.current_period_end,
            end: f.provider.current_period_end + 30 * 86400,
          },
        },
      ],
    },
  };
  preview = invoice;
  const input = { ...f.input, expectedSubscriptionRevision: 2 };
  const captured = await repo.readCancellationUndoReviewSource(input);
  return { ...f, input, invoice, captured };
}
const session = async () => {};

test("review preserves tax, credit, catalog version and current scope without a new command or mutation", async () => {
  const f = await fixture();
  const result = await service.readOrganizationSubscriptionRenewalReview(f.input, session);
  expect(result).toMatchObject({
    kind: "renewal_estimate",
    subscriptionId: f.input.subscriptionId,
    expectedSubscriptionRevision: "2",
    catalogVersion: "v1",
    baseAmountCents: 3000,
    totalCents: 3240,
    taxCents: 240,
    startingBalanceCents: -600,
    amountDueCents: 2640,
  });
  expect(Date.parse(result.expiresAt) - Date.parse(result.observedAt)).toBe(60_000);
  expect(JSON.stringify(result)).not.toContain(f.source.stripe_customer_id);
  expect(JSON.stringify(result)).not.toContain(f.source.stripe_subscription_id);
  expect(previewRead.mock.calls.at(-1)).toEqual([
    {
      customer: f.source.stripe_customer_id,
      subscription: f.source.stripe_subscription_id,
      preview_mode: "next",
      subscription_details: { cancel_at_period_end: false, proration_behavior: "none" },
    },
  ]);
  expect(update).not.toHaveBeenCalled();
  const rows = await client
    .getPgliteClientForTests()
    .query("SELECT kind FROM billing_subscription_commands WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
  expect(rows.rows).toEqual([{ kind: "cancel" }]);
});
test("term fingerprint changes for tax/credit drift but not a new observation time or invoice ID", async () => {
  const f = await fixture();
  const project = (raw: unknown, observedAt = new Date()) =>
    service.projectSubscriptionRenewalReview({
      source: f.captured.source,
      raw,
      environment: process.env,
      observedAt,
    });
  const first = project(f.invoice);
  expect(
    project({ ...f.invoice, id: "upcoming_in_another" }, new Date(Date.now() + 1000)).termsDigest,
  ).toBe(first.termsDigest);
  expect(project({ ...f.invoice, amount_due: 2740, starting_balance: -500 }).termsDigest).not.toBe(
    first.termsDigest,
  );
  expect(
    project({
      ...f.invoice,
      tax: 300,
      total: 3300,
      total_tax_amounts: [{ amount: 300, inclusive: false, tax_rate: "txr_fixture" }],
    }).termsDigest,
  ).not.toBe(first.termsDigest);
});
test("wrong tenant, actor and revision never reach the provider", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, organizationId: randomUUID() },
    { ...f.input, actorId: randomUUID() },
    { ...f.input, expectedSubscriptionRevision: 1 },
  ]) {
    const count = customerRead.mock.calls.length;
    await expect(
      service.readOrganizationSubscriptionRenewalReview(input, session),
    ).rejects.toThrow();
    expect(customerRead.mock.calls.length).toBe(count);
  }
});
test("incomplete, cross-scope, unsupported-period and incomplete-tax previews fail closed", async () => {
  const f = await fixture();
  const line = f.invoice.lines.data[0]!;
  for (const raw of [
    { ...f.invoice, customer: "cus_other" },
    { ...f.invoice, subscription: "sub_other" },
    { ...f.invoice, livemode: true },
    { ...f.invoice, currency: "eur" },
    { ...f.invoice, automatic_tax: { enabled: true, status: "requires_location_inputs" } },
    { ...f.invoice, total: 3000 },
    { ...f.invoice, subtotal: 5000 },
    { ...f.invoice, tax: null },
    { ...f.invoice, amount_due: undefined },
    { ...f.invoice, lines: { ...f.invoice.lines, has_more: true } },
    { ...f.invoice, lines: { has_more: false, data: [line, line] } },
    ...[
      { ...line, subscription: "sub_other" },
      { ...line, proration: true },
      { ...line, price: { id: "price_other" } },
      { ...line, period: { ...line.period, start: line.period.start + 1 } },
    ].map((changed) => ({ ...f.invoice, lines: { has_more: false, data: [changed] } })),
  ]) {
    preview = raw;
    await expect(
      service.readOrganizationSubscriptionRenewalReview(f.input, session),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_REOBSERVE" });
  }
  expect(update).not.toHaveBeenCalled();
});
test("session loss and a pending command during provider IO discard the review", async () => {
  const f = await fixture();
  let checks = 0;
  await expect(
    service.readOrganizationSubscriptionRenewalReview(f.input, async () => {
      if (++checks === 2) throw new Error("session expired");
    }),
  ).rejects.toThrow("session expired");
  beforePreviewReturn = async () => {
    await repo.prepareCancellation({ ...f.input, idempotencyKey: randomUUID() }, "resume");
  };
  await expect(
    service.readOrganizationSubscriptionRenewalReview(f.input, session),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  expect(update).not.toHaveBeenCalled();
});

test("an active uncancelled subscription or missing entitlement cannot receive a reversal review", async () => {
  const active = await seedCancellationTestAccount();
  const count = customerRead.mock.calls.length;
  await expect(
    service.readOrganizationSubscriptionRenewalReview(active.input, session),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  expect(customerRead.mock.calls.length).toBe(count);
  const f = await fixture();
  await client
    .getPgliteClientForTests()
    .query("DELETE FROM organization_entitlements WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
  await expect(
    service.readOrganizationSubscriptionRenewalReview(f.input, session),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  expect(customerRead.mock.calls.length).toBe(count);
});
