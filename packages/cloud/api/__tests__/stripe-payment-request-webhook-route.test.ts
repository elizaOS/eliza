/** Pins persistence-before-dedupe for unified Stripe payment requests. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { PaymentCallbackEvent } from "@/lib/services/payment-callback-bus";
import { paymentCallbackBus } from "@/lib/services/payment-callback-bus";
import * as loggerActual from "@/lib/utils/logger";

let eventId = "evt-stripe";
const parseWebhook = mock(async () => ({
  paymentRequestId: "pr-stripe",
  status: "settled" as const,
  txRef: "pi-stripe",
  proof: { stripe_event_id: eventId },
}));
const markSettled = mock(async () => ({ id: "pr-stripe" }));
const markFailed = mock(async () => ({ id: "pr-stripe" }));

mock.module("@/lib/services/payment-adapters/stripe", () => ({
  stripePaymentAdapter: { parseWebhook },
}));
mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({ markSettled, markFailed }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: "aggressive" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const { default: app } = await import("../v1/stripe/webhook/route");
let busEvents: PaymentCallbackEvent[] = [];
let unsubscribe: (() => void) | undefined;

function request() {
  return new Request("https://api.example.test/", {
    method: "POST",
    headers: { "stripe-signature": "signed-fixture" },
    body: "signed-body",
  });
}

describe("Stripe payment_requests webhook route", () => {
  beforeAll(() => {
    unsubscribe = paymentCallbackBus.subscribe({}, (event) => {
      if (event.provider === "stripe") busEvents.push(event);
    });
  });

  afterAll(() => unsubscribe?.());

  beforeEach(() => {
    eventId = `evt-stripe-${crypto.randomUUID()}`;
    busEvents = [];
    parseWebhook.mockClear();
    markSettled.mockReset();
    markSettled.mockResolvedValue({ id: "pr-stripe" });
    markFailed.mockClear();
  });

  test("a rejected late settlement returns 500 without poisoning dedupe or publishing", async () => {
    markSettled.mockRejectedValueOnce(new Error("expired at deadline"));

    const response = await app.fetch(request(), {});

    expect(response.status).toBe(500);
    expect(busEvents).toHaveLength(0);
  });

  test("a retry persists before recording and publishes once", async () => {
    const response = await app.fetch(request(), {});

    expect(response.status).toBe(200);
    expect(markSettled).toHaveBeenCalledTimes(1);
    expect(busEvents).toHaveLength(1);
    expect(busEvents[0]).toMatchObject({
      name: "PaymentSettled",
      provider: "stripe",
      providerEventId: eventId,
    });
  });

  test("a duplicate callback replays idempotent persistence but not publication", async () => {
    expect((await app.fetch(request(), {})).status).toBe(200);
    const duplicate = await app.fetch(request(), {});

    expect(duplicate.status).toBe(200);
    expect(markSettled).toHaveBeenCalledTimes(2);
    expect(busEvents).toHaveLength(1);
  });
});
