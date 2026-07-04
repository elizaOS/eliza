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
const findOrganizationById = mock();
const listByOrganization = mock();

mock.module("../../../db/repositories", () => ({
  organizationsRepository: {
    update: updateOrganization,
    findById: findOrganizationById,
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

const { AutoTopUpService, parseAutoTopUpNumber, CorruptAutoTopUpNumberError } = await import(
  "../auto-top-up"
);

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
  findOrganizationById.mockReset();
  listByOrganization.mockReset();
  findOrganizationById.mockResolvedValue(makeOrganization());
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

describe("parseAutoTopUpNumber (fail-closed NUMERIC boundary)", () => {
  test("parses finite numeric strings and numbers", () => {
    expect(parseAutoTopUpNumber("auto_top_up_amount", "10.00")).toBe(10);
    expect(parseAutoTopUpNumber("markup_percent", 5)).toBe(5);
    expect(parseAutoTopUpNumber("markup_percent", "0")).toBe(0);
    expect(parseAutoTopUpNumber("markup_percent", 0)).toBe(0);
  });

  test("throws on the corrupt 'NaN'::numeric read-back that slips past bare Number()", () => {
    // Regression guard: bare Number("NaN") is NaN and NaN <= 0 / NaN > MAX are
    // both false, so this exact value used to flow into a Stripe NaN charge.
    expect(() => parseAutoTopUpNumber("auto_top_up_amount", "NaN")).toThrow(
      CorruptAutoTopUpNumberError,
    );
    expect(Number("NaN")).toBeNaN();
  });

  test("throws on null/undefined/blank/non-numeric values", () => {
    expect(() => parseAutoTopUpNumber("auto_top_up_amount", null)).toThrow(
      CorruptAutoTopUpNumberError,
    );
    expect(() => parseAutoTopUpNumber("auto_top_up_amount", undefined)).toThrow(
      CorruptAutoTopUpNumberError,
    );
    expect(() => parseAutoTopUpNumber("auto_top_up_amount", "   ")).toThrow(
      CorruptAutoTopUpNumberError,
    );
    expect(() => parseAutoTopUpNumber("auto_top_up_amount", "abc")).toThrow(
      CorruptAutoTopUpNumberError,
    );
    expect(() => parseAutoTopUpNumber("markup_percent", Number.POSITIVE_INFINITY)).toThrow(
      CorruptAutoTopUpNumberError,
    );
  });
});

describe("AutoTopUpService.executeAutoTopUp fail-closed money gates", () => {
  test("corrupt auto_top_up_amount ('NaN') disables + fails instead of charging NaN", async () => {
    const org = makeOrganization({ auto_top_up_amount: "NaN" });

    const result = await new AutoTopUpService().executeAutoTopUp(org);

    // The corrupt amount must NEVER reach Stripe as Math.round(NaN * 100).
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
    // Same fail-closed path as an out-of-range invalid amount: disable + fail.
    expect(updateOrganization).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ auto_top_up_enabled: false }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        success: false,
        error: "Invalid top-up amount",
      }),
    );
  });

  test("corrupt affiliate markup_percent charges the base amount (no NaN total), no surcharge", async () => {
    getReferrer.mockResolvedValue({
      user_id: "affiliate-owner",
      id: "code-1",
      markup_percent: "NaN",
    });

    const result = await new AutoTopUpService().executeAutoTopUp(makeOrganization());

    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    const chargedAmount = createPaymentIntent.mock.calls[0][0].amount;
    // Base $10.00 charged as 1000 cents, NOT Math.round(NaN * 100) = NaN.
    expect(chargedAmount).toBe(1000);
    expect(Number.isNaN(chargedAmount)).toBe(false);
    // Surcharge dropped: no affiliate fee metadata on a corrupt markup.
    const metadata = createPaymentIntent.mock.calls[0][0].metadata;
    expect(metadata.affiliate_fee_amount).toBeUndefined();
    expect(metadata.affiliate_owner_id).toBeUndefined();
    expect(metadata.total_charged).toBe("10.00");
    // Customer's top-up still succeeds (best-effort surcharge, fail-safe).
    expect(addCredits).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({ organizationId: "org-1", success: true, amount: 10 }),
    );
  });

  test("valid affiliate markup still applies the surcharge (no behavior change)", async () => {
    getReferrer.mockResolvedValue({
      user_id: "affiliate-owner",
      id: "code-1",
      markup_percent: "10",
    });

    await new AutoTopUpService().executeAutoTopUp(makeOrganization());

    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    // $10 base + 10% affiliate ($1) + 20% platform ($2) = $13.00 -> 1300 cents.
    expect(createPaymentIntent.mock.calls[0][0].amount).toBe(1300);
    const metadata = createPaymentIntent.mock.calls[0][0].metadata;
    expect(metadata.affiliate_fee_amount).toBe("1.00");
    expect(metadata.affiliate_owner_id).toBe("affiliate-owner");
    expect(metadata.total_charged).toBe("13.00");
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
