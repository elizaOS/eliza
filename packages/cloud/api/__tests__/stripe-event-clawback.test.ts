/** Exercises Stripe reversal queue behavior with deterministic Worker route fixtures. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockCreditTransaction = {
  id: string;
  organization_id: string;
  amount: string;
  type?: string;
};

const getTransactionByStripePaymentIntent = mock(
  async (
    _paymentIntentId: string,
  ): Promise<MockCreditTransaction | undefined> => ({
    id: "tx-credit",
    organization_id: "org-1",
    amount: "100",
    type: "credit",
  }),
);
const clawbackCredits = mock(async () => ({
  newBalance: 25,
  appliedAmount: 20,
  shortfallAmount: 0,
  alreadyProcessed: false,
}));
const refundCredits = mock(async () => ({
  transaction: {
    id: "tx-reinstated",
    organization_id: "org-1",
    amount: "45",
  },
  newBalance: 70,
}));
const getCheckoutOrderByPaymentIntent = mock(
  async (): Promise<{
    id: string;
    charge_amount_cents: bigint;
  } | null> => null,
);

class TestInsufficientCreditsError extends Error {
  required: number;

  constructor(required: number) {
    super("Insufficient credits");
    this.required = required;
  }
}

mock.module("@/db/helpers", () => ({
  dbRead: {},
  dbWrite: {},
  // Named so module linking succeeds for suites in the same bun test batch
  // that import it (e.g. agent-pairing-tokens); this suite must never reach
  // a real transaction, so the stub throws instead of faking one.
  writeTransaction: mock(async () => {
    throw new Error("writeTransaction must not be called in this suite");
  }),
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
// The mock replaces the whole module, so it must re-export every name any
// module pulled into this route binds, or bun fails linking ("Export named
// 'X' not found"). Cover ai-billing's full public surface — the clawback path
// exercises none of these; the stubs exist only to satisfy static imports.
mock.module("@/lib/services/ai-billing", () => ({
  InsufficientCreditsError: TestInsufficientCreditsError,
  estimateInputTokens: mock(() => 0),
  normalizeUsage: mock(() => ({})),
  reserveCredits: mock(async () => ({})),
  billUsage: mock(async () => ({})),
  billFlatUsage: mock(async () => ({})),
  recordUsageAnalytics: mock(async () => undefined),
  createOnFinishHandler: mock(() => () => undefined),
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    getTransactionByStripePaymentIntent,
    clawbackCredits,
    refundCredits,
  },
  ReservationNotFoundError: class extends Error {},
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
mock.module("@/lib/services/stripe-checkout-orders", () => ({
  stripeCheckoutOrdersService: {
    getByPaymentIntent: getCheckoutOrderByPaymentIntent,
  },
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
      type: "credit",
    });
    clawbackCredits.mockClear();
    clawbackCredits.mockResolvedValue({
      newBalance: 25,
      appliedAmount: 20,
      shortfallAmount: 0,
      alreadyProcessed: false,
    });
    refundCredits.mockClear();
    refundCredits.mockResolvedValue({
      transaction: {
        id: "tx-reinstated",
        organization_id: "org-1",
        amount: "45",
      },
      newBalance: 70,
    });
    getCheckoutOrderByPaymentIntent.mockClear();
    getCheckoutOrderByPaymentIntent.mockResolvedValue(null);
  });

  test("charge.refunded delegates the cumulative target to the atomic ledger mutation", async () => {
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
    expect(clawbackCredits).toHaveBeenCalledWith({
      organizationId: "org-1",
      amount: 50,
      cumulativeTargetAmount: 50,
      originalPaymentIntentId: "pi_1",
      description: "Stripe charge.refunded clawback — charge ch_1",
      stripePaymentIntentId: "stripe:refund:ch_1:5000",
      metadata: {
        payment_intent_id: "pi_1",
        reversed_usd: 50,
        capped_reversed_usd: 50,
        source: "charge.refunded",
        reference: "charge ch_1",
      },
    });
  });

  test("charge.refunded caps clawback at credits actually granted", async () => {
    getTransactionByStripePaymentIntent.mockResolvedValueOnce({
      id: "tx-credit",
      organization_id: "org-1",
      amount: "40",
    });

    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_refund_gross",
        eventType: "charge.refunded",
        receivedAt: Date.now(),
        event: {
          id: "evt_refund_gross",
          type: "charge.refunded",
          data: {
            object: {
              id: "ch_taxed",
              amount_refunded: 5000,
              payment_intent: "pi_taxed",
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(clawbackCredits).toHaveBeenCalledWith({
      organizationId: "org-1",
      amount: 40,
      cumulativeTargetAmount: 40,
      originalPaymentIntentId: "pi_taxed",
      description: "Stripe charge.refunded clawback — charge ch_taxed",
      stripePaymentIntentId: "stripe:refund:ch_taxed:5000",
      metadata: {
        payment_intent_id: "pi_taxed",
        reversed_usd: 50,
        capped_reversed_usd: 40,
        source: "charge.refunded",
        reference: "charge ch_taxed",
      },
    });
  });

  test("credit-pack refunds prorate the exact grant from the authoritative charge", async () => {
    getTransactionByStripePaymentIntent.mockResolvedValueOnce({
      id: "tx-pack",
      organization_id: "org-1",
      amount: "25",
      type: "credit",
    });
    getCheckoutOrderByPaymentIntent.mockResolvedValueOnce({
      id: "30000000-0000-4000-8000-000000000001",
      charge_amount_cents: 500n,
    });

    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_pack_refund",
        eventType: "charge.refunded",
        receivedAt: Date.now(),
        event: {
          id: "evt_pack_refund",
          type: "charge.refunded",
          data: {
            object: {
              id: "ch_pack",
              amount_refunded: 250,
              payment_intent: "pi_pack",
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(clawbackCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12.5,
        metadata: expect.objectContaining({
          checkout_order_id: "30000000-0000-4000-8000-000000000001",
          original_charge_usd: "5.00",
          original_credits_granted: "25.000000",
        }),
      }),
    );
  });

  test("re-delivered charge.refunded is a no-op once the cumulative amount was clawed", async () => {
    clawbackCredits.mockResolvedValueOnce({
      newBalance: 25,
      appliedAmount: 0,
      shortfallAmount: 0,
      alreadyProcessed: true,
    });

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
    expect(clawbackCredits).toHaveBeenCalledTimes(1);
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
      cumulativeTargetAmount: 75,
      originalPaymentIntentId: "pi_1",
      description:
        "Stripe charge.dispute.funds_withdrawn clawback — dispute dp_1 (charge ch_1)",
      stripePaymentIntentId: "stripe:dispute:dp_1",
      metadata: {
        payment_intent_id: "pi_1",
        reversed_usd: 75,
        capped_reversed_usd: 75,
        source: "charge.dispute.funds_withdrawn",
        reference: "dispute dp_1 (charge ch_1)",
      },
    });
  });

  test("charge.dispute.funds_reinstated restores only the applied dispute clawback", async () => {
    getTransactionByStripePaymentIntent.mockImplementationOnce(async (key) => {
      expect(key).toBe("stripe:dispute:dp_1");
      return {
        id: "tx-clawback",
        organization_id: "org-1",
        amount: "-45",
        type: "clawback",
      };
    });

    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_dispute_reinstated",
        eventType: "charge.dispute.funds_reinstated",
        receivedAt: Date.now(),
        event: {
          id: "evt_dispute_reinstated",
          type: "charge.dispute.funds_reinstated",
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
    expect(refundCredits).toHaveBeenCalledWith({
      organizationId: "org-1",
      amount: 45,
      description:
        "Stripe charge.dispute.funds_reinstated reinstatement — dispute dp_1 (charge ch_1)",
      stripePaymentIntentId: "stripe:dispute:dp_1:reinstated",
      metadata: {
        payment_intent_id: "pi_1",
        reinstated_usd: 75,
        applied_reinstatement_usd: 45,
        clawback_key: "stripe:dispute:dp_1",
        source: "charge.dispute.funds_reinstated",
        reference: "dispute dp_1 (charge ch_1)",
      },
    });
  });

  test("out-of-order funds_reinstated retries until the matching clawback commits", async () => {
    getTransactionByStripePaymentIntent.mockResolvedValueOnce(undefined);

    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_dispute_reinstated_noop",
        eventType: "charge.dispute.funds_reinstated",
        receivedAt: Date.now(),
        event: {
          id: "evt_dispute_reinstated_noop",
          type: "charge.dispute.funds_reinstated",
          data: {
            object: {
              id: "dp_missing",
              amount: 7500,
              charge: "ch_1",
              payment_intent: "pi_1",
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("retry");
    expect(refundCredits).not.toHaveBeenCalled();
  });
});
