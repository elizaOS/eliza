/** Proves payment-method attachment delegates unbound tenants to durable Customer authority. */
import { beforeEach, expect, mock, test } from "bun:test";

const updateOrganization = mock(async () => undefined);
const ensureStripeCustomer = mock(async () => "cus_durable");
const attachPaymentMethod = mock(async () => undefined);
const listPaymentMethods = mock(async () => ({ data: [] }));
let organizationCustomerId: string | null = null;

mock.module("../../../db/repositories", () => ({
  organizationsRepository: {
    findById: mock(async () => ({
      id: "10000000-0000-4000-8000-000000000001",
      name: "Org A",
      stripe_customer_id: organizationCustomerId,
      stripe_default_payment_method: "pm_existing",
    })),
    update: updateOrganization,
  },
}));
mock.module("../stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: { ensure: ensureStripeCustomer },
}));
mock.module("../../stripe", () => ({
  requireStripe: () => ({
    paymentMethods: { attach: attachPaymentMethod, list: listPaymentMethods },
  }),
}));

const { paymentMethodsService } = await import("../payment-methods");

beforeEach(() => {
  organizationCustomerId = null;
  ensureStripeCustomer.mockClear();
  attachPaymentMethod.mockClear();
  listPaymentMethods.mockClear();
  updateOrganization.mockClear();
});

test("payment methods use the shared durable Stripe Customer authority", async () => {
  await paymentMethodsService.attachPaymentMethod("10000000-0000-4000-8000-000000000001", "pm_new");
  expect(ensureStripeCustomer).toHaveBeenCalledWith({
    organizationId: "10000000-0000-4000-8000-000000000001",
    callerIntent: "payment_method",
  });
  expect(attachPaymentMethod).toHaveBeenCalledWith("pm_new", { customer: "cus_durable" });
  expect(updateOrganization).toHaveBeenCalledWith(
    "10000000-0000-4000-8000-000000000001",
    expect.objectContaining({ stripe_payment_method_id: "pm_new" }),
  );
});

test("payment-method reads provider-verify a legacy existing Customer before use", async () => {
  organizationCustomerId = "cus_legacy";
  ensureStripeCustomer.mockResolvedValueOnce("cus_legacy");
  await paymentMethodsService.listPaymentMethods("10000000-0000-4000-8000-000000000001");
  expect(ensureStripeCustomer).toHaveBeenCalledWith({
    organizationId: "10000000-0000-4000-8000-000000000001",
    callerIntent: "payment_method",
  });
  expect(listPaymentMethods).toHaveBeenCalledWith({ customer: "cus_legacy", type: "card" });
});
