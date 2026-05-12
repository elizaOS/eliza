import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));

import { createOAuthCallbackBus, type OAuthCallbackEvent } from "@/lib/services/oauth-callback-bus";

function makeReceived(
  intentId: string,
  overrides: Partial<Extract<OAuthCallbackEvent, { name: "OAuthCallbackReceived" }>> = {},
): OAuthCallbackEvent {
  return {
    name: "OAuthCallbackReceived",
    intentId,
    provider: "google",
    status: "bound",
    receivedAt: new Date(),
    ...overrides,
  };
}

function makeFailed(
  intentId: string,
  overrides: Partial<Extract<OAuthCallbackEvent, { name: "OAuthBindFailed" }>> = {},
): OAuthCallbackEvent {
  return {
    name: "OAuthBindFailed",
    intentId,
    provider: "google",
    error: "boom",
    failedAt: new Date(),
    ...overrides,
  };
}

describe("oauth-callback-bus", () => {
  test("publish delivers events to all matching subscribers", async () => {
    const bus = createOAuthCallbackBus();
    const received: OAuthCallbackEvent[] = [];
    bus.subscribe({}, (e) => {
      received.push(e);
    });
    await bus.publish(makeReceived("i_1"));
    await bus.publish(makeFailed("i_2"));
    expect(received).toHaveLength(2);
  });

  test("subscribe filters by intentId", async () => {
    const bus = createOAuthCallbackBus();
    const received: OAuthCallbackEvent[] = [];
    bus.subscribe({ intentId: "i_match" }, (e) => {
      received.push(e);
    });
    await bus.publish(makeReceived("i_other"));
    await bus.publish(makeReceived("i_match"));
    await bus.publish(makeFailed("i_match"));
    expect(received).toHaveLength(2);
    expect(received.every((e) => e.intentId === "i_match")).toBe(true);
  });

  test("subscribe filters by event name", async () => {
    const bus = createOAuthCallbackBus();
    const received: OAuthCallbackEvent[] = [];
    bus.subscribe({ name: "OAuthBindFailed" }, (e) => {
      received.push(e);
    });
    await bus.publish(makeReceived("i_1"));
    await bus.publish(makeFailed("i_1"));
    expect(received).toHaveLength(1);
    expect(received[0]?.name).toBe("OAuthBindFailed");
  });

  test("waitFor resolves on the next matching event", async () => {
    const bus = createOAuthCallbackBus();
    const promise = bus.waitFor({ intentId: "i_wait", names: ["OAuthCallbackReceived"] }, 1000);
    await bus.publish(makeFailed("i_wait"));
    await bus.publish(makeReceived("i_wait", { scopesGranted: ["calendar.readonly"] }));
    const event = await promise;
    expect(event.name).toBe("OAuthCallbackReceived");
    if (event.name === "OAuthCallbackReceived") {
      expect(event.scopesGranted).toEqual(["calendar.readonly"]);
    }
  });

  test("waitFor rejects on timeout", async () => {
    const bus = createOAuthCallbackBus();
    await expect(
      bus.waitFor({ intentId: "i_never", names: ["OAuthCallbackReceived"] }, 25),
    ).rejects.toThrow(/timed out/);
  });

  test("a failing listener does not block others", async () => {
    const bus = createOAuthCallbackBus();
    const received: OAuthCallbackEvent[] = [];
    bus.subscribe({}, () => {
      throw new Error("bang");
    });
    bus.subscribe({}, async () => {
      await Promise.reject(new Error("async-bang"));
    });
    bus.subscribe({}, (e) => {
      received.push(e);
    });
    await bus.publish(makeReceived("i_iso"));
    expect(received).toHaveLength(1);
  });

  test("unsubscribe stops further deliveries", async () => {
    const bus = createOAuthCallbackBus();
    const received: OAuthCallbackEvent[] = [];
    const off = bus.subscribe({}, (e) => {
      received.push(e);
    });
    await bus.publish(makeReceived("i_a"));
    off();
    await bus.publish(makeReceived("i_b"));
    expect(received).toHaveLength(1);
  });

  test("waitFor cleans up its subscription on resolve and on timeout", async () => {
    const bus = createOAuthCallbackBus();
    const p1 = bus.waitFor({ intentId: "i_clean", names: ["OAuthCallbackReceived"] }, 1000);
    await bus.publish(makeReceived("i_clean"));
    await p1;

    await expect(
      bus.waitFor({ intentId: "i_to", names: ["OAuthCallbackReceived"] }, 10),
    ).rejects.toThrow(/timed out/);

    let count = 0;
    bus.subscribe({}, () => {
      count += 1;
    });
    await bus.publish(makeReceived("i_clean"));
    await bus.publish(makeReceived("i_to"));
    expect(count).toBe(2);
  });

  test("record hook runs before fan-out and isolates failures", async () => {
    const recorded: OAuthCallbackEvent[] = [];
    const bus = createOAuthCallbackBus({
      record: async (e) => {
        recorded.push(e);
      },
    });
    let delivered = false;
    bus.subscribe({}, () => {
      delivered = true;
    });
    await bus.publish(makeReceived("i_rec"));
    expect(recorded).toHaveLength(1);
    expect(delivered).toBe(true);

    const bus2 = createOAuthCallbackBus({
      record: async () => {
        throw new Error("rec-bang");
      },
    });
    let delivered2 = false;
    bus2.subscribe({}, () => {
      delivered2 = true;
    });
    await bus2.publish(makeReceived("i_recfail"));
    expect(delivered2).toBe(true);
  });
});
