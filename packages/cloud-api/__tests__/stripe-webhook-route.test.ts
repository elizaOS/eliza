import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
// Capture audit emits through the REAL singleton (setAuditDispatcher) rather
// than mock.module'ing getAuditDispatcher — a module mock here is process-global
// and would pin getAuditDispatcher to this stub for every later suite (e.g. the
// SOC2 middleware tests' own dispatcher), so their sink would never see events.
import {
  initAuditDispatcher,
  setAuditDispatcher,
} from "@/api-app/services/audit-dispatcher-singleton";

const constructEventAsync = mock();
const emitAudit = mock(async () => undefined);
const queueMockGlobal = globalThis as typeof globalThis & {
  __cloudApiRedisQueueMock?: {
    drain: ReturnType<typeof mock>;
    enqueue: ReturnType<typeof mock>;
    queueLength: ReturnType<typeof mock>;
  };
};
if (!queueMockGlobal.__cloudApiRedisQueueMock) {
  queueMockGlobal.__cloudApiRedisQueueMock = {
    drain: mock(),
    enqueue: mock(async () => undefined),
    queueLength: mock(),
  };
}
const redisQueueMock = queueMockGlobal.__cloudApiRedisQueueMock;
const { enqueue } = redisQueueMock;
const tryCreate = mock(async () => ({ created: true }));

mock.module("@/db/repositories/webhook-events", () => ({
  webhookEventsRepository: {
    tryCreate,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    AGGRESSIVE: "aggressive",
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/queue/redis-queue", () => ({
  ...redisQueueMock,
}));

mock.module("@/lib/stripe", () => ({
  isStripeConfigured: () => true,
  requireStripe: () => ({
    webhooks: {
      constructEventAsync,
    },
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
  },
}));

const { default: app } = await import("../stripe/webhook/route");

const env = {
  STRIPE_WEBHOOK_SECRET: "whsec_test",
};

function stripeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://api.example.test/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const checkoutEvent = {
  id: "evt_checkout",
  type: "checkout.session.completed",
  created: 1770000000,
  data: {
    object: {
      id: "cs_test",
      payment_intent: "pi_checkout",
    },
  },
};

describe("Stripe webhook route", () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
    constructEventAsync.mockResolvedValue(checkoutEvent);
    emitAudit.mockClear();
    enqueue.mockClear();
    tryCreate.mockReset();
    tryCreate.mockResolvedValue({ created: true });
    // Install a capturing dispatcher through the real singleton.
    setAuditDispatcher({
      emit: emitAudit,
    } as unknown as Parameters<typeof setAuditDispatcher>[0]);
  });

  // Restore a real dispatcher so the captured stub does not leak into later
  // suites that read the singleton.
  afterAll(() => {
    setAuditDispatcher(initAuditDispatcher());
  });

  test("rejects requests without a Stripe signature before persistence or enqueue", async () => {
    const response = await app.fetch(stripeRequest({ id: "evt_missing" }), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "No signature provided",
    });
    expect(constructEventAsync).not.toHaveBeenCalled();
    expect(tryCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("emits a denied audit event when signature verification fails", async () => {
    constructEventAsync.mockRejectedValueOnce(
      new Error("No signatures found matching the expected signature"),
    );

    const response = await app.fetch(
      stripeRequest(
        { id: "evt_bad" },
        {
          "stripe-signature": "bad-signature",
          "x-forwarded-for": "198.51.100.9, 10.0.0.1",
        },
      ),
      env,
    );

    expect(response.status).toBe(400);
    expect(emitAudit).toHaveBeenCalledWith({
      actor: { type: "system", id: "stripe-webhook" },
      action: "payment.charge",
      result: "denied",
      resource: { type: "webhook", id: "stripe" },
      ip: "198.51.100.9",
      request_id: undefined,
      metadata: { provider: "stripe", reason: "invalid_signature" },
    });
    expect(tryCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("dedupes persisted webhook events before enqueueing", async () => {
    tryCreate.mockResolvedValueOnce({ created: false });

    const response = await app.fetch(
      stripeRequest(checkoutEvent, { "stripe-signature": "valid-signature" }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      duplicate: true,
    });
    expect(tryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "evt_checkout",
        provider: "stripe",
        event_type: "checkout.session.completed",
        source_ip: "unknown",
        event_timestamp: new Date(1770000000 * 1000),
      }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("enqueues verified events with queue key and extracted payment intent", async () => {
    const paymentIntentEvent = {
      id: "evt_pi",
      type: "payment_intent.succeeded",
      created: 1770001234,
      data: {
        object: {
          id: "pi_direct",
        },
      },
    };
    constructEventAsync.mockResolvedValueOnce(paymentIntentEvent);

    const response = await app.fetch(
      stripeRequest(paymentIntentEvent, {
        "stripe-signature": "valid-signature",
        "x-real-ip": "203.0.113.7",
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      queued: true,
    });
    expect(tryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "evt_pi",
        provider: "stripe",
        event_type: "payment_intent.succeeded",
        source_ip: "203.0.113.7",
        event_timestamp: new Date(1770001234 * 1000),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      "stripe-events",
      expect.objectContaining({
        kind: "stripe.event",
        eventId: "evt_pi",
        eventType: "payment_intent.succeeded",
        event: paymentIntentEvent,
        paymentIntentId: "pi_direct",
      }),
    );
  });
});
