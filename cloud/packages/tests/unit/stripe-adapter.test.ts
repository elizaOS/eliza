import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PaymentRequestRow } from "@/lib/services/payment-requests";

const PAYMENT_REQUEST_ID = "pr_stripe_adapter_test";
const SESSION_ID = "cs_test_123";
const PAYMENT_INTENT_ID = "pi_test_123";

interface StripeMockState {
  sessionsCreate: Array<Record<string, unknown>>;
  constructEventAsync: Array<{ rawBody: string; signature: string; secret: string }>;
  constructEventResult: unknown;
  constructEventError: Error | null;
  listPaymentMethods: string[];
}

function buildRequest(overrides: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
  const now = new Date();
  return {
    id: PAYMENT_REQUEST_ID,
    organizationId: "org_1",
    agentId: null,
    provider: "stripe",
    status: "pending",
    amountCents: 2500,
    currency: "USD",
    reason: "Coffee subscription",
    paymentContext: { kind: "any_payer" },
    payerUserId: "user_1",
    payerOrganizationId: "org_1",
    payerIdentityId: null,
    appId: "app_1",
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
    metadata: { product_name: "Coffee" },
    hostedUrl: null,
    callbackUrl: null,
    callbackSecret: null,
    providerIntent: {},
    settledAt: null,
    settlementTxRef: null,
    settlementProof: null,
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function installAdapterMocks(state: StripeMockState): void {
  mock.module("@/lib/runtime/cloud-bindings", () => ({
    getCloudAwareEnv: () => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" }),
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }));

  mock.module("@/lib/stripe", () => ({
    requireStripe: () => ({
      checkout: {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            state.sessionsCreate.push(params);
            return {
              id: SESSION_ID,
              url: `https://checkout.stripe.com/c/pay/${SESSION_ID}`,
              payment_intent: PAYMENT_INTENT_ID,
            };
          },
        },
      },
      webhooks: {
        constructEventAsync: async (rawBody: string, signature: string, secret: string) => {
          state.constructEventAsync.push({ rawBody, signature, secret });
          if (state.constructEventError) throw state.constructEventError;
          return state.constructEventResult;
        },
      },
    }),
  }));

  mock.module("@/lib/services/payment-methods", () => ({
    paymentMethodsService: {
      listPaymentMethods: async (orgId: string) => {
        state.listPaymentMethods.push(orgId);
        return [];
      },
    },
  }));
}

async function loadAdapter() {
  return await import(
    new URL(
      `../../../packages/lib/services/payment-adapters/stripe.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

function freshState(): StripeMockState {
  return {
    sessionsCreate: [],
    constructEventAsync: [],
    constructEventResult: null,
    constructEventError: null,
    listPaymentMethods: [],
  };
}

describe("stripe payment adapter", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("createIntent opens a Checkout session and returns the hosted URL", async () => {
    const state = freshState();
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();

    const result = await stripePaymentAdapter.createIntent({ request: buildRequest() });

    expect(result.hostedUrl).toBe(`https://checkout.stripe.com/c/pay/${SESSION_ID}`);
    expect(result.providerIntent).toMatchObject({
      stripe_session_id: SESSION_ID,
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
    });

    const params = state.sessionsCreate[0] as {
      mode: string;
      client_reference_id: string;
      success_url: string;
      cancel_url: string;
      line_items: Array<{ price_data: { currency: string; unit_amount: number } }>;
      metadata: Record<string, string>;
      payment_intent_data: { metadata: Record<string, string> };
    };
    expect(params.mode).toBe("payment");
    expect(params.client_reference_id).toBe(PAYMENT_REQUEST_ID);
    expect(params.success_url).toBe("https://example.com/success");
    expect(params.cancel_url).toBe("https://example.com/cancel");
    expect(params.line_items[0]?.price_data.currency).toBe("usd");
    expect(params.line_items[0]?.price_data.unit_amount).toBe(2500);
    expect(params.metadata.payment_request_id).toBe(PAYMENT_REQUEST_ID);
    expect(params.payment_intent_data.metadata.payment_request_id).toBe(PAYMENT_REQUEST_ID);
  });

  test("createIntent rejects requests missing redirect URLs", async () => {
    const state = freshState();
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();

    await expect(
      stripePaymentAdapter.createIntent({
        request: buildRequest({ successUrl: null, cancelUrl: null, metadata: {} }),
      }),
    ).rejects.toThrow(/success_url and cancel_url/);
  });

  test("createIntent rejects non-stripe requests", async () => {
    const state = freshState();
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();

    await expect(
      stripePaymentAdapter.createIntent({ request: buildRequest({ provider: "oxapay" }) }),
    ).rejects.toThrow(/non-stripe/);
  });

  test("parseWebhook returns settled for checkout.session.completed", async () => {
    const state = freshState();
    state.constructEventResult = {
      id: "evt_settled_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: SESSION_ID,
          client_reference_id: PAYMENT_REQUEST_ID,
          payment_intent: PAYMENT_INTENT_ID,
          amount_total: 2500,
          metadata: {},
        },
      },
    };
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();

    const parsed = await stripePaymentAdapter.parseWebhook!({
      rawBody: "raw",
      signature: "sig",
    });

    expect(parsed.status).toBe("settled");
    expect(parsed.paymentRequestId).toBe(PAYMENT_REQUEST_ID);
    expect(parsed.txRef).toBe(PAYMENT_INTENT_ID);
    expect(parsed.proof.stripe_event_id).toBe("evt_settled_1");
    expect(state.constructEventAsync[0]?.secret).toBe("whsec_test");
  });

  test("parseWebhook returns failed for payment_intent.payment_failed", async () => {
    const state = freshState();
    state.constructEventResult = {
      id: "evt_failed_1",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: PAYMENT_INTENT_ID,
          metadata: { payment_request_id: PAYMENT_REQUEST_ID },
          last_payment_error: { code: "card_declined", message: "Card declined" },
        },
      },
    };
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();

    const parsed = await stripePaymentAdapter.parseWebhook!({
      rawBody: "raw",
      signature: "sig",
    });

    expect(parsed.status).toBe("failed");
    expect(parsed.paymentRequestId).toBe(PAYMENT_REQUEST_ID);
    expect(parsed.txRef).toBe(PAYMENT_INTENT_ID);
    expect(parsed.proof.stripe_failure_code).toBe("card_declined");
  });

  test("parseWebhook throws IgnoredWebhookEvent for unhandled event types", async () => {
    const state = freshState();
    state.constructEventResult = {
      id: "evt_other_1",
      type: "customer.created",
      data: { object: {} },
    };
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();
    const { IgnoredWebhookEvent } = await import("@/lib/services/payment-webhook-errors");

    await expect(
      stripePaymentAdapter.parseWebhook!({ rawBody: "raw", signature: "sig" }),
    ).rejects.toBeInstanceOf(IgnoredWebhookEvent);
  });

  test("parseWebhook surfaces signature verification failures", async () => {
    const state = freshState();
    state.constructEventError = new Error("No signatures found matching the expected signature");
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();

    await expect(
      stripePaymentAdapter.parseWebhook!({ rawBody: "raw", signature: "bad" }),
    ).rejects.toThrow(/No signatures found/);
  });

  test("parseWebhook rejects when stripe-signature header is missing", async () => {
    const state = freshState();
    installAdapterMocks(state);
    const { stripePaymentAdapter } = await loadAdapter();

    await expect(
      stripePaymentAdapter.parseWebhook!({ rawBody: "raw", signature: null }),
    ).rejects.toThrow(/missing stripe-signature/);
  });
});
