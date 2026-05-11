import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const PAYMENT_REQUEST_ID = "pr_webhook_test";
const PAYMENT_INTENT_ID = "pi_webhook_test";
const STRIPE_EVENT_ID = "evt_webhook_test";

interface ParseResult {
  paymentRequestId: string;
  status: "settled" | "failed";
  txRef?: string;
  proof: Record<string, unknown>;
}

class IgnoredWebhookEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IgnoredWebhookEvent";
  }
}

interface Harness {
  parseResult: ParseResult | null;
  parseError: Error | null;
  parseCalls: Array<{ rawBody: string; signature: string | null }>;
  publishCalls: Array<Record<string, unknown>>;
  recordedEventIds: Set<string>;
  duplicateEventIds: Set<string>;
}

function installMocks(harness: Harness): void {
  mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
    RateLimitPresets: { STANDARD: "standard", STRICT: "strict", AGGRESSIVE: "aggressive" },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }));

  mock.module("@/lib/services/payment-callback-bus", () => ({
    paymentCallbackBus: {
      publish: (event: Record<string, unknown>) => {
        harness.publishCalls.push(event);
      },
      recordProviderEvent: (provider: string, providerEventId: string) => {
        const key = `${provider}:${providerEventId}`;
        if (harness.duplicateEventIds.has(key)) return false;
        if (harness.recordedEventIds.has(key)) return false;
        harness.recordedEventIds.add(key);
        return true;
      },
    },
  }));

  mock.module("@/lib/services/payment-requests", () => ({
    IgnoredWebhookEvent,
  }));

  mock.module("@/lib/services/payment-adapters/stripe", () => ({
    stripePaymentAdapter: {
      provider: "stripe" as const,
      createIntent: async () => {
        throw new Error("createIntent should not be called from the webhook route");
      },
      parseWebhook: async ({ rawBody, signature }: { rawBody: string; signature: string | null }) => {
        harness.parseCalls.push({ rawBody, signature });
        if (harness.parseError) throw harness.parseError;
        if (!harness.parseResult) throw new Error("no parseResult configured");
        return harness.parseResult;
      },
    },
  }));
}

async function loadRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/stripe/webhook/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/stripe/webhook", mod.default as Hono);
  return parent;
}

function freshHarness(): Harness {
  return {
    parseResult: null,
    parseError: null,
    parseCalls: [],
    publishCalls: [],
    recordedEventIds: new Set(),
    duplicateEventIds: new Set(),
  };
}

describe("POST /api/v1/stripe/webhook", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("publishes PaymentSettled on a settled event", async () => {
    const harness = freshHarness();
    harness.parseResult = {
      paymentRequestId: PAYMENT_REQUEST_ID,
      status: "settled",
      txRef: PAYMENT_INTENT_ID,
      proof: { stripe_event_id: STRIPE_EVENT_ID },
    };
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig_v1" },
      body: "raw",
    });

    expect(response.status).toBe(200);
    expect(harness.publishCalls.length).toBe(1);
    expect(harness.publishCalls[0]).toMatchObject({
      name: "PaymentSettled",
      paymentRequestId: PAYMENT_REQUEST_ID,
      provider: "stripe",
      txRef: PAYMENT_INTENT_ID,
      providerEventId: STRIPE_EVENT_ID,
    });
  });

  test("publishes PaymentFailed on a failed event", async () => {
    const harness = freshHarness();
    harness.parseResult = {
      paymentRequestId: PAYMENT_REQUEST_ID,
      status: "failed",
      txRef: PAYMENT_INTENT_ID,
      proof: { stripe_event_id: "evt_failed_1" },
    };
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig_v1" },
      body: "raw",
    });

    expect(response.status).toBe(200);
    expect(harness.publishCalls[0]?.name).toBe("PaymentFailed");
  });

  test("returns 400 when the stripe-signature header is missing", async () => {
    const harness = freshHarness();
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/webhook", {
      method: "POST",
      body: "raw",
    });

    expect(response.status).toBe(400);
    expect(harness.parseCalls.length).toBe(0);
    expect(harness.publishCalls.length).toBe(0);
  });

  test("returns 400 on signature verification failure", async () => {
    const harness = freshHarness();
    harness.parseError = new Error("No signatures found matching the expected signature");
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig_bad" },
      body: "raw",
    });

    expect(response.status).toBe(400);
    expect(harness.publishCalls.length).toBe(0);
  });

  test("returns 200 ignored for unhandled event types", async () => {
    const harness = freshHarness();
    harness.parseError = new IgnoredWebhookEvent("customer.created not handled");
    installMocks(harness);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig_v1" },
      body: "raw",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ignored?: boolean };
    expect(body.ignored).toBe(true);
    expect(harness.publishCalls.length).toBe(0);
  });

  test("idempotent: replay of same event id does not republish", async () => {
    const harness = freshHarness();
    harness.parseResult = {
      paymentRequestId: PAYMENT_REQUEST_ID,
      status: "settled",
      txRef: PAYMENT_INTENT_ID,
      proof: { stripe_event_id: STRIPE_EVENT_ID },
    };
    installMocks(harness);
    const route = await loadRoute();

    const first = await route.request("https://api.test/api/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig_v1" },
      body: "raw",
    });
    expect(first.status).toBe(200);
    expect(harness.publishCalls.length).toBe(1);

    const second = await route.request("https://api.test/api/v1/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig_v1" },
      body: "raw",
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { duplicate?: boolean };
    expect(body.duplicate).toBe(true);
    expect(harness.publishCalls.length).toBe(1);
  });
});
