// @vitest-environment jsdom
/**
 * Unit coverage for the cross-view event bus: emit envelope shape, typed and
 * catch-all same-window subscription, FIFO delivery ordering, unsubscribe,
 * and listener-free emission. Drives the real module over jsdom's window
 * CustomEvent transport; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  emitViewEvent,
  onAnyViewEvent,
  onViewEvent,
  type ViewEvent,
} from "./view-event-bus";

function collect(into: ViewEvent[]) {
  return (event: ViewEvent) => {
    into.push(event);
  };
}

describe("emitViewEvent envelope", () => {
  it("delivers type, payload, sourceViewId and timestamp to a matching subscriber", () => {
    const received: ViewEvent[] = [];
    const unsubscribe = onViewEvent(
      "wallet:balance:updated",
      collect(received),
    );

    const before = Date.now();
    emitViewEvent(
      "wallet:balance:updated",
      { address: "0xabc" },
      "wallet-view",
    );
    const after = Date.now();
    unsubscribe();

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.type).toBe("wallet:balance:updated");
    expect(event.payload).toEqual({ address: "0xabc" });
    expect(event.sourceViewId).toBe("wallet-view");
    expect(typeof event.timestamp).toBe("number");
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it("defaults payload to an empty object and sourceViewId to undefined when omitted", () => {
    const received: ViewEvent[] = [];
    const unsubscribe = onAnyViewEvent(collect(received));

    emitViewEvent("agent:pushed");
    unsubscribe();

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.payload).toEqual({});
    expect(event.sourceViewId).toBeUndefined();
    expect(Object.keys(event).sort()).toEqual([
      "payload",
      "sourceViewId",
      "timestamp",
      "type",
    ]);
  });

  it("does not throw when nothing is subscribed", () => {
    expect(() => {
      emitViewEvent("views:no-listeners", { any: true });
      emitViewEvent("views:no-listeners");
    }).not.toThrow();
  });
});

describe("onViewEvent filtering", () => {
  it("matches only the exact event type", () => {
    const received: ViewEvent[] = [];
    const unsubscribe = onViewEvent("chat:closed", collect(received));

    emitViewEvent("chat:open");
    emitViewEvent("chat:closed:by-user");
    emitViewEvent("chat:closed");

    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("chat:closed");
  });

  it("stops delivering after unsubscribe and resumes after resubscribing", () => {
    const received: ViewEvent[] = [];
    let unsubscribe = onViewEvent("nav:tab", collect(received));

    emitViewEvent("nav:tab", { n: 1 });
    unsubscribe();

    emitViewEvent("nav:tab", { n: 2 });

    unsubscribe = onViewEvent("nav:tab", collect(received));
    emitViewEvent("nav:tab", { n: 3 });
    unsubscribe();

    expect(received.map((event) => event.payload)).toEqual([
      { n: 1 },
      { n: 3 },
    ]);
  });

  it("delivers every registered subscriber its own copy of the same emission", () => {
    const first: ViewEvent[] = [];
    const second: ViewEvent[] = [];
    const unsubFirst = onViewEvent("files:saved", collect(first));
    const unsubSecond = onViewEvent("files:saved", collect(second));

    emitViewEvent("files:saved", { path: "/tmp/a.txt" }, "editor-view");

    unsubFirst();
    unsubSecond();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(first[0]);
    expect(second[0].sourceViewId).toBe("editor-view");
  });
});

describe("onAnyViewEvent", () => {
  it("receives events of every type in emission order", () => {
    const received: ViewEvent[] = [];
    const unsubscribe = onAnyViewEvent(collect(received));

    emitViewEvent("a:first");
    emitViewEvent("b:second", { i: 2 });
    emitViewEvent("c:third");

    unsubscribe();

    expect(received.map((event) => event.type)).toEqual([
      "a:first",
      "b:second",
      "c:third",
    ]);
    expect(received[1].payload).toEqual({ i: 2 });
  });

  it("ignores events emitted after unsubscribe and tolerates double-unsubscribe", () => {
    const received: ViewEvent[] = [];
    const unsubscribe = onAnyViewEvent(collect(received));

    emitViewEvent("x:before");
    unsubscribe();
    unsubscribe();
    emitViewEvent("x:after");

    expect(received.map((event) => event.type)).toEqual(["x:before"]);
  });

  it("sees the identical event object a filtered subscriber sees for one emission", () => {
    const viaAny: ViewEvent[] = [];
    const viaTyped: ViewEvent[] = [];
    const unsubAny = onAnyViewEvent(collect(viaAny));
    const unsubTyped = onViewEvent("sync:done", collect(viaTyped));

    emitViewEvent("sync:done", { items: 3 });

    unsubAny();
    unsubTyped();

    expect(viaAny).toHaveLength(1);
    expect(viaTyped).toHaveLength(1);
    expect(viaTyped[0]).toBe(viaAny[0]);
  });
});
