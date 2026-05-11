import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));

import {
  createPaymentCallbackBus,
  type PaymentCallbackEvent,
} from "@/lib/services/payment-callback-bus";

function makeSettled(
  paymentRequestId: string,
  overrides: Partial<Extract<PaymentCallbackEvent, { name: "PaymentSettled" }>> = {},
): PaymentCallbackEvent {
  return {
    name: "PaymentSettled",
    paymentRequestId,
    provider: "stripe",
    settledAt: new Date(),
    ...overrides,
  };
}

function makeFailed(
  paymentRequestId: string,
  overrides: Partial<Extract<PaymentCallbackEvent, { name: "PaymentFailed" }>> = {},
): PaymentCallbackEvent {
  return {
    name: "PaymentFailed",
    paymentRequestId,
    provider: "stripe",
    error: "boom",
    failedAt: new Date(),
    ...overrides,
  };
}

describe("payment-callback-bus", () => {
  test("publish delivers events to all matching subscribers", async () => {
    const bus = createPaymentCallbackBus();
    const received: PaymentCallbackEvent[] = [];

    bus.subscribe({}, (event) => {
      received.push(event);
    });

    await bus.publish(makeSettled("pr_1"));
    await bus.publish(makeFailed("pr_2"));

    expect(received).toHaveLength(2);
    expect(received[0]?.name).toBe("PaymentSettled");
    expect(received[1]?.name).toBe("PaymentFailed");
  });

  test("subscribe filters by paymentRequestId", async () => {
    const bus = createPaymentCallbackBus();
    const received: PaymentCallbackEvent[] = [];

    bus.subscribe({ paymentRequestId: "pr_match" }, (event) => {
      received.push(event);
    });

    await bus.publish(makeSettled("pr_other"));
    await bus.publish(makeSettled("pr_match"));
    await bus.publish(makeFailed("pr_match"));

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.paymentRequestId === "pr_match")).toBe(true);
  });

  test("subscribe filters by event name", async () => {
    const bus = createPaymentCallbackBus();
    const received: PaymentCallbackEvent[] = [];

    bus.subscribe({ name: "PaymentSettled" }, (event) => {
      received.push(event);
    });

    await bus.publish(makeSettled("pr_1"));
    await bus.publish(makeFailed("pr_1"));
    await bus.publish(makeSettled("pr_2"));

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.name === "PaymentSettled")).toBe(true);
  });

  test("waitFor resolves on the next matching event", async () => {
    const bus = createPaymentCallbackBus();
    const promise = bus.waitFor(
      { paymentRequestId: "pr_wait", names: ["PaymentSettled"] },
      1000,
    );

    await bus.publish(makeSettled("pr_other"));
    await bus.publish(makeFailed("pr_wait"));
    await bus.publish(makeSettled("pr_wait", { txRef: "tx_abc" }));

    const event = await promise;
    expect(event.name).toBe("PaymentSettled");
    expect(event.paymentRequestId).toBe("pr_wait");
    if (event.name === "PaymentSettled") {
      expect(event.txRef).toBe("tx_abc");
    }
  });

  test("waitFor rejects on timeout", async () => {
    const bus = createPaymentCallbackBus();
    await expect(
      bus.waitFor({ paymentRequestId: "pr_never", names: ["PaymentSettled"] }, 25),
    ).rejects.toThrow(/timed out/);
  });

  test("a failing listener does not block others", async () => {
    const bus = createPaymentCallbackBus();
    const received: PaymentCallbackEvent[] = [];

    bus.subscribe({}, () => {
      throw new Error("listener-bang");
    });
    bus.subscribe({}, async () => {
      await Promise.reject(new Error("async-bang"));
    });
    bus.subscribe({}, (event) => {
      received.push(event);
    });

    await bus.publish(makeSettled("pr_iso"));
    expect(received).toHaveLength(1);
    expect(received[0]?.paymentRequestId).toBe("pr_iso");
  });

  test("unsubscribe stops further deliveries", async () => {
    const bus = createPaymentCallbackBus();
    const received: PaymentCallbackEvent[] = [];

    const off = bus.subscribe({}, (event) => {
      received.push(event);
    });

    await bus.publish(makeSettled("pr_a"));
    off();
    await bus.publish(makeSettled("pr_b"));

    expect(received).toHaveLength(1);
    expect(received[0]?.paymentRequestId).toBe("pr_a");
  });

  test("waitFor cleans up its subscription on resolve", async () => {
    const bus = createPaymentCallbackBus();
    const promise = bus.waitFor(
      { paymentRequestId: "pr_clean", names: ["PaymentSettled"] },
      1000,
    );
    await bus.publish(makeSettled("pr_clean"));
    await promise;

    // Publishing again should not throw or leak — second publish has no
    // subscriber to fire. We can only assert behavior indirectly: subscribe
    // a counter, publish, expect exactly one delivery.
    let count = 0;
    bus.subscribe({ paymentRequestId: "pr_clean" }, () => {
      count += 1;
    });
    await bus.publish(makeSettled("pr_clean"));
    expect(count).toBe(1);
  });

  test("waitFor cleans up its subscription on timeout", async () => {
    const bus = createPaymentCallbackBus();
    await expect(
      bus.waitFor({ paymentRequestId: "pr_to", names: ["PaymentSettled"] }, 10),
    ).rejects.toThrow(/timed out/);

    let count = 0;
    bus.subscribe({}, () => {
      count += 1;
    });
    await bus.publish(makeSettled("pr_to"));
    expect(count).toBe(1);
  });

  test("record hook is called before listener fan-out", async () => {
    const recorded: PaymentCallbackEvent[] = [];
    const order: string[] = [];
    const bus = createPaymentCallbackBus({
      record: async (event) => {
        recorded.push(event);
        order.push("record");
      },
    });

    bus.subscribe({}, () => {
      order.push("listener");
    });

    await bus.publish(makeSettled("pr_rec"));
    expect(recorded).toHaveLength(1);
    expect(order).toEqual(["record", "listener"]);
  });

  test("record failure does not prevent listener delivery", async () => {
    const bus = createPaymentCallbackBus({
      record: async () => {
        throw new Error("record-bang");
      },
    });
    let delivered = false;
    bus.subscribe({}, () => {
      delivered = true;
    });
    await bus.publish(makeSettled("pr_recfail"));
    expect(delivered).toBe(true);
  });
});
