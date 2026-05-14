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
  type ApprovalCallbackEvent,
  createApprovalCallbackBus,
} from "@/lib/services/approval-callback-bus";

function makeApproved(
  approvalRequestId: string,
  overrides: Partial<Extract<ApprovalCallbackEvent, { name: "ApprovalApproved" }>> = {},
): ApprovalCallbackEvent {
  return {
    name: "ApprovalApproved",
    approvalRequestId,
    signerIdentityId: "0xabc",
    signatureText: "0xdeadbeef",
    approvedAt: new Date(),
    ...overrides,
  };
}

function makeDenied(
  approvalRequestId: string,
  overrides: Partial<Extract<ApprovalCallbackEvent, { name: "ApprovalDenied" }>> = {},
): ApprovalCallbackEvent {
  return {
    name: "ApprovalDenied",
    approvalRequestId,
    deniedAt: new Date(),
    ...overrides,
  };
}

describe("approval-callback-bus", () => {
  test("publish delivers events to all matching subscribers", async () => {
    const bus = createApprovalCallbackBus();
    const received: ApprovalCallbackEvent[] = [];

    bus.subscribe({}, (event) => {
      received.push(event);
    });

    await bus.publish(makeApproved("appr_1"));
    await bus.publish(makeDenied("appr_2"));

    expect(received).toHaveLength(2);
    expect(received[0]?.name).toBe("ApprovalApproved");
    expect(received[1]?.name).toBe("ApprovalDenied");
  });

  test("subscribe filters by approvalRequestId", async () => {
    const bus = createApprovalCallbackBus();
    const received: ApprovalCallbackEvent[] = [];

    bus.subscribe({ approvalRequestId: "appr_match" }, (event) => {
      received.push(event);
    });

    await bus.publish(makeApproved("appr_other"));
    await bus.publish(makeApproved("appr_match"));
    await bus.publish(makeDenied("appr_match"));

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.approvalRequestId === "appr_match")).toBe(true);
  });

  test("subscribe filters by event name", async () => {
    const bus = createApprovalCallbackBus();
    const received: ApprovalCallbackEvent[] = [];

    bus.subscribe({ name: "ApprovalApproved" }, (event) => {
      received.push(event);
    });

    await bus.publish(makeApproved("appr_1"));
    await bus.publish(makeDenied("appr_1"));
    await bus.publish(makeApproved("appr_2"));

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.name === "ApprovalApproved")).toBe(true);
  });

  test("waitFor resolves on the next matching event", async () => {
    const bus = createApprovalCallbackBus();
    const promise = bus.waitFor(
      { approvalRequestId: "appr_wait", names: ["ApprovalApproved"] },
      1000,
    );

    await bus.publish(makeApproved("appr_other"));
    await bus.publish(makeDenied("appr_wait"));
    await bus.publish(makeApproved("appr_wait", { signerIdentityId: "0xdef" }));

    const event = await promise;
    expect(event.name).toBe("ApprovalApproved");
    expect(event.approvalRequestId).toBe("appr_wait");
    if (event.name === "ApprovalApproved") {
      expect(event.signerIdentityId).toBe("0xdef");
    }
  });

  test("waitFor rejects on timeout", async () => {
    const bus = createApprovalCallbackBus();
    await expect(
      bus.waitFor({ approvalRequestId: "appr_never", names: ["ApprovalApproved"] }, 25),
    ).rejects.toThrow(/timed out/);
  });

  test("a failing listener does not block others", async () => {
    const bus = createApprovalCallbackBus();
    const received: ApprovalCallbackEvent[] = [];

    bus.subscribe({}, () => {
      throw new Error("listener-bang");
    });
    bus.subscribe({}, async () => {
      await Promise.reject(new Error("async-bang"));
    });
    bus.subscribe({}, (event) => {
      received.push(event);
    });

    await bus.publish(makeApproved("appr_iso"));
    expect(received).toHaveLength(1);
    expect(received[0]?.approvalRequestId).toBe("appr_iso");
  });

  test("unsubscribe stops further deliveries", async () => {
    const bus = createApprovalCallbackBus();
    const received: ApprovalCallbackEvent[] = [];

    const off = bus.subscribe({}, (event) => {
      received.push(event);
    });

    await bus.publish(makeApproved("appr_a"));
    off();
    await bus.publish(makeApproved("appr_b"));

    expect(received).toHaveLength(1);
    expect(received[0]?.approvalRequestId).toBe("appr_a");
  });

  test("waitFor cleans up its subscription on resolve", async () => {
    const bus = createApprovalCallbackBus();
    const promise = bus.waitFor(
      { approvalRequestId: "appr_clean", names: ["ApprovalApproved"] },
      1000,
    );
    await bus.publish(makeApproved("appr_clean"));
    await promise;

    let count = 0;
    bus.subscribe({ approvalRequestId: "appr_clean" }, () => {
      count += 1;
    });
    await bus.publish(makeApproved("appr_clean"));
    expect(count).toBe(1);
  });

  test("record hook is called before listener fan-out", async () => {
    const recorded: ApprovalCallbackEvent[] = [];
    const order: string[] = [];
    const bus = createApprovalCallbackBus({
      record: async (event) => {
        recorded.push(event);
        order.push("record");
      },
    });

    bus.subscribe({}, () => {
      order.push("listener");
    });

    await bus.publish(makeApproved("appr_rec"));
    expect(recorded).toHaveLength(1);
    expect(order).toEqual(["record", "listener"]);
  });

  test("record failure does not prevent listener delivery", async () => {
    const bus = createApprovalCallbackBus({
      record: async () => {
        throw new Error("record-bang");
      },
    });
    let delivered = false;
    bus.subscribe({}, () => {
      delivered = true;
    });
    await bus.publish(makeApproved("appr_recfail"));
    expect(delivered).toBe(true);
  });
});
