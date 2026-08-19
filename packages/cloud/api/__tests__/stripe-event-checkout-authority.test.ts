/**
 * Proves the Stripe queue uses durable Checkout authority and never mints from Checkout metadata.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const settle = mock(async () => ({
  order: {
    id: "30000000-0000-4000-8000-000000000001",
    organization_id: "authoritative-org",
    initiated_by_user_id: "authoritative-user",
    purchase_type: "credit_pack",
    credits_to_grant: "25.000000",
    charge_amount_cents: 500n,
    currency: "usd",
    stripe_customer_id: "cus_authoritative",
  },
  alreadyApplied: false,
  newBalance: 25,
}));
const settleLegacy = mock(async () => ({
  organizationId: "legacy-org",
  initiatedByUserId: "legacy-user",
  purchaseType: "custom_amount" as const,
  creditsToGrant: "5.000000",
  alreadyApplied: false,
  newBalance: 5,
}));
const addCredits = mock(async () => ({ newBalance: 999 }));
const calculateRevenueSplits = mock(async () => ({ splits: [] }));
const createInvoice = mock(async () => undefined);

mock.module("@/db/helpers", () => ({ dbRead: {} }));
mock.module("@/db/repositories/organizations", () => ({
  organizationsRepository: {
    findById: mock(async () => ({ name: "Authoritative" })),
  },
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: { findById: mock(async () => ({ name: "Buyer" })) },
}));
mock.module("@/db/schemas/agent-sandboxes", () => ({ agentSandboxes: {} }));
mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: mock(async () => Response.json({})),
}));
mock.module("@/lib/services/app-charge-callbacks", () => ({
  appChargeCallbacksService: {},
}));
mock.module("@/lib/services/app-charge-settlement", () => ({
  appChargeSettlementService: {},
}));
mock.module("@/lib/services/app-credits", () => ({ appCreditsService: {} }));
mock.module("@/lib/services/auto-top-up", () => ({ autoTopUpService: {} }));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    addCredits,
    getTransactionByStripePaymentIntent: mock(async () => null),
  },
}));
mock.module("@/lib/services/discord", () => ({
  discordService: { logPaymentReceived: mock(async () => undefined) },
}));
mock.module("@/lib/services/invoices", () => ({
  invoicesService: {
    getByStripeInvoiceId: mock(async () => null),
    create: createInvoice,
  },
}));
mock.module("@/lib/services/org-rate-limits", () => ({
  invalidateOrgTierCache: mock(async () => undefined),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {},
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {
    addEarnings: mock(async () => ({ success: true })),
  },
}));
mock.module("@/lib/services/referrals", () => ({
  referralsService: { calculateRevenueSplits },
}));
mock.module("@/lib/services/stripe-checkout-orders", () => ({
  stripeCheckoutOrdersService: { settle, settleLegacy },
}));
mock.module("@/lib/stripe", () => ({ requireStripe: () => ({}) }));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { processStripeEvent } = await import("../src/queue/stripe-event");

function checkoutDelivery(metadata: Record<string, string>) {
  return {
    attempts: 1,
    body: {
      kind: "stripe.event",
      eventId: "evt_checkout",
      eventType: "checkout.session.completed",
      receivedAt: Date.now(),
      event: {
        id: "evt_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_authoritative",
            client_reference_id: metadata.checkout_order_id ?? null,
            payment_status: "paid",
            amount_total: 500,
            currency: "usd",
            customer: "cus_authoritative",
            payment_intent: "pi_authoritative",
            metadata,
          },
        },
      },
    },
  } as Parameters<typeof processStripeEvent>[0];
}

beforeEach(() => {
  settle.mockClear();
  settleLegacy.mockClear();
  addCredits.mockClear();
  calculateRevenueSplits.mockClear();
  createInvoice.mockClear();
});

describe("Stripe Checkout queue authority", () => {
  test("ignores hostile amount and tenant metadata after durable lookup", async () => {
    const delivery = checkoutDelivery({
      checkout_order_id: "30000000-0000-4000-8000-000000000001",
      organization_id: "attacker-org",
      user_id: "attacker-user",
      credits: "9999.00",
      type: "custom_amount",
    });
    expect(await processStripeEvent(delivery)).toBe("ack");
    expect(settle).toHaveBeenCalledWith({
      checkoutOrderId: "30000000-0000-4000-8000-000000000001",
      clientReferenceId: "30000000-0000-4000-8000-000000000001",
      metadataOrderId: "30000000-0000-4000-8000-000000000001",
      checkoutSessionId: "cs_authoritative",
      paymentIntentId: "pi_authoritative",
      paymentStatus: "paid",
      amountTotal: 500,
      currency: "usd",
      customerId: "cus_authoritative",
    });
    expect(addCredits).not.toHaveBeenCalled();
    expect(calculateRevenueSplits).toHaveBeenCalledWith(
      "authoritative-user",
      5,
    );
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "authoritative-org",
        credits_added: "25",
        amount_paid: "5",
        stripe_payment_intent_id: "pi_authoritative",
      }),
    );
  });

  test("settles a pre-deploy checkout only through the validated cutover authority", async () => {
    expect(
      await processStripeEvent(
        checkoutDelivery({
          organization_id: "legacy-org",
          user_id: "legacy-user",
          credits: "5.00",
          type: "custom_amount",
        }),
      ),
    ).toBe("ack");
    expect(settle).not.toHaveBeenCalled();
    expect(settleLegacy).toHaveBeenCalledWith({
      checkoutSessionId: "cs_authoritative",
      paymentIntentId: "pi_authoritative",
      paymentStatus: "paid",
      amountTotal: 500,
      currency: "usd",
      customerId: "cus_authoritative",
      organizationId: "legacy-org",
      initiatedByUserId: "legacy-user",
      purchaseType: "custom_amount",
      creditPackId: null,
      claimedCredits: "5.00",
    });
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).toHaveBeenCalled();
  });

  test("does not project invoice or referral effects when legacy tenant binding fails", async () => {
    settleLegacy.mockImplementationOnce(async () => {
      throw new Error(
        "Legacy Stripe Checkout user tenant could not be verified",
      );
    });
    expect(
      await processStripeEvent(
        checkoutDelivery({
          organization_id: "org-a",
          user_id: "user-b",
          credits: "5.00",
          type: "custom_amount",
        }),
      ),
    ).toBe("retry");
    expect(calculateRevenueSplits).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
  });

  test("repairs a missing invoice when the durable credit is already settled", async () => {
    settle.mockImplementationOnce(async () => ({
      order: {
        id: "30000000-0000-4000-8000-000000000001",
        organization_id: "authoritative-org",
        initiated_by_user_id: "authoritative-user",
        purchase_type: "credit_pack",
        credits_to_grant: "25.000000",
        charge_amount_cents: 500n,
        currency: "usd",
        stripe_customer_id: "cus_authoritative",
      },
      alreadyApplied: true,
      newBalance: 25,
    }));
    expect(
      await processStripeEvent(
        checkoutDelivery({
          checkout_order_id: "30000000-0000-4000-8000-000000000001",
        }),
      ),
    ).toBe("ack");
    expect(createInvoice).toHaveBeenCalledTimes(1);
  });

  test("retries a durable delivery when its invoice projection fails", async () => {
    createInvoice.mockImplementationOnce(async () => {
      throw new Error("invoice database unavailable");
    });
    expect(
      await processStripeEvent(
        checkoutDelivery({
          checkout_order_id: "30000000-0000-4000-8000-000000000001",
        }),
      ),
    ).toBe("retry");
  });

  test("payment_intent.succeeded cannot bypass Checkout settlement", async () => {
    const delivery = {
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_pi",
        eventType: "payment_intent.succeeded",
        receivedAt: Date.now(),
        event: {
          id: "evt_pi",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_bypass",
              metadata: {
                organization_id: "attacker-org",
                credits: "9999.00",
                type: "custom_amount",
              },
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0];
    expect(await processStripeEvent(delivery)).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
