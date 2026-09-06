/**
 * Unit tests for the Stripe event queue consumer in `src/queue/stripe-event.ts`.
 *
 * Drives the real exported helpers and `processStripeEvent` dispatch. Downstream
 * I/O is stubbed at the service seam so assertions record observed ack/retry
 * and no-op behaviour rather than the stub's own return value.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const getTransactionByStripePaymentIntent = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    amount: string;
    type?: string;
  } | null> => null,
);
const addCredits = mock(async () => ({ newBalance: 10 }));
const clawbackCredits = mock(async () => ({
  newBalance: 80,
  appliedAmount: 20,
  shortfallAmount: 0,
  alreadyProcessed: false,
}));
const refundCredits = mock(async () => ({
  transaction: { id: "tx-reinstated" },
  newBalance: 100,
}));
const failChargeAndEnqueue = mock(async () => undefined);
const getByStripeInvoiceId = mock(async () => null);
const createInvoice = mock(async () => undefined);
const retrieveInvoice = mock(async (id: string) => ({
  id,
  customer: "cus_1",
  subscription: id.startsWith("in_recurring") ? "sub_recurring" : null,
  amount_due: 1000,
  amount_paid: 1000,
  currency: "usd",
  status: "paid",
  number: "INV-1",
  invoice_pdf: undefined,
  hosted_invoice_url: undefined,
  status_transitions: { paid_at: 1_700_000_000 },
}));

const retrieveCharge = mock(
  async (id: string): Promise<{ id: string; invoice: string | null }> => ({
    id,
    invoice: null,
  }),
);

mock.module("@/db/helpers", () => ({ dbRead: {} }));
mock.module("@/db/repositories/organizations", () => ({
  organizationsRepository: {
    findById: mock(async () => ({ name: "Org" })),
  },
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: { findById: mock(async () => ({ name: "User" })) },
}));
mock.module("@/db/schemas/agent-sandboxes", () => ({ agentSandboxes: {} }));
mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: mock(async () => Response.json({ ok: true })),
}));
mock.module("@/lib/services/app-charge-callbacks", () => ({
  appChargeCallbacksService: { failChargeAndEnqueue },
}));
mock.module("@/lib/services/app-charge-settlement", () => ({
  appChargeSettlementService: {},
}));
mock.module("@/lib/services/app-credits", () => ({ appCreditsService: {} }));
mock.module("@/lib/services/auto-top-up", () => ({ autoTopUpService: {} }));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    getTransactionByStripePaymentIntent,
    addCredits,
    clawbackCredits,
    refundCredits,
  },
  ReservationNotFoundError: class extends Error {},
}));
mock.module("@/lib/services/discord", () => ({
  discordService: { logPaymentReceived: mock(async () => undefined) },
}));
mock.module("@/lib/services/invoices", () => ({
  invoicesService: { getByStripeInvoiceId, create: createInvoice },
}));
mock.module("@/lib/services/org-rate-limits", () => ({
  invalidateOrgTierCache: mock(async () => undefined),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  CONTAINER_BACKED_TARGET_REJECTION_REASON:
    "agent_job_target_not_container_backed",
  provisioningJobService: {},
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {
    addEarnings: mock(async () => ({ success: true })),
  },
}));
mock.module("@/lib/services/referrals", () => ({
  referralsService: {
    calculateRevenueSplits: mock(async () => ({ splits: [] })),
  },
}));
mock.module("@/lib/services/stripe-checkout-orders", () => ({
  stripeCheckoutOrdersService: {
    getByPaymentIntent: mock(async () => null),
  },
}));
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    invoices: { retrieve: retrieveInvoice },
    charges: { retrieve: retrieveCharge },
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const queueLists = new Map<string, string[]>();
mock.module("@/lib/cache/client", () => ({
  cache: {
    pushQueueHead: async (key: string, value: string) => {
      const list = queueLists.get(key) ?? [];
      list.unshift(value);
      queueLists.set(key, list);
      return list.length;
    },
    popQueueTail: async (key: string) => queueLists.get(key)?.pop() ?? null,
  },
}));
const { enqueue, drain } = await import("@/lib/queue/redis-queue");

const {
  isInvoiceExpanded,
  parseAndValidateCredits,
  processStripeEvent,
  STRIPE_MAX_CREDITS,
} = await import("../src/queue/stripe-event");

function delivery(
  type: string,
  object: Record<string, unknown>,
  attempts = 1,
): Parameters<typeof processStripeEvent>[0] {
  return {
    attempts,
    body: {
      kind: "stripe.event",
      eventId: `evt_${type}`,
      eventType: type,
      receivedAt: Date.now(),
      event: {
        id: `evt_${type}`,
        api_version: "2024-11-20.acacia",
        type,
        data: { object },
      },
    },
  } as unknown as Parameters<typeof processStripeEvent>[0];
}

beforeEach(() => {
  getTransactionByStripePaymentIntent.mockClear();
  getTransactionByStripePaymentIntent.mockResolvedValue(null);
  addCredits.mockClear();
  clawbackCredits.mockClear();
  refundCredits.mockClear();
  failChargeAndEnqueue.mockClear();
  getByStripeInvoiceId.mockClear();
  getByStripeInvoiceId.mockResolvedValue(null);
  createInvoice.mockClear();
  retrieveInvoice.mockClear();
  retrieveCharge.mockReset();
  retrieveCharge.mockImplementation(async (id: string) => ({
    id,
    invoice: null,
  }));
});

describe("STRIPE_MAX_CREDITS", () => {
  test("is the 10000 USD hard cap used by parseAndValidateCredits", () => {
    expect(STRIPE_MAX_CREDITS).toBe(10000);
    expect(parseAndValidateCredits(String(STRIPE_MAX_CREDITS))).toBe(10000);
    expect(
      parseAndValidateCredits(String(STRIPE_MAX_CREDITS + 0.01)),
    ).toBeNull();
  });
});

describe("parseAndValidateCredits", () => {
  test("parses whole dollars and two-decimal currency strings", () => {
    expect(parseAndValidateCredits("10")).toBe(10);
    expect(parseAndValidateCredits("10.00")).toBe(10);
    expect(parseAndValidateCredits("0.01")).toBe(0.01);
  });

  test("rounds half-up at the third decimal", () => {
    expect(parseAndValidateCredits("10.005")).toBe(10.01);
    expect(parseAndValidateCredits("0.336")).toBe(0.34);
  });

  test("returns 0 when a positive sub-cent value rounds to zero", () => {
    expect(parseAndValidateCredits("0.001")).toBe(0);
    expect(parseAndValidateCredits("0.004")).toBe(0);
  });

  test("rejects non-positive, non-finite, and empty input", () => {
    expect(parseAndValidateCredits("0")).toBeNull();
    expect(parseAndValidateCredits("-5")).toBeNull();
    expect(parseAndValidateCredits("")).toBeNull();
    expect(parseAndValidateCredits("abc")).toBeNull();
    expect(parseAndValidateCredits("NaN")).toBeNull();
    expect(parseAndValidateCredits("Infinity")).toBeNull();
  });

  test("rejects values strictly above the cap and accepts the cap", () => {
    expect(parseAndValidateCredits("10000")).toBe(10000);
    expect(parseAndValidateCredits("10000.00")).toBe(10000);
    expect(parseAndValidateCredits("10001")).toBeNull();
  });

  test("accepts parseFloat-compatible prefixes and scientific notation", () => {
    expect(parseAndValidateCredits("1e2")).toBe(100);
    expect(parseAndValidateCredits(" 7.5")).toBe(7.5);
    expect(parseAndValidateCredits("10foo")).toBe(10);
  });
});

describe("isInvoiceExpanded", () => {
  test("is true for an object that has an id own-key", () => {
    expect(isInvoiceExpanded({ id: "in_123" })).toBe(true);
    expect(isInvoiceExpanded({ id: undefined })).toBe(true);
    expect(isInvoiceExpanded({ id: "" })).toBe(true);
  });

  test("is false for a string id, null, undefined, and id-less values", () => {
    expect(isInvoiceExpanded("in_123")).toBe(false);
    expect(isInvoiceExpanded(null)).toBe(false);
    expect(isInvoiceExpanded(undefined)).toBe(false);
    expect(isInvoiceExpanded({ amount_due: 100 })).toBe(false);
    expect(isInvoiceExpanded(42)).toBe(false);
    expect(isInvoiceExpanded([])).toBe(false);
  });
});

describe("processStripeEvent dispatch", () => {
  test("acks unhandled event types without touching credits", async () => {
    expect(
      await processStripeEvent(delivery("customer.created", { id: "cus_1" })),
    ).toBe("ack");
    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  test("acks unpaid checkout sessions before looking up a payment intent", async () => {
    expect(
      await processStripeEvent(
        delivery("checkout.session.completed", {
          id: "cs_unpaid",
          mode: "payment",
          payment_status: "unpaid",
          payment_intent: "pi_unpaid",
          metadata: { organization_id: "org-1", credits: "10.00" },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
  });

  test("acks a paid checkout that has no payment intent id", async () => {
    expect(
      await processStripeEvent(
        delivery("checkout.session.completed", {
          id: "cs_no_pi",
          mode: "payment",
          payment_status: "paid",
          payment_intent: null,
          metadata: { organization_id: "org-1", credits: "10.00" },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
  });

  test("extracts an expanded checkout payment_intent.id then acks invalid authority", async () => {
    expect(
      await processStripeEvent(
        delivery("checkout.session.completed", {
          id: "cs_expanded",
          mode: "payment",
          payment_status: "paid",
          payment_intent: { id: "pi_expanded" },
          metadata: { credits: "0" },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
  });

  test("skips checkout-owned payment_intent.succeeded events", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.succeeded", {
          id: "pi_checkout_owned",
          invoice: null,
          amount: 1000,
          amount_received: 1000,
          currency: "usd",
          metadata: {
            organization_id: "org-1",
            credits: "10.00",
            type: "custom_amount",
            checkout_order_id: "30000000-0000-4000-8000-000000000001",
          },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
  });

  test("skips payment intents with no purchase type and no auto-top-up marker", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.succeeded", {
          id: "pi_unknown",
          invoice: null,
          amount: 1000,
          amount_received: 1000,
          currency: "usd",
          metadata: { organization_id: "org-1", credits: "10.00" },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
  });
});

describe("processStripeEvent payment_intent.succeeded one-time purchase", () => {
  test("credits a one-time purchase and writes a synthetic invoice keyed by the PI", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.succeeded", {
          id: "pi_one_time",
          invoice: null,
          amount: 2500,
          amount_received: 2500,
          currency: "usd",
          customer: "cus_1",
          metadata: {
            organization_id: "org-1",
            credits: "25.00",
            type: "one_time",
          },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        amount: 25,
        stripePaymentIntentId: "pi_one_time",
        description: "One-time purchase - $25.00",
      }),
    );
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-1",
        stripe_invoice_id: "pi_pi_one_time",
        stripe_payment_intent_id: "pi_one_time",
        credits_added: "25",
        status: "paid",
      }),
    );
  });

  test("does not credit again when the payment intent already has a ledger row", async () => {
    getTransactionByStripePaymentIntent.mockResolvedValueOnce({
      id: "tx-existing",
      organization_id: "org-1",
      amount: "25",
      type: "credit",
    });
    expect(
      await processStripeEvent(
        delivery("payment_intent.succeeded", {
          id: "pi_dup",
          invoice: null,
          amount: 2500,
          amount_received: 2500,
          currency: "usd",
          metadata: {
            organization_id: "org-1",
            credits: "25.00",
            type: "one_time",
          },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
  });

  test("acks invalid one-time metadata instead of retrying", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.succeeded", {
          id: "pi_bad_meta",
          invoice: null,
          amount: 1000,
          amount_received: 1000,
          currency: "usd",
          metadata: { type: "one_time", credits: "not-a-number" },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
  });

  test("acks a non-finite affiliate fee as a permanent metadata failure", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.succeeded", {
          id: "pi_bad_affiliate",
          invoice: null,
          amount: 1000,
          amount_received: 1000,
          currency: "usd",
          metadata: {
            organization_id: "org-1",
            credits: "10.00",
            type: "one_time",
            affiliate_fee_amount: "NaN",
          },
        }),
      ),
    ).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
  });

  test("retains invoice-backed payment before metadata can grant global credits", async () => {
    for (const invoice of ["in_recurring", { id: "in_recurring" }]) {
      expect(
        await processStripeEvent(
          delivery("payment_intent.succeeded", {
            id: "pi_invoice",
            amount: 9900,
            amount_received: 9900,
            currency: "usd",
            metadata: {
              organization_id: "org-1",
              credits: "99.00",
              type: "one_time",
            },
            invoice,
          }),
        ),
      ).toBe("retry");
    }
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
  });
});

describe("processStripeEvent payment_intent.payment_failed", () => {
  test("acks a failed intent that is not a miniapp charge without callbacks", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.payment_failed", {
          id: "pi_failed",
          invoice: null,
          status: "requires_payment_method",
          amount: 500,
          metadata: { organization_id: "org-1" },
        }),
      ),
    ).toBe("ack");
    expect(failChargeAndEnqueue).not.toHaveBeenCalled();
  });

  test("forwards a miniapp charge failure with the Stripe error message", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.payment_failed", {
          id: "pi_app_failed",
          invoice: null,
          status: "requires_payment_method",
          amount: 199,
          metadata: {
            source: "miniapp_app",
            app_id: "app-1",
            charge_request_id: "cr-1",
            user_id: "user-1",
            organization_id: "org-1",
            credits: "1.99",
          },
          last_payment_error: { message: "Your card was declined." },
        }),
      ),
    ).toBe("ack");
    expect(failChargeAndEnqueue).toHaveBeenCalledWith({
      appId: "app-1",
      chargeRequestId: "cr-1",
      status: "failed",
      provider: "stripe",
      providerPaymentId: "pi_app_failed",
      amountUsd: 1.99,
      payerUserId: "user-1",
      payerOrganizationId: "org-1",
      reason: "Your card was declined.",
      metadata: { stripe_payment_intent_status: "requires_payment_method" },
    });
  });

  test("falls back to the error code then a default reason", async () => {
    expect(
      await processStripeEvent(
        delivery("payment_intent.payment_failed", {
          id: "pi_code_only",
          invoice: null,
          status: "requires_payment_method",
          amount: 100,
          metadata: {
            source: "miniapp_app",
            app_id: "app-1",
            charge_request_id: "cr-2",
          },
          last_payment_error: { code: "card_declined" },
        }),
      ),
    ).toBe("ack");
    expect(failChargeAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "card_declined", amountUsd: 1 }),
    );

    failChargeAndEnqueue.mockClear();
    expect(
      await processStripeEvent(
        delivery("payment_intent.payment_failed", {
          id: "pi_no_error",
          invoice: null,
          status: "requires_payment_method",
          metadata: {
            source: "miniapp_app",
            app_id: "app-1",
            charge_request_id: "cr-3",
          },
        }),
      ),
    ).toBe("ack");
    expect(failChargeAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "Payment failed",
        amountUsd: undefined,
      }),
    );
  });
});

describe("processStripeEvent reversal no-ops and retry classification", () => {
  test("acks a refund with no payment intent without clawing back", async () => {
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_no_pi",
          invoice: null,
          amount_refunded: 500,
          payment_intent: null,
        }),
      ),
    ).toBe("ack");
    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  test("acks a zero-amount refund without clawing back", async () => {
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_zero",
          invoice: null,
          amount_refunded: 0,
          payment_intent: "pi_1",
        }),
      ),
    ).toBe("ack");
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  test("reads an expanded charge.payment_intent.id then no-ops when no grant exists", async () => {
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_expanded",
          invoice: null,
          amount_refunded: 500,
          payment_intent: { id: "pi_expanded_refund" },
        }),
      ),
    ).toBe("ack");
    expect(getTransactionByStripePaymentIntent).toHaveBeenCalledWith(
      "pi_expanded_refund",
    );
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  test("does not claw back an unparseable or non-positive grant amount", async () => {
    getTransactionByStripePaymentIntent.mockResolvedValueOnce({
      id: "tx-bad",
      organization_id: "org-1",
      amount: "not-a-credit",
    });
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_bad_grant",
          invoice: null,
          amount_refunded: 500,
          payment_intent: "pi_bad_grant",
        }),
      ),
    ).toBe("ack");
    expect(clawbackCredits).not.toHaveBeenCalled();

    getTransactionByStripePaymentIntent.mockResolvedValueOnce({
      id: "tx-zero",
      organization_id: "org-1",
      amount: "0",
    });
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_zero_grant",
          invoice: null,
          amount_refunded: 500,
          payment_intent: "pi_zero_grant",
        }),
      ),
    ).toBe("ack");
    expect(clawbackCredits).not.toHaveBeenCalled();
  });

  test("retries funds_reinstated when the matching clawback row is not a clawback", async () => {
    getTransactionByStripePaymentIntent.mockResolvedValueOnce({
      id: "tx-credit",
      organization_id: "org-1",
      amount: "45",
      type: "credit",
    });
    expect(
      await processStripeEvent(
        delivery("charge.dispute.funds_reinstated", {
          id: "dp_wrong_type",
          amount: 4500,
          charge: "ch_1",
          payment_intent: "pi_1",
        }),
      ),
    ).toBe("retry");
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("acks funds_reinstated when the applied clawback amount is not positive", async () => {
    getTransactionByStripePaymentIntent.mockResolvedValueOnce({
      id: "tx-clawback",
      organization_id: "org-1",
      amount: "0",
      type: "clawback",
    });
    expect(
      await processStripeEvent(
        delivery("charge.dispute.funds_reinstated", {
          id: "dp_zero",
          amount: 4500,
          charge: { id: "ch_1", invoice: null },
          payment_intent: { id: "pi_1" },
        }),
      ),
    ).toBe("ack");
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("acks a lookup whose error message is a permanent 'not found'", async () => {
    getTransactionByStripePaymentIntent.mockRejectedValueOnce(
      new Error("organization not found"),
    );
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_not_found",
          invoice: null,
          amount_refunded: 100,
          payment_intent: "pi_missing_org",
        }),
      ),
    ).toBe("ack");
  });

  test("acks a lookup whose error message contains Invalid or already processed", async () => {
    getTransactionByStripePaymentIntent.mockRejectedValueOnce(
      new Error("Invalid grant row"),
    );
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_invalid",
          invoice: null,
          amount_refunded: 100,
          payment_intent: "pi_invalid",
        }),
      ),
    ).toBe("ack");

    getTransactionByStripePaymentIntent.mockRejectedValueOnce(
      new Error("charge already processed"),
    );
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_processed",
          invoice: null,
          amount_refunded: 100,
          payment_intent: "pi_processed",
        }),
      ),
    ).toBe("ack");
  });

  test("retries a transient lookup failure", async () => {
    getTransactionByStripePaymentIntent.mockRejectedValueOnce(
      new Error("connection timed out"),
    );
    expect(
      await processStripeEvent(
        delivery(
          "charge.refunded",
          {
            id: "ch_timeout",
            invoice: null,
            amount_refunded: 100,
            payment_intent: "pi_timeout",
          },
          3,
        ),
      ),
    ).toBe("retry");
  });

  test("retries a non-Error throw as a transient failure", async () => {
    getTransactionByStripePaymentIntent.mockRejectedValueOnce("redis down");
    expect(
      await processStripeEvent(
        delivery("charge.refunded", {
          id: "ch_string_throw",
          invoice: null,
          amount_refunded: 100,
          payment_intent: "pi_string_throw",
        }),
      ),
    ).toBe("retry");
  });
});

describe("recurring event retention", () => {
  test("retains subscription lifecycle and invoice deliveries across retries without granting purchased credits", async () => {
    const events = [
      delivery("customer.subscription.created", {
        id: "sub_first",
        status: "trialing",
      }),
      delivery("customer.subscription.updated", {
        id: "sub_first",
        status: "active",
      }),
      delivery("customer.subscription.deleted", {
        id: "sub_first",
        status: "canceled",
      }),
      delivery("invoice.paid", {
        id: "in_zero_trial",
        subscription: "sub_first",
        amount_paid: 0,
      }),
      delivery("invoice.payment_failed", {
        id: "in_failed",
        subscription: { id: "sub_first" },
      }),
      delivery("invoice.payment_action_required", {
        id: "in_action",
        billing_reason: "subscription_cycle",
      }),
      delivery("invoice.voided", {
        id: "in_void",
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_first" },
        },
      }),
      delivery("invoice.finalization_failed", {
        id: "in_finalization",
        subscription: "sub_first",
      }),
    ];
    for (const event of events.reverse()) {
      expect(await processStripeEvent(event)).toBe("retry");
      expect(await processStripeEvent({ ...event, attempts: 8 })).toBe("retry");
    }
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
  });

  test("isolates paid and abandoned subscription checkout even with legacy credit metadata", async () => {
    for (const payment_status of ["paid", "unpaid", "no_payment_required"]) {
      for (const type of [
        "checkout.session.completed",
        "checkout.session.expired",
        "checkout.session.async_payment_failed",
      ]) {
        expect(
          await processStripeEvent(
            delivery(type, {
              id: "cs_subscription",
              mode: "subscription",
              payment_status,
              payment_intent: "pi_subscription",
              metadata: {
                organization_id: "org-1",
                credits: "99.00",
                type: "one_time",
              },
            }),
          ),
        ).toBe("retry");
      }
    }
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
  });

  test("preserves unrelated invoice acknowledgements", async () => {
    expect(
      await processStripeEvent(
        delivery("invoice.paid", {
          id: "in_manual",
          subscription: null,
          parent: null,
          billing_reason: "manual",
        }),
      ),
    ).toBe("ack");
  });
});

test("the real queue retains the full recurring delivery in DLQ after its retry budget", async () => {
  queueLists.clear();
  const input = delivery("invoice.paid", {
    id: "in_retained",
    subscription: "sub_first",
    amount_paid: 9900,
    lines: {
      data: [{ id: "il_retained", description: "complete provider context" }],
    },
  });
  await enqueue("stripe-events", input.body);
  const stats = await drain("stripe-events", processStripeEvent, {
    max: 5,
    maxAttempts: 5,
  });
  expect(stats).toEqual({
    attempted: 5,
    acked: 0,
    retried: 4,
    dlqed: 1,
    failed: 0,
  });
  expect(queueLists.get("stripe-events")).toEqual([]);
  const retained = queueLists.get("stripe-events:dlq");
  expect(retained).toHaveLength(1);
  if (!retained?.[0]) throw new Error("Recurring event was not retained");
  expect(JSON.parse(retained[0])).toMatchObject({
    body: input.body,
    attempts: 5,
  });
  expect(addCredits).not.toHaveBeenCalled();
});

test("retains invoice refunds and disputes without touching purchased-credit reversals", async () => {
  expect(
    await processStripeEvent(
      delivery("charge.refunded", {
        id: "ch_invoice",
        invoice: "in_recurring",
        payment_intent: "pi_invoice",
        amount_refunded: 9900,
      }),
    ),
  ).toBe("retry");
  retrieveCharge.mockResolvedValue({
    id: "ch_invoice",
    invoice: "in_recurring",
  });
  for (const type of [
    "charge.dispute.funds_withdrawn",
    "charge.dispute.funds_reinstated",
  ]) {
    expect(
      await processStripeEvent(
        delivery(type, {
          id: "dp_invoice",
          charge: "ch_invoice",
          payment_intent: "pi_invoice",
          amount: 9900,
        }),
      ),
    ).toBe("retry");
  }
  expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
  expect(clawbackCredits).not.toHaveBeenCalled();
  expect(refundCredits).not.toHaveBeenCalled();
});

test("provider classification failures bypass the legacy permanent-message classifier", async () => {
  for (const message of [
    "not found",
    "Invalid response",
    "already processed",
  ]) {
    retrieveCharge.mockRejectedValueOnce(new Error(message));
    expect(
      await processStripeEvent(
        delivery("charge.dispute.funds_withdrawn", {
          id: "dp_retry",
          charge: "ch_retry",
        }),
      ),
    ).toBe("retry");
  }
  expect(clawbackCredits).not.toHaveBeenCalled();
});

test("non-recurring invoice-backed purchases still settle through the legacy one-time path", async () => {
  expect(
    await processStripeEvent(
      delivery("payment_intent.succeeded", {
        id: "pi_manual_invoice",
        amount: 1000,
        amount_received: 1000,
        currency: "usd",
        metadata: {
          organization_id: "org-1",
          credits: "10.00",
          type: "one_time",
        },
        invoice: { id: "in_manual" },
      }),
    ),
  ).toBe("ack");
  expect(addCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      stripePaymentIntentId: "pi_manual_invoice",
      amount: 10,
    }),
  );
  expect(createInvoice).toHaveBeenCalledWith(
    expect.objectContaining({ stripe_invoice_id: "in_manual" }),
  );
});

test("retains Basil payment and refund deliveries without an invoice field", async () => {
  for (const type of [
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge.refunded",
  ]) {
    const input = delivery(type, {
      id: type.startsWith("payment_intent.") ? "pi_basil" : "ch_basil",
      object: type.startsWith("payment_intent.") ? "payment_intent" : "charge",
      amount: 9900,
      amount_received: 9900,
      amount_refunded: 9900,
      currency: "usd",
      customer: "cus_1",
      payment_intent: "pi_basil",
      metadata: { organization_id: "org-1", credits: "99", type: "one_time" },
    });
    input.body.event.api_version = "2025-03-31.basil";
    expect(await processStripeEvent(input)).toBe("retry");
  }
  expect(addCredits).not.toHaveBeenCalled();
  expect(clawbackCredits).not.toHaveBeenCalled();
  expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
  expect(failChargeAndEnqueue).not.toHaveBeenCalled();
});

test("retains missing or undefined linkage even on an Acacia delivery", async () => {
  for (const linkage of [{}, { invoice: undefined }]) {
    expect(
      await processStripeEvent(
        delivery("payment_intent.succeeded", {
          id: "pi_ambiguous",
          amount: 1000,
          amount_received: 1000,
          currency: "usd",
          metadata: {
            organization_id: "org-1",
            credits: "10",
            type: "one_time",
          },
          ...linkage,
        }),
      ),
    ).toBe("retry");
  }
  expect(addCredits).not.toHaveBeenCalled();
  expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
});

test("retains disputes with expanded charges whose invoice linkage is absent", async () => {
  for (const type of [
    "charge.dispute.funds_withdrawn",
    "charge.dispute.funds_reinstated",
  ]) {
    const input = delivery(type, {
      id: "dp_basil",
      amount: 9900,
      payment_intent: "pi_basil",
      charge: { id: "ch_basil", object: "charge", payment_intent: "pi_basil" },
    });
    input.body.event.api_version = "2025-03-31.basil";
    expect(await processStripeEvent(input)).toBe("retry");
  }
  expect(retrieveCharge).not.toHaveBeenCalled();
  expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
  expect(clawbackCredits).not.toHaveBeenCalled();
  expect(refundCredits).not.toHaveBeenCalled();
});
