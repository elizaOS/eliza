// @vitest-environment jsdom
/**
 * view-event-bus unit tests: same-window delivery via the CustomEvent transport,
 * typed subscription filtering, unsubscribe semantics, and the cross-tab
 * BroadcastChannel transport (echo suppression, postMessage shape, and the
 * graceful-absence paths when BroadcastChannel is unavailable or throws).
 * Deterministic; jsdom environment, injected fake clock, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitViewEvent, onAnyViewEvent, onViewEvent } from "./view-event-bus";

const CHANNEL_NAME = "elizaos-views";
const WINDOW_EVENT_NAME = "elizaos-view-event";

/** Captures every handler invocation across both transports for assertions. */
function recorder() {
  const calls: { channel: boolean; window: boolean; event: unknown }[] = [];
  return {
    calls,
    onChannel(data: unknown) {
      calls.push({ channel: true, window: false, event: data });
    },
    onWindow(event: Event) {
      calls.push({
        channel: false,
        window: true,
        event: (event as CustomEvent).detail,
      });
    },
  };
}

describe("emitViewEvent / onAnyViewEvent (same-window transport)", () => {
  it("delivers the event object with type, payload, sourceViewId, and timestamp", () => {
    const rec = recorder();
    const unsub = onAnyViewEvent((event) =>
      rec.onWindow({ detail: event } as CustomEvent),
    );
    const before = Date.now();
    emitViewEvent("wallet:balance:updated", { balance: 42 }, "view-1");
    expect(rec.calls).toHaveLength(1);
    const event = rec.calls[0].event as {
      type: string;
      payload: Record<string, unknown>;
      sourceViewId?: string;
      timestamp: number;
    };
    expect(event.type).toBe("wallet:balance:updated");
    expect(event.payload).toEqual({ balance: 42 });
    expect(event.sourceViewId).toBe("view-1");
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    unsub();
  });

  it("defaults the payload to an empty object and sourceViewId to undefined", () => {
    const seen: unknown[] = [];
    const unsub = onAnyViewEvent((event) => seen.push(event));
    emitViewEvent("ping");
    expect(seen).toHaveLength(1);
    const event = seen[0] as {
      payload: Record<string, unknown>;
      sourceViewId?: string;
    };
    expect(event.payload).toEqual({});
    expect(event.sourceViewId).toBeUndefined();
    unsub();
  });

  it("receives every event type on the any-channel, including unrelated types", () => {
    const seen: string[] = [];
    const unsub = onAnyViewEvent((event) => seen.push(event.type));
    emitViewEvent("a:first");
    emitViewEvent("b:second");
    emitViewEvent("c:third");
    expect(seen).toEqual(["a:first", "b:second", "c:third"]);
    unsub();
  });

  it("delivers to multiple subscribers and preserves registration order", () => {
    const order: string[] = [];
    const unsubA = onAnyViewEvent(() => order.push("a"));
    const unsubB = onAnyViewEvent(() => order.push("b"));
    emitViewEvent("tick");
    expect(order).toEqual(["a", "b"]);
    unsubA();
    unsubB();
  });

  it("stops delivery after the unsubscribe function runs", () => {
    const seen: string[] = [];
    const unsub = onAnyViewEvent((event) => seen.push(event.type));
    emitViewEvent("before");
    unsub();
    emitViewEvent("after");
    expect(seen).toEqual(["before"]);
  });
});

describe("onViewEvent (typed subscription)", () => {
  it("invokes the handler only for the subscribed type", () => {
    const seen: string[] = [];
    const unsub = onViewEvent("app:focus", (event) => seen.push(event.type));
    emitViewEvent("app:blur");
    emitViewEvent("app:focus");
    emitViewEvent("app:focus:extra");
    expect(seen).toEqual(["app:focus"]);
    unsub();
  });

  it("still receives its type while an any-listener receives everything", () => {
    const focused: string[] = [];
    const everything: string[] = [];
    const unsubFocus = onViewEvent("x", (e) => focused.push(e.type));
    const unsubAny = onAnyViewEvent((e) => everything.push(e.type));
    emitViewEvent("x");
    emitViewEvent("y");
    expect(focused).toEqual(["x"]);
    expect(everything).toEqual(["x", "y"]);
    unsubFocus();
    unsubAny();
  });

  it("stops filtering after unsubscribe; other subscribers keep receiving", () => {
    const focused: string[] = [];
    const everything: string[] = [];
    const unsubFocus = onViewEvent("x", (e) => focused.push(e.type));
    const unsubAny = onAnyViewEvent((e) => everything.push(e.type));
    emitViewEvent("x");
    unsubFocus();
    emitViewEvent("x");
    expect(focused).toEqual(["x"]);
    expect(everything).toEqual(["x", "x"]);
    unsubAny();
  });
});

