// Exercises auto top up behavior with deterministic cloud-shared lib fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const selectMock = mock(() => ({
  from: mock(() => ({
    where: mock(async () => []),
  })),
}));

mock.module("../../../db/client", () => ({
  dbRead: {
    select: selectMock,
  },
}));

const updateOrganization = mock();
const listByOrganization = mock();

mock.module("../../../db/repositories", () => ({
  organizationsRepository: {
    update: updateOrganization,
  },
  usersRepository: {
    listByOrganization,
  },
}));

const createPaymentIntent = mock();
const retrievePaymentMethod = mock();
const requireStripe = mock(() => ({
  paymentIntents: {
    create: createPaymentIntent,
  },
  paymentMethods: {
    retrieve: retrievePaymentMethod,
  },
}));

mock.module("../../stripe", () => ({
  requireStripe,
}));

const addCredits = mock();

mock.module("../credits", () => ({
  creditsService: {
    addCredits,
  },
}));

const getReferrer = mock();

mock.module("../affiliates", () => ({
  affiliatesService: {
    getReferrer,
  },
}));

const sendAutoTopUpSuccessEmail = mock();
const sendAutoTopUpDisabledEmail = mock();

mock.module("../email", () => ({
  emailService: {
    sendAutoTopUpSuccessEmail,
    sendAutoTopUpDisabledEmail,
  },
}));

mock.module("../../utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const { AutoTopUpService } = await import("../auto-top-up");

type AutoTopUpOrganization = Parameters<AutoTopUpService["executeAutoTopUp"]>[0];

function makeOrganization(overrides: Partial<AutoTopUpOrganization> = {}): AutoTopUpOrganization {
  return {
    id: "org-1",
    name: "Acme Cloud",
    credit_balance: "5.00",
    auto_top_up_threshold: "10.00",
    auto_top_up_amount: "10.00",
    stripe_customer_id: "cus_123",
    stripe_default_payment_method: "pm_123",
    billing_email: "billing@example.com",
    auto_top_up_enabled: true,
    ...overrides,
  } as AutoTopUpOrganization;
}

beforeEach(() => {
  updateOrganization.mockReset();
  listByOrganization.mockReset();
  createPaymentIntent.mockReset();
  retrievePaymentMethod.mockReset();
  requireStripe.mockClear();
  addCredits.mockReset();
  getReferrer.mockReset();
  sendAutoTopUpSuccessEmail.mockReset();
  sendAutoTopUpDisabledEmail.mockReset();

  listByOrganization.mockResolvedValue([{ id: "user-1", email: "billing@example.com" }]);
  createPaymentIntent.mockResolvedValue({ id: "pi_auto_123", status: "succeeded" });
  retrievePaymentMethod.mockResolvedValue({ card: { brand: "visa", last4: "4242" } });
  addCredits.mockResolvedValue({ transaction: { id: "tx-1" }, newBalance: 42.25 });
  getReferrer.mockResolvedValue(null);
  sendAutoTopUpSuccessEmail.mockResolvedValue(true);
  sendAutoTopUpDisabledEmail.mockResolvedValue(true);
});

describe("AutoTopUpService.executeAutoTopUp", () => {
  test("persists successful auto top-up credits before returning success", async () => {
    const result = await new AutoTopUpService().executeAutoTopUp(makeOrganization());

    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(createPaymentIntent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        amount: 1000,
        currency: "usd",
        customer: "cus_123",
        payment_method: "pm_123",
        metadata: expect.objectContaining({
          organization_id: "org-1",
          credits: "10.00",
          type: "auto_top_up",
        }),
      }),
    );

    expect(addCredits).toHaveBeenCalledTimes(1);
    expect(addCredits).toHaveBeenCalledWith({
      organizationId: "org-1",
      amount: 10,
      description: "Auto top-up - $10.00",
      metadata: expect.objectContaining({
        organization_id: "org-1",
        credits: "10.00",
        type: "auto_top_up",
        payment_intent_id: "pi_auto_123",
      }),
      stripePaymentIntentId: "pi_auto_123",
    });

    expect(result).toEqual({
      organizationId: "org-1",
      success: true,
      amount: 10,
      newBalance: 42.25,
    });
  });
});

describe("AutoTopUpService.validateSettings", () => {
  const svc = new AutoTopUpService();
  test("accepts in-range values incl. boundaries", () => {
    expect(() => svc.validateSettings(1, 0)).not.toThrow();
    expect(() => svc.validateSettings(1000, 1000)).not.toThrow();
  });
  test("rejects amount below $1", () => {
    expect(() => svc.validateSettings(0.5, 5)).toThrow(/at least \$1/);
  });
  test("rejects amount above $1000", () => {
    expect(() => svc.validateSettings(1001, 5)).toThrow(/cannot exceed \$1000/);
  });
  test("rejects negative threshold", () => {
    expect(() => svc.validateSettings(10, -1)).toThrow(/threshold must be at least/);
  });
  test("rejects threshold above $1000", () => {
    expect(() => svc.validateSettings(10, 1001)).toThrow(/threshold cannot exceed/);
  });
});
