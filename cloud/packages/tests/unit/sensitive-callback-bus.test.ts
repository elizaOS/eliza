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
  createSensitiveCallbackBus,
  type SensitiveCallbackEvent,
} from "@/lib/services/sensitive-callback-bus";

function makeSubmitted(id: string): SensitiveCallbackEvent {
  return {
    name: "SensitiveRequestSubmitted",
    sensitiveRequestId: id,
    submittedAt: new Date(),
  };
}

function makeExpired(id: string): SensitiveCallbackEvent {
  return {
    name: "SensitiveRequestExpired",
    sensitiveRequestId: id,
    expiredAt: new Date(),
  };
}

function makeCanceled(id: string, reason?: string): SensitiveCallbackEvent {
  return {
    name: "SensitiveRequestCanceled",
    sensitiveRequestId: id,
    canceledAt: new Date(),
    reason,
  };
}

describe("sensitive-callback-bus", () => {
  test("publish delivers events to all matching subscribers", async () => {
    const bus = createSensitiveCallbackBus();
    const received: SensitiveCallbackEvent[] = [];
    bus.subscribe({}, (e) => {
      received.push(e);
    });
    await bus.publish(makeSubmitted("s_1"));
    await bus.publish(makeExpired("s_2"));
    await bus.publish(makeCanceled("s_3", "user_canceled"));
    expect(received).toHaveLength(3);
  });

  test("subscribe filters by sensitiveRequestId", async () => {
    const bus = createSensitiveCallbackBus();
    const received: SensitiveCallbackEvent[] = [];
    bus.subscribe({ sensitiveRequestId: "s_match" }, (e) => {
      received.push(e);
    });
    await bus.publish(makeSubmitted("s_other"));
    await bus.publish(makeSubmitted("s_match"));
    await bus.publish(makeCanceled("s_match"));
    expect(received).toHaveLength(2);
    expect(received.every((e) => e.sensitiveRequestId === "s_match")).toBe(true);
  });

  test("subscribe filters by event name", async () => {
    const bus = createSensitiveCallbackBus();
    const received: SensitiveCallbackEvent[] = [];
    bus.subscribe({ name: "SensitiveRequestExpired" }, (e) => {
      received.push(e);
    });
    await bus.publish(makeSubmitted("s_1"));
    await bus.publish(makeExpired("s_1"));
    await bus.publish(makeCanceled("s_1"));
    expect(received).toHaveLength(1);
    expect(received[0]?.name).toBe("SensitiveRequestExpired");
  });

  test("waitFor resolves on the next matching event", async () => {
    const bus = createSensitiveCallbackBus();
    const promise = bus.waitFor(
      {
        sensitiveRequestId: "s_wait",
        names: ["SensitiveRequestSubmitted", "SensitiveRequestCanceled"],
      },
      1000,
    );
    await bus.publish(makeExpired("s_wait"));
    await bus.publish(makeCanceled("s_wait", "user"));
    const event = await promise;
    expect(event.name).toBe("SensitiveRequestCanceled");
  });

  test("waitFor rejects on timeout", async () => {
    const bus = createSensitiveCallbackBus();
    await expect(
      bus.waitFor(
        { sensitiveRequestId: "s_never", names: ["SensitiveRequestSubmitted"] },
        25,
      ),
    ).rejects.toThrow(/timed out/);
  });

  test("a failing listener does not block others", async () => {
    const bus = createSensitiveCallbackBus();
    const received: SensitiveCallbackEvent[] = [];
    bus.subscribe({}, () => {
      throw new Error("bang");
    });
    bus.subscribe({}, async () => {
      await Promise.reject(new Error("async-bang"));
    });
    bus.subscribe({}, (e) => {
      received.push(e);
    });
    await bus.publish(makeSubmitted("s_iso"));
    expect(received).toHaveLength(1);
  });

  test("unsubscribe stops further deliveries", async () => {
    const bus = createSensitiveCallbackBus();
    const received: SensitiveCallbackEvent[] = [];
    const off = bus.subscribe({}, (e) => {
      received.push(e);
    });
    await bus.publish(makeSubmitted("s_a"));
    off();
    await bus.publish(makeSubmitted("s_b"));
    expect(received).toHaveLength(1);
  });

  test("waitFor cleans up subscription on resolve and timeout", async () => {
    const bus = createSensitiveCallbackBus();
    const p = bus.waitFor(
      { sensitiveRequestId: "s_clean", names: ["SensitiveRequestSubmitted"] },
      1000,
    );
    await bus.publish(makeSubmitted("s_clean"));
    await p;
    await expect(
      bus.waitFor(
        { sensitiveRequestId: "s_to", names: ["SensitiveRequestSubmitted"] },
        10,
      ),
    ).rejects.toThrow(/timed out/);

    let count = 0;
    bus.subscribe({}, () => {
      count += 1;
    });
    await bus.publish(makeSubmitted("s_clean"));
    await bus.publish(makeSubmitted("s_to"));
    expect(count).toBe(2);
  });

  test("record hook runs and isolates failures", async () => {
    const recorded: SensitiveCallbackEvent[] = [];
    const bus = createSensitiveCallbackBus({
      record: async (e) => {
        recorded.push(e);
      },
    });
    let delivered = false;
    bus.subscribe({}, () => {
      delivered = true;
    });
    await bus.publish(makeSubmitted("s_rec"));
    expect(recorded).toHaveLength(1);
    expect(delivered).toBe(true);

    const bus2 = createSensitiveCallbackBus({
      record: async () => {
        throw new Error("rec-bang");
      },
    });
    let delivered2 = false;
    bus2.subscribe({}, () => {
      delivered2 = true;
    });
    await bus2.publish(makeSubmitted("s_recfail"));
    expect(delivered2).toBe(true);
  });
});
