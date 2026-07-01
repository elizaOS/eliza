import { beforeEach, describe, expect, mock, test } from "bun:test";

const getTransactionByStripePaymentIntent = mock(async () => ({
  id: "tx-credit",
  organization_id: "org-1",
  amount: "100",
}));
const getClawedBackUsdForPaymentIntent = mock(async () => 0);
const clawbackCredits = mock(async () => ({
  newBalance: 25,
  appliedAmount: 20,
  shortfallAmount: 0,
  alreadyProcessed: false,
}));

mock.module("@/db/helpers", () => ({
  dbRead: {},
}));
mock.module("@/db/repositories/organizations", () => ({
  organizationsRepository: {},
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: {},
}));
mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: mock(async () => Response.json({ ok: true })),
}));
mock.module("@/lib/services/app-charge-callbacks", () => ({
  appChargeCallbacksService: {},
}));
mock.module("@/lib/services/app-charge-settlement", () => ({
  appChargeSettlementService: {},
}));
mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {},
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    getTransactionByStripePaymentIntent,
    getClawedBackUsdForPaymentIntent,
    clawbackCredits,
  },
}));
mock.module("@/lib/services/discord", () => ({
  discordService: {},
}));
mock.module("@/lib/services/invoices", () => ({
  invoicesService: {},
}));
mock.module("@/lib/services/org-rate-limits", () => ({
  invalidateOrgTierCache: mock(async () => undefined),
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {},
}));
mock.module("@/lib/services/referrals", () => ({
  referralsService: {},
}));
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({}),
}));

const { processStripeEvent } = await import("../src/queue/stripe-event");

describe("stripe queue credit clawbacks", () => {
  beforeEach(() => {
    getTransactionByStripePaymentIntent.mockClear();
    getTransactionByStripePaymentIntent.mockResolvedValue({
      id: "tx-credit",
      organization_id: "org-1",
      amount: "100",
    });
    getClawedBackUsdForPaymentIntent.mockClear();
    getClawedBackUsdForPaymentIntent.mockResolvedValue(0);
    clawbackCredits.mockClear();
    clawbackCredits.mockResolvedValue({
      newBalance: 25,
      appliedAmount: 20,
      shortfallAmount: 0,
      alreadyProcessed: false,
    });
  });

  test("charge.refunded claws back only the new cumulative refund delta", async () => {
    getClawedBackUsdForPaymentIntent.mockResolvedValueOnce(30);

    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_refund",
        eventType: "charge.refunded",
        receivedAt: Date.now(),
        event: {
          id: "evt_refund",
          type: "charge.refunded",
          data: {
            object: {
              id: "ch_1",
              amount_refunded: 5000,
              payment_intent: "pi_1",
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(getTransactionByStripePaymentIntent).toHaveBeenCalledWith("pi_1");
    expect(getClawedBackUsdForPaymentIntent).toHaveBeenCalledWith("pi_1");
    expect(clawbackCredits).toHaveBeenCalledWith({
      organizationId: "org-1",
      amount: 20,
      description: "Stripe charge.refunded clawback — charge ch_1",
      stripePaymentIntentId: "stripe:refund:ch_1:5000",
      metadata: {
        payment_intent_id: "pi_1",
        reversed_usd: 50,
        source: "charge.refunded",
        reference: "charge ch_1",
      },
    });
  });

  test("re-delivered charge.refunded is a no-op once the cumulative amount was clawed", async () => {
    getClawedBackUsdForPaymentIntent.mockResolvedValueOnce(50);

    const result = await processStripeEvent({
      attempts: 2,
      body: {
        kind: "stripe.event",
        eventId: "evt_refund_redelivery",
        eventType: "charge.refunded",
        receivedAt: Date.now(),
        event: {
          id: "evt_refund_redelivery",
          type: "charge.refunded",
          data: {
            object: {
              id: "ch_1",
              amount_refunded: 5000,
              payment_intent: "pi_1",
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  test("charge.dispute.funds_withdrawn claws back the disputed amount with a dispute key", async () => {
    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_dispute",
        eventType: "charge.dispute.funds_withdrawn",
        receivedAt: Date.now(),
        event: {
          id: "evt_dispute",
          type: "charge.dispute.funds_withdrawn",
          data: {
            object: {
              id: "dp_1",
              amount: 7500,
              charge: "ch_1",
              payment_intent: "pi_1",
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(clawbackCredits).toHaveBeenCalledWith({
      organizationId: "org-1",
      amount: 75,
      description:
        "Stripe charge.dispute.funds_withdrawn clawback — dispute dp_1 (charge ch_1)",
      stripePaymentIntentId: "stripe:dispute:dp_1",
      metadata: {
        payment_intent_id: "pi_1",
        reversed_usd: 75,
        source: "charge.dispute.funds_withdrawn",
        reference: "dispute dp_1 (charge ch_1)",
      },
    });
  });
});
