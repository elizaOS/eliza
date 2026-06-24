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

const loggerError = mock();

mock.module("../../utils/logger", () => ({
  logger: {
    debug: mock(),
    error: loggerError,
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
  loggerError.mockReset();

  listByOrganization.mockResolvedValue([{ id: "user-1", email: "billing@example.com" }]);
  createPaymentIntent.mockResolvedValue({
    id: "pi_auto_123",
    status: "succeeded",
  });
  retrievePaymentMethod.mockResolvedValue({
    card: { brand: "visa", last4: "4242" },
  });
  addCredits.mockResolvedValue({
    transaction: { id: "tx-1" },
    newBalance: 42.25,
  });
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

  test("credits the base amount, never the fee-inclusive total charged to Stripe", async () => {
    // 10% affiliate markup on a $10 base → Stripe is charged more, but the org is only
    // credited the base. addCredits and the webhook (paymentIntent.metadata.credits) must
    // agree on the base, otherwise the two paths can't dedup to a single credit.
    getReferrer.mockResolvedValue({
      id: "code-1",
      user_id: "owner-1",
      markup_percent: "10",
    });

    await new AutoTopUpService().executeAutoTopUp(makeOrganization());

    // base $10 + 10% affiliate + 20% platform = $13 charged
    expect(createPaymentIntent.mock.calls[0][0].amount).toBe(1300);
    // but only the base $10 is credited
    expect(addCredits.mock.calls[0][0].amount).toBe(10);
    expect(addCredits.mock.calls[0][0].stripePaymentIntentId).toBe("pi_auto_123");
  });

  test("charged-but-persist-failed: logs CRITICAL and still returns success with the local balance", async () => {
    // The card is already charged when addCredits throws. We must NOT flip to
    // success:false (that risks a retry / double charge) — the Stripe webhook reconciles
    // via the same payment-intent idempotency key. Fall back to previousBalance + amount.
    addCredits.mockRejectedValue(new Error("db down"));

    const result = await new AutoTopUpService().executeAutoTopUp(makeOrganization());

    expect(addCredits).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      organizationId: "org-1",
      success: true,
      amount: 10,
      newBalance: 15, // local fallback: previousBalance 5 + amount 10
    });

    const critical = loggerError.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("CRITICAL"),
    );
    expect(critical).toBeDefined();
    expect(critical?.[0]).toContain("org-1");
    expect(critical?.[0]).toContain("pi_auto_123");
  });
});
