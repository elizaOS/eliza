/** Proves Stripe Checkout is bounded by the canonical request deadline. */
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { PaymentRequestRow } from "../payment-requests";
import { createStripePaymentAdapter, stripeCheckoutExpiresAtSeconds } from "./stripe";

afterEach(() => setSystemTime());

function stripeRequest(expiresAt: Date): PaymentRequestRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    organizationId: "00000000-0000-0000-0000-000000000002",
    agentId: null,
    appId: null,
    provider: "stripe",
    amountCents: 500,
    currency: "USD",
    reason: "Synthetic payment",
    paymentContext: { kind: "any_payer" },
    payerIdentityId: null,
    payerUserId: null,
    payerOrganizationId: null,
    status: "pending",
    hostedUrl: null,
    callbackUrl: null,
    callbackSecret: null,
    providerIntent: {},
    settledAt: null,
    settlementTxRef: null,
    settlementProof: null,
    expiresAt,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    metadata: {
      success_url: "https://merchant.example.test/success",
      cancel_url: "https://merchant.example.test/cancel",
    },
  };
}

describe("Stripe payment request deadline", () => {
  test("passes the request deadline to Checkout without extending it", async () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    const deadline = new Date("2026-08-13T00:31:00.900Z");
    setSystemTime(now);
    const create = mock(async () => ({
      id: "cs_test",
      url: "https://checkout.stripe.example.test/session",
      payment_intent: "pi_test",
    }));
    const adapter = createStripePaymentAdapter(
      () => ({ checkout: { sessions: { create } } }) as never,
    );

    await adapter.createIntent({ request: stripeRequest(deadline) });

    const params = create.mock.calls[0]?.[0] as { expires_at: number };
    expect(params.expires_at).toBe(Math.floor(deadline.getTime() / 1000));
    expect(params.expires_at * 1000).toBeLessThanOrEqual(deadline.getTime());
  });

  test("rejects provider lifetimes outside Stripe's supported window", () => {
    const now = Date.parse("2026-08-13T00:00:00.000Z");
    expect(() => stripeCheckoutExpiresAtSeconds(new Date(now + 30 * 60_000 - 1), now)).toThrow(
      /at least 30 minutes/,
    );
    expect(() =>
      stripeCheckoutExpiresAtSeconds(new Date(now + 24 * 60 * 60_000 + 1000), now),
    ).toThrow(/more than 24 hours/);
  });
});
