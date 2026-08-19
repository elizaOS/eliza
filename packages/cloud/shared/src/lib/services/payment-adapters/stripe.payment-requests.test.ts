/** Validates authoritative Stripe Checkout fields before unified credit settlement. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const constructEventAsync = mock();

mock.module("../../stripe", () => ({
  requireStripe: () => ({ webhooks: { constructEventAsync } }),
}));

const { createStripePaymentAdapter } = await import("./stripe");
const { IgnoredWebhookEvent } = await import("../payment-webhook-errors");
const adapter = createStripePaymentAdapter();

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  constructEventAsync.mockReset();
});

function checkoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_paid",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_paid",
        client_reference_id: "20000000-0000-4000-8000-000000000001",
        payment_intent: "pi_paid",
        amount_total: 2500,
        currency: "usd",
        payment_status: "paid",
        ...overrides,
      },
    },
  };
}

describe("Stripe payment request webhook parser", () => {
  test("returns provider identity and authoritative paid amount", async () => {
    constructEventAsync.mockResolvedValue(checkoutEvent());
    const parsed = await adapter.parseWebhook!({ rawBody: "{}", signature: "sig" });
    expect(parsed).toMatchObject({
      providerEventId: "evt_paid",
      paymentRequestId: "20000000-0000-4000-8000-000000000001",
      status: "settled",
      txRef: "pi_paid",
      amountCents: 2500,
      currency: "usd",
      proof: {
        stripe_session_id: "cs_paid",
        stripe_payment_intent_id: "pi_paid",
        stripe_payment_status: "paid",
      },
    });
  });

  test("preserves distinct Stripe event ids for the same paid session and intent", async () => {
    constructEventAsync
      .mockResolvedValueOnce(checkoutEvent())
      .mockResolvedValueOnce({ ...checkoutEvent(), id: "evt_paid_retry_object" });
    const first = await adapter.parseWebhook!({ rawBody: "first", signature: "sig" });
    const second = await adapter.parseWebhook!({ rawBody: "second", signature: "sig" });
    expect(first.txRef).toBe("pi_paid");
    expect(second).toMatchObject({ providerEventId: "evt_paid_retry_object", txRef: "pi_paid" });
  });

  test("does not fulfill a completed but unpaid Checkout session", async () => {
    constructEventAsync.mockResolvedValue(checkoutEvent({ payment_status: "unpaid" }));
    await expect(adapter.parseWebhook!({ rawBody: "{}", signature: "sig" })).rejects.toBeInstanceOf(
      IgnoredWebhookEvent,
    );
  });

  test("rejects missing amount, currency, or payment intent", async () => {
    for (const overrides of [
      { amount_total: null },
      { currency: null },
      { payment_intent: null },
    ]) {
      constructEventAsync.mockResolvedValueOnce(checkoutEvent(overrides));
      await expect(adapter.parseWebhook!({ rawBody: "{}", signature: "sig" })).rejects.toThrow();
    }
  });
});
