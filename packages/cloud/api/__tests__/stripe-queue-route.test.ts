/** Exercises cron authentication, Stripe draining and notice sweep routing with deterministic boundary fixtures. */
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
const recoverOrganizationSubscriptionCancellations = mock(async () => ({
  inspected: 1,
  applied: 0,
  pending: 1,
  unavailable: 0,
}));
mock.module("@/lib/services/subscription-cancellation", () => ({
  recoverOrganizationSubscriptionCancellations,
}));
const recoverMissedSubscriptionEvents = mock(async () => ({
  status: "ok",
  attempts: [],
}));
mock.module("@/lib/services/subscription-reconciliation", () => ({
  recoverMissedSubscriptionEvents,
}));
const sweepSubscriptionNotices = mock(async () => ({
  inspected: 1,
  policyUnavailable: 1,
}));
mock.module("@/lib/services/subscription-notices", () => ({
  sweepSubscriptionNotices,
}));

// The migrated Stripe consumer suite owns terminal reconciliation; these credit/queue
// contracts exercise retry behavior when that separate collaborator is unavailable.
mock.module("@/lib/services/stripe-scheduled-cancellation-lifecycle", () => ({
  reconcileStripeScheduledCancellationLifecycle: async () => {
    throw new Error(
      "Subscription schedule lifecycle unavailable in legacy fixture",
    );
  },
}));
mock.module("@/lib/services/stripe-terminal-lifecycle", () => ({
  reconcileStripeTerminalLifecycle: async () => {
    throw new Error(
      "Terminal reconciliation unavailable in this credit/queue fixture",
    );
  },
}));
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
    sweepSubscriptionNotices.mockClear();
    recoverMissedSubscriptionEvents.mockReset();
    recoverMissedSubscriptionEvents.mockResolvedValue({
      status: "ok",
      attempts: [],
    });
    recoverOrganizationSubscriptionCancellations.mockClear();
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
    expect(sweepSubscriptionNotices).not.toHaveBeenCalled();
    expect(recoverOrganizationSubscriptionCancellations).not.toHaveBeenCalled();
    expect(recoverMissedSubscriptionEvents).not.toHaveBeenCalled();
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
      notices: { inspected: 1, policyUnavailable: 1 },
      recovery: { status: "ok", attempts: [] },
      cancellations: { inspected: 1, applied: 0, pending: 1, unavailable: 0 },
      before: 3,
      after: 1,
      processed: 1,
      failed: 0,
      retried: 0,
    });
    expect(recoverOrganizationSubscriptionCancellations).toHaveBeenCalledWith(
      5,
    );
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

  test("reports a failed queue lane while still awaiting independent recovery and notices", async () => {
    queueLength.mockReset();
    drain.mockReset();
    queueLength.mockResolvedValueOnce(3);
    drain.mockRejectedValueOnce(new Error("redis unavailable"));

    const response = await app.fetch(
      post({ "x-cron-secret": "cron-secret" }),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "stripe_maintenance_lane_failed",
      failedLanes: ["queue"],
      lanes: [
        { lane: "queue", status: "failed" },
        {
          lane: "cancellations",
          status: "fulfilled",
          result: { inspected: 1, applied: 0, pending: 1, unavailable: 0 },
        },
        {
          lane: "notices",
          status: "fulfilled",
          result: { inspected: 1, policyUnavailable: 1 },
        },
        {
          lane: "recovery",
          status: "fulfilled",
          result: { status: "ok", attempts: [] },
        },
      ],
    });
    expect(recoverMissedSubscriptionEvents).toHaveBeenCalledTimes(1);
    expect(sweepSubscriptionNotices).toHaveBeenCalledTimes(1);
  });
});

test("degraded observation receipts remain explicitly retryable at the cron boundary", async () => {
  queueLength.mockReset();
  queueLength.mockResolvedValue(0);
  drain.mockReset();
  drain.mockResolvedValue({ processed: 0, failed: 0, retried: 0 });
  recoverMissedSubscriptionEvents.mockResolvedValueOnce({
    status: "degraded",
    attempts: [],
  });
  const response = await app.fetch(
    post({ authorization: "Bearer cron-secret" }),
    env,
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    error: "subscription_recovery_degraded",
    recovery: { status: "degraded" },
  });
});