describe("emitViewEvent window CustomEvent dispatch shape", () => {
  it("dispatches a namespaced CustomEvent carrying the ViewEvent as detail", () => {
    let captured: CustomEvent | undefined;
    const listener = (e: Event) => {
      captured = e as CustomEvent;
    };
    window.addEventListener(WINDOW_EVENT_NAME, listener);
    emitViewEvent("shape:check", { k: "v" }, "src");
    window.removeEventListener(WINDOW_EVENT_NAME, listener);
    expect(captured).toBeDefined();
    expect(captured?.type).toBe(WINDOW_EVENT_NAME);
    expect(captured?.detail).toMatchObject({
      type: "shape:check",
      payload: { k: "v" },
      sourceViewId: "src",
    });
  });
});

describe("cross-tab BroadcastChannel transport", () => {
  const originalBC = globalThis.BroadcastChannel;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBC) {
      (
        globalThis as { BroadcastChannel?: typeof BroadcastChannel }
      ).BroadcastChannel = originalBC;
    } else {
      delete (globalThis as { BroadcastChannel?: typeof BroadcastChannel })
        .BroadcastChannel;
    }
  });

  it("posts the event to the elizaos-views channel and does not echo to the same tab", async () => {
    const posts: { channel: string; data: unknown }[] = [];
    class FakeChannel {
      name = CHANNEL_NAME;
      postMessage(data: unknown) {
        posts.push({ channel: this.name, data });
      }
      addEventListener() {}
      removeEventListener() {}
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    // Re-import a fresh module copy so the lazy channel singleton rebinds to the fake.
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: string[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e.type));
    bus.emitViewEvent("cross:tab", { n: 1 }, "v");
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe(CHANNEL_NAME);
    expect(posts[0].data).toMatchObject({
      type: "cross:tab",
      payload: { n: 1 },
    });
    // Same-window listener fired once (the module's own channel never echoes).
    expect(seen).toEqual(["cross:tab"]);
    unsub();
  });

  it("delivers BroadcastChannel messages from other tabs to subscribers", async () => {
    let channelListener: ((msg: { data: unknown }) => void) | undefined;
    class FakeChannel {
      name = CHANNEL_NAME;
      addEventListener(_type: string, l: (msg: { data: unknown }) => void) {
        channelListener = l;
      }
      removeEventListener() {
        channelListener = undefined;
      }
      postMessage() {}
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: unknown[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e));
    channelListener?.({
      data: { type: "other:tab", payload: { z: 1 }, timestamp: 5 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "other:tab", payload: { z: 1 } });
    unsub();
  });

  it("falls back to same-window-only delivery when BroadcastChannel is undefined (SSR-like)", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: string[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e.type));
    expect(() => bus.emitViewEvent("no:bc", { ok: true })).not.toThrow();
    expect(seen).toEqual(["no:bc"]);
    unsub();
  });

  it("falls back to same-window-only delivery when BroadcastChannel construction throws", async () => {
    class ThrowingChannel {
      constructor() {
        throw new Error("restricted worker");
      }
    }
    vi.stubGlobal("BroadcastChannel", ThrowingChannel);
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: string[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e.type));
    expect(() => bus.emitViewEvent("throw:bc")).not.toThrow();
    expect(seen).toEqual(["throw:bc"]);
    unsub();
  });

  it("keeps both transports after a throwing construction: postMessage never called", async () => {
    const posts: unknown[] = [];
    class ThrowingChannel {
      constructor() {
        throw new Error("restricted worker");
      }
      addEventListener() {}
      removeEventListener() {}
      postMessage(d: unknown) {
        posts.push(d);
      }
    }
    vi.stubGlobal("BroadcastChannel", ThrowingChannel);
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: string[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e.type));
    expect(() => bus.emitViewEvent("throw2:bc")).not.toThrow();
    expect(posts).toHaveLength(0);
    expect(seen).toEqual(["throw2:bc"]);
    unsub();
  });
});
