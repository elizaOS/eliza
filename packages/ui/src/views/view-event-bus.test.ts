// @vitest-environment jsdom
/**
 * Unit coverage for the cross-view event bus: emit envelope shape, typed and
 * wildcard subscriptions, multiple-subscriber fan-out, and unsubscribe
 * semantics. Deterministic — exercises the synchronous same-window transport;
 * the jsdom harness has no BroadcastChannel and none is asserted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitViewEvent,
  onAnyViewEvent,
  onViewEvent,
  type ViewEvent,
} from "./view-event-bus";

const unsubscribers: (() => void)[] = [];

function track(unsubscribe: () => void): () => void {
  unsubscribers.push(unsubscribe);
  return unsubscribe;
}

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

describe("emitViewEvent + onViewEvent", () => {
  it("delivers the full event envelope to a type subscriber", () => {
    const received: ViewEvent[] = [];
    track(
      onViewEvent("wallet:balance:updated", (event) => received.push(event)),
    );

    emitViewEvent("wallet:balance:updated", { balance: 42 }, "wallet-view");

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.type).toBe("wallet:balance:updated");
    expect(event.payload).toEqual({ balance: 42 });
    expect(event.sourceViewId).toBe("wallet-view");
    expect(typeof event.timestamp).toBe("number");
  });

  it("does not deliver other types to a typed subscription", () => {
    const handler = vi.fn();
    track(onViewEvent("chat:new", handler));

    emitViewEvent("wallet:balance:updated", {});
    emitViewEvent("chat:new", { text: "hi" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload).toEqual({ text: "hi" });
  });

  it("stops delivery once the returned unsubscribe is called", () => {
    const typed = vi.fn();
    const unsubscribe = onViewEvent("agent:push", typed);
    emitViewEvent("agent:push", { first: true });
    unsubscribe();
    emitViewEvent("agent:push", { second: true });
    expect(typed).toHaveBeenCalledTimes(1);
    expect(typed.mock.calls[0][0].payload).toEqual({ first: true });

    const wildcard = vi.fn();
    const offAny = onAnyViewEvent(wildcard);
    emitViewEvent("agent:push", { third: true });
    offAny();
    emitViewEvent("agent:push", { fourth: true });
    expect(wildcard).toHaveBeenCalledTimes(1);
  });
});

describe("onAnyViewEvent", () => {
  it("delivers every emitted event regardless of type", () => {
    const seen = vi.fn();
    track(onAnyViewEvent(seen));

    emitViewEvent("a:first", { n: 1 });
    emitViewEvent("b:second", { n: 2 }, "other-view");

    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls.map(([event]) => event.type)).toEqual([
      "a:first",
      "b:second",
    ]);
    expect(seen.mock.calls[1][0].sourceViewId).toBe("other-view");
  });

  it("notifies every active subscriber for a single emission", () => {
    const typed = vi.fn();
    const wildcard = vi.fn();
    track(onViewEvent("docs:saved", typed));
    track(onAnyViewEvent(wildcard));

    emitViewEvent("docs:saved", { id: "d1" });

    expect(typed).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(1);
    expect(typed.mock.calls[0][0]).toMatchObject({ payload: { id: "d1" } });
  });

  it("delivers synchronously within the emitting call", () => {
    let observed = false;
    track(
      onAnyViewEvent(() => {
        observed = true;
      }),
    );

    emitViewEvent("sync:probe");

    expect(observed).toBe(true);
  });
});

describe("emit defaults", () => {
  it("defaults the payload to an empty object and sourceViewId to undefined", () => {
    const received: ViewEvent[] = [];
    track(onAnyViewEvent((event) => received.push(event)));

    emitViewEvent("presence:tick");

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({});
    expect(received[0].sourceViewId).toBeUndefined();
  });
});
