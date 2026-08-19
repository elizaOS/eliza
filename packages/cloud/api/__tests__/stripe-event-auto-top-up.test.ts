/**
 * Verifies durable auto-top-up Stripe reconciliation and idempotent webhook
 * projections through a deterministic queue-consumer seam with no live calls.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type Stripe from "stripe";
import type { StripeEventMessage } from "../../shared/src/types/stripe-queue-message";

interface ReconciliationResult {
  disposition: "settled" | "validated_deferred" | "rejected";
  result: {
    organizationId: string;
    success: boolean;
    amount?: number;
    attemptId?: string;
    status: string;
    recovered: boolean;
    error?: string;
  };
}

const reconcileSucceededPaymentIntent = mock(
  async (): Promise<ReconciliationResult> => ({
    disposition: "settled",
    result: {
      organizationId: "org-auto-top-up",
      success: true,
      amount: 10,
      attemptId: "attempt-1",
      status: "credited",
      recovered: true,
    },
  }),
);
const getTransactionByStripePaymentIntent = mock(
  async (): Promise<{ id: string } | null> => null,
);
const addCredits = mock(async () => ({ newBalance: 10 }));
const addEarnings = mock(async () => ({ success: true }));
const getByStripeInvoiceId = mock(async () => null);
const createInvoice = mock(async () => undefined);
const logPaymentReceived = mock(async () => undefined);

mock.module("@/db/helpers", () => ({ dbRead: {} }));
mock.module("@/db/repositories/organizations", () => ({
  organizationsRepository: {
    findById: mock(async () => ({ name: "Auto Top-up Org" })),
  },
}));
mock.module("@/db/repositories/users", () => ({ usersRepository: {} }));
mock.module("@/db/schemas/agent-sandboxes", () => ({ agentSandboxes: {} }));
mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: mock(async () => Response.json({ ok: true })),
}));
mock.module("@/lib/services/app-charge-callbacks", () => ({
  appChargeCallbacksService: {},
}));
mock.module("@/lib/services/app-charge-settlement", () => ({
  appChargeSettlementService: {},
}));
mock.module("@/lib/services/app-credits", () => ({ appCreditsService: {} }));
mock.module("@/lib/services/auto-top-up", () => ({
  autoTopUpService: { reconcileSucceededPaymentIntent },
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: { getTransactionByStripePaymentIntent, addCredits },
}));
mock.module("@/lib/services/discord", () => ({
  discordService: { logPaymentReceived },
}));
mock.module("@/lib/services/invoices", () => ({
  invoicesService: { getByStripeInvoiceId, create: createInvoice },
}));
mock.module("@/lib/services/org-rate-limits", () => ({
  invalidateOrgTierCache: mock(async () => undefined),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {},
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: { addEarnings },
}));
mock.module("@/lib/services/referrals", () => ({ referralsService: {} }));
mock.module("@/lib/services/stripe-checkout-orders", () => ({
  stripeCheckoutOrdersService: {},
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

function paymentIntentDelivery(params?: {
  id?: string;
  type?: string;
  metadata?: Record<string, string>;
  attemptId?: string | null;
}) {
  const id = params?.id ?? "pi_auto_top_up";
  const paymentIntent = {
    id,
    object: "payment_intent",
    amount: 1_100,
    amount_capturable: 0,
    amount_received: 1_100,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: "automatic",
    client_secret: null,
    confirmation_method: "automatic",
    created: Math.floor(Date.now() / 1000),
    currency: "usd",
    customer: "cus_auto_top_up",
    customer_account: null,
    description: null,
    excluded_payment_method_types: null,
    last_payment_error: null,
    latest_charge: null,
    livemode: true,
    managed_payments: null,
    metadata: {
      organization_id: "org-auto-top-up",
      credits: "10.00",
      type: params?.type ?? "auto_top_up",
      ...(params?.attemptId === null
        ? {}
        : {
            auto_top_up_attempt_id: params?.attemptId ?? "attempt-1",
          }),
      total_charged: "11.00",
      ...params?.metadata,
    },
    next_action: null,
    on_behalf_of: null,
    payment_method: "pm_auto_top_up",
    payment_method_configuration_details: null,
    payment_method_options: null,
    payment_method_types: ["card"],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    source: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: "succeeded",
    transfer_group: null,
  } satisfies Stripe.PaymentIntent;
  const event = {
    id: `evt_${id}`,
    object: "event",
    api_version: "2024-11-20.acacia",
    created: paymentIntent.created,
    data: { object: paymentIntent },
    livemode: true,
    pending_webhooks: 0,
    request: null,
    type: "payment_intent.succeeded",
  } satisfies Stripe.Event;
  const body: StripeEventMessage = {
    kind: "stripe.event",
    eventId: event.id,
    eventType: event.type,
    paymentIntentId: id,
    receivedAt: Date.now(),
    event,
  };
  return {
    attempts: 1,
    body,
  } satisfies Parameters<typeof processStripeEvent>[0];
}

beforeEach(() => {
  reconcileSucceededPaymentIntent.mockClear();
  reconcileSucceededPaymentIntent.mockImplementation(async () => ({
    disposition: "settled",
    result: {
      organizationId: "org-auto-top-up",
      success: true,
      amount: 10,
      attemptId: "attempt-1",
      status: "credited",
      recovered: true,
    },
  }));
  getTransactionByStripePaymentIntent.mockClear();
  getTransactionByStripePaymentIntent.mockImplementation(async () => null);
  addCredits.mockClear();
  addEarnings.mockClear();
  addEarnings.mockImplementation(async () => ({ success: true }));
  getByStripeInvoiceId.mockClear();
  getByStripeInvoiceId.mockImplementation(async () => null);
  createInvoice.mockClear();
  createInvoice.mockImplementation(async () => undefined);
  logPaymentReceived.mockClear();
});

describe("Stripe queue durable auto-top-up reconciliation", () => {
  test("settles attempt metadata before projections and never uses generic credits", async () => {
    const delivery = paymentIntentDelivery();

    expect(await processStripeEvent(delivery)).toBe("ack");

    expect(reconcileSucceededPaymentIntent).toHaveBeenCalledTimes(1);
    expect(reconcileSucceededPaymentIntent).toHaveBeenCalledWith(
      delivery.body.event.data.object,
    );
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(
      reconcileSucceededPaymentIntent.mock.invocationCallOrder[0],
    ).toBeLessThan(createInvoice.mock.invocationCallOrder[0] as number);
  });

  test("retries reconciliation failures without any financial projection", async () => {
    reconcileSucceededPaymentIntent.mockImplementationOnce(async () => {
      throw new Error("Auto top-up attempt not found");
    });

    expect(await processStripeEvent(paymentIntentDelivery())).toBe("retry");

    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
  });

  test("retries validated deferred receipts without any financial projection", async () => {
    reconcileSucceededPaymentIntent.mockImplementationOnce(async () => ({
      disposition: "validated_deferred",
      result: {
        organizationId: "org-auto-top-up",
        success: false,
        amount: 10,
        attemptId: "attempt-1",
        status: "payment_pending",
        recovered: true,
      },
    }));
    const delivery = paymentIntentDelivery({
      id: "pi_deferred",
      metadata: {
        affiliate_fee_amount: "0.50",
        affiliate_owner_id: "affiliate-owner",
        affiliate_code_id: "affiliate-code",
      },
    });

    expect(await processStripeEvent(delivery)).toBe("retry");

    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
    expect(getByStripeInvoiceId).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(logPaymentReceived).not.toHaveBeenCalled();
  });

  test("accepts a valid zero affiliate fee while keeping the invoice projection", async () => {
    const delivery = paymentIntentDelivery({
      id: "pi_zero_affiliate_fee",
      metadata: {
        affiliate_fee_amount: "0.00",
        affiliate_owner_id: "affiliate-owner",
        affiliate_code_id: "affiliate-code",
      },
    });

    expect(await processStripeEvent(delivery)).toBe("ack");

    expect(addEarnings).not.toHaveBeenCalled();
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id: "pi_zero_affiliate_fee",
      }),
    );
  });

  test("rejected durable receipts have no credit, payout, or invoice side effect", async () => {
    reconcileSucceededPaymentIntent.mockImplementationOnce(async () => ({
      disposition: "rejected",
      result: {
        organizationId: "org-auto-top-up",
        success: false,
        amount: 10,
        attemptId: "attempt-1",
        status: "manual_review",
        recovered: true,
        error: "Provider receipt mismatch",
      },
    }));

    expect(await processStripeEvent(paymentIntentDelivery())).toBe("ack");

    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
    expect(getByStripeInvoiceId).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(logPaymentReceived).not.toHaveBeenCalled();
  });

  test("legacy auto top-ups without an attempt id retain generic crediting", async () => {
    const delivery = paymentIntentDelivery({
      id: "pi_legacy",
      attemptId: null,
    });

    expect(await processStripeEvent(delivery)).toBe("ack");

    expect(reconcileSucceededPaymentIntent).not.toHaveBeenCalled();
    expect(addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-auto-top-up",
        amount: 10,
        stripePaymentIntentId: "pi_legacy",
      }),
    );
  });

  test("routes a reserved attempt marker with a malformed type through durable rejection", async () => {
    reconcileSucceededPaymentIntent.mockImplementationOnce(async () => ({
      disposition: "rejected",
      result: {
        organizationId: "org-auto-top-up",
        success: false,
        attemptId: "attempt-1",
        status: "manual_review",
        recovered: true,
        error: "Provider receipt mismatch",
      },
    }));
    const delivery = paymentIntentDelivery({
      id: "pi_one_time",
      type: "one_time",
    });

    expect(await processStripeEvent(delivery)).toBe("ack");

    expect(reconcileSucceededPaymentIntent).toHaveBeenCalledWith(
      delivery.body.event.data.object,
    );
    expect(getTransactionByStripePaymentIntent).not.toHaveBeenCalled();
    expect(addCredits).not.toHaveBeenCalled();
    expect(addEarnings).not.toHaveBeenCalled();
    expect(getByStripeInvoiceId).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    expect(logPaymentReceived).not.toHaveBeenCalled();
  });

  test("a synchronous settlement winner still gets its missing invoice", async () => {
    getTransactionByStripePaymentIntent.mockImplementationOnce(async () => ({
      id: "already-credited-by-sync-path",
    }));

    expect(
      await processStripeEvent(paymentIntentDelivery({ id: "pi_sync_winner" })),
    ).toBe("ack");

    expect(addCredits).not.toHaveBeenCalled();
    expect(logPaymentReceived).not.toHaveBeenCalled();
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_payment_intent_id: "pi_sync_winner" }),
    );
  });

  test("retries a failed durable invoice projection after settlement", async () => {
    createInvoice.mockImplementationOnce(async () => {
      throw new Error("invoice database unavailable");
    });

    expect(
      await processStripeEvent(
        paymentIntentDelivery({ id: "pi_invoice_retry" }),
      ),
    ).toBe("retry");

    expect(reconcileSucceededPaymentIntent).toHaveBeenCalledTimes(1);
    expect(addCredits).not.toHaveBeenCalled();
    expect(createInvoice).toHaveBeenCalledTimes(1);
  });
});
