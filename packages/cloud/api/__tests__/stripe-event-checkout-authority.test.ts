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

// Terminal authority has independent real-DB consumer coverage; these fixtures own purchased-credit dispatch.
mock.module(
  "@elizaos/cloud-shared/lib/services/stripe-scheduled-cancellation-lifecycle",
  () => ({
    reconcileStripeScheduledCancellationLifecycle: async () => {
      throw new Error(
        "Scheduled subscription lifecycle unavailable in legacy fixture",
      );
    },
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/subscription-checkout", () => ({
  reconcileSubscriptionCheckout: async () => {
    throw new Error(
      "Subscription checkout authority unavailable in purchased-credit fixture",
    );
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/stripe-terminal-lifecycle",
  () => ({
    reconcileStripeTerminalLifecycle: async () => {
      throw new Error("Subscription lifecycle unavailable in legacy fixture");
    },
  }),
);
mock.module("@elizaos/cloud-shared/db/helpers", () => ({ dbRead: {} }));
mock.module("@elizaos/cloud-shared/lib/services/billing-hold", () => ({
  billingHoldService: {
    settleOutstandingShortfalls: async () => ({
      appliedUsd: "0.000000",
      outstandingUsd: "0.000000",
      releasedHoldIds: [],
      repaymentTransactionId: null,
    }),
    getState: async () => ({ status: "clear" }),
  },
}));
mock.module("@elizaos/cloud-shared/db/repositories/organizations", () => ({
  organizationsRepository: {
    findById: mock(async () => ({ name: "Authoritative" })),
  },
}));
mock.module("@elizaos/cloud-shared/db/repositories/users", () => ({
  usersRepository: { findById: mock(async () => ({ name: "Buyer" })) },
}));
mock.module("@elizaos/cloud-shared/db/schemas/agent-sandboxes", () => ({
  agentSandboxes: {},
}));
mock.module("@elizaos/cloud-shared/lib/security/safe-fetch", () => ({
  safeFetch: mock(async () => Response.json({})),
}));
mock.module("@elizaos/cloud-shared/lib/services/auto-top-up", () => ({
  autoTopUpService: {},
}));
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({
  creditsService: {
    addCredits,
    getTransactionByStripePaymentIntent: mock(async () => null),
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/discord", () => ({
  discordService: { logPaymentReceived: mock(async () => undefined) },
}));
mock.module("@elizaos/cloud-shared/lib/services/invoices", () => ({
  invoicesService: {
    getByStripeInvoiceId: mock(async () => null),
    create: createInvoice,
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/org-rate-limits", () => ({
  invalidateOrgTierCache: mock(async () => undefined),
}));
mock.module("@elizaos/cloud-shared/agents", () => ({
  CONTAINER_BACKED_TARGET_REJECTION_REASON:
    "agent_job_target_not_container_backed",
  provisioningJobService: {},
}));
mock.module("@elizaos/cloud-shared/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {
    addEarnings: mock(async () => ({ success: true })),
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/referrals", () => ({
  referralsService: { calculateRevenueSplits },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/stripe-checkout-orders",
  () => ({
    stripeCheckoutOrdersService: { settle, settleLegacy },
  }),
);
mock.module("@elizaos/cloud-shared/lib/stripe", () => ({
  requireStripe: () => ({}),
}));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
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
            mode: "payment",
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
  test("subscription Checkout cannot settle one-time credits even when marked paid", async () => {
    const item = checkoutDelivery({
      checkout_order_id: "30000000-0000-4000-8000-000000000001",
    });
    const session = item.body.event.data
      .object as import("stripe").default.Checkout.Session;
    session.mode = "subscription";
    expect(await processStripeEvent(item)).toBe("retry");
    expect(settle).not.toHaveBeenCalled();
    expect(settleLegacy).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
  });
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
              invoice: null,
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
