// Exercises cloud API tests stripe queue route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
// Spread the real module into the partial mock below — `mock.module` is
// process-global, so dropping `isInvoiceExpanded` (and the other real exports)
// breaks every later importer of this module in the same test run.
import * as stripeEventActual from "@/api-queue/stripe-event";

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
const { drain, queueLength } = redisQueueMock;
const processStripeEvent = mock(async () => undefined);

mock.module("@/api-queue/stripe-event", () => ({
  ...stripeEventActual,
  processStripeEvent,
}));

mock.module("@/lib/queue/redis-queue", () => ({
  ...redisQueueMock,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(),
    info: mock(),
  },
}));

const { default: app } = await import("../cron/process-stripe-queue/route");

const env = {
  CRON_SECRET: "cron-secret",
};

function post(headers: Record<string, string> = {}): Request {
  return new Request("https://api.example.test/", {
    method: "POST",
    headers,
  });
}

describe("Stripe queue cron route", () => {
  beforeEach(() => {
    drain.mockReset();
    queueLength.mockReset();
    processStripeEvent.mockClear();
    queueLength.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    drain.mockImplementation(async (_key, handler) => {
      await handler({
        body: { kind: "stripe.event", eventId: "evt_1" },
        attempts: 2,
      });
      return { processed: 1, failed: 0, retried: 0 };
    });
  });

  test("rejects requests without the cron secret before touching Redis", async () => {
    const response = await app.fetch(post(), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "authentication_required",
      error: "Invalid cron secret",
    });
    expect(queueLength).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  test("drains the stripe-events queue with the bounded retry contract", async () => {
    const response = await app.fetch(
      post({ authorization: "Bearer cron-secret" }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      queue: "stripe-events",
      before: 3,
      after: 1,
      processed: 1,
      failed: 0,
      retried: 0,
    });
    expect(queueLength).toHaveBeenCalledTimes(2);
    expect(queueLength).toHaveBeenNthCalledWith(1, "stripe-events");
    expect(queueLength).toHaveBeenNthCalledWith(2, "stripe-events");
    expect(drain).toHaveBeenCalledWith("stripe-events", expect.any(Function), {
      max: 25,
      budgetMs: 25_000,
      maxAttempts: 5,
    });
    expect(processStripeEvent).toHaveBeenCalledWith({
      body: { kind: "stripe.event", eventId: "evt_1" },
      attempts: 2,
    });
  });

  test("returns failureResponse JSON when queue draining fails", async () => {
    queueLength.mockReset();
    drain.mockReset();
    queueLength.mockResolvedValueOnce(3);
    drain.mockRejectedValueOnce(new Error("redis unavailable"));

    const response = await app.fetch(
      post({ "x-cron-secret": "cron-secret" }),
      env,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "An unexpected error occurred",
      code: "internal_error",
    });
  });
});
