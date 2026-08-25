// @vitest-environment jsdom
/**
 * Unit tests for the cross-view pub-sub bus in the ui views layer: same-window
 * delivery via the CustomEvent transport, typed subscription filtering,
 * unsubscribe semantics, and the cross-tab BroadcastChannel transport
 * (constructor name, postMessage shape, echo suppression, inbound delivery,
 * unsubscribe identity, and the graceful-absence paths when BroadcastChannel
 * or window are unavailable or construction throws).
 * Deterministic; jsdom environment, frozen clock for shape assertions, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitViewEvent, onAnyViewEvent, onViewEvent } from "./view-event-bus";

const CHANNEL_NAME = "elizaos-views";
const WINDOW_EVENT_NAME = "elizaos-view-event";

describe("emitViewEvent / onAnyViewEvent (same-window transport)", () => {
  it("delivers the event object with type, payload, sourceViewId, and timestamp", () => {
    const seen: {
      type: string;
      payload: Record<string, unknown>;
      sourceViewId?: string;
      timestamp: number;
    }[] = [];
    const unsub = onAnyViewEvent((event) => seen.push(event));
    const before = Date.now();
    emitViewEvent("wallet:balance:updated", { balance: 42 }, "view-1");
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("wallet:balance:updated");
    expect(seen[0].payload).toEqual({ balance: 42 });
    expect(seen[0].sourceViewId).toBe("view-1");
    expect(seen[0].timestamp).toBeGreaterThanOrEqual(before);
    unsub();
  });

  it("defaults the payload to an empty object and sourceViewId to undefined", () => {
    const seen: { payload: Record<string, unknown>; sourceViewId?: string }[] =
      [];
    const unsub = onAnyViewEvent((event) => seen.push(event));
    emitViewEvent("ping");
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({});
    expect(seen[0].sourceViewId).toBeUndefined();
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
    vi.useRealTimers();
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

  it("posts the complete ViewEvent to a channel constructed with the exact name, without same-tab echo", async () => {
    const posts: { constructorName: string; data: unknown }[] = [];
    class FakeChannel {
      name: string;
      constructor(name: string) {
        this.name = name;
      }
      postMessage(data: unknown) {
        posts.push({ constructorName: this.name, data });
      }
      addEventListener() {}
      removeEventListener() {}
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.useFakeTimers();
    vi.setSystemTime(1_724_612_345_678);
    // Re-import a fresh module copy so the lazy channel singleton rebinds to the fake.
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: string[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e.type));
    bus.emitViewEvent("cross:tab", { n: 1 }, "v");
    expect(posts).toHaveLength(1);
    expect(posts[0].constructorName).toBe(CHANNEL_NAME);
    // Full ViewEvent shape on the cross-tab wire, with the frozen timestamp.
    expect(posts[0].data).toEqual({
      type: "cross:tab",
      payload: { n: 1 },
      sourceViewId: "v",
      timestamp: 1_724_612_345_678,
    });
    // Same-window listener fired once (the module's own channel never echoes).
    expect(seen).toEqual(["cross:tab"]);
    unsub();
  });

  it("registers exactly one BroadcastChannel listener for the message event and delivers inbound events from other tabs", async () => {
    let channelListener: ((msg: { data: unknown }) => void) | undefined;
    const added: {
      type: string;
      listener: (msg: { data: unknown }) => void;
    }[] = [];
    class FakeChannel {
      name = CHANNEL_NAME;
      addEventListener(
        type: string,
        listener: (msg: { data: unknown }) => void,
      ) {
        added.push({ type, listener });
        channelListener = listener;
      }
      removeEventListener(
        _type: string,
        listener: (msg: { data: unknown }) => void,
      ) {
        if (channelListener === listener) channelListener = undefined;
      }
      postMessage() {}
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: unknown[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e));
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe("message");
    channelListener?.({
      data: { type: "other:tab", payload: { z: 1 }, timestamp: 5 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "other:tab", payload: { z: 1 } });
    unsub();
  });

  it("removes the same BroadcastChannel listener identity on unsubscribe, so later cross-tab messages stop delivering", async () => {
    let channelListener: ((msg: { data: unknown }) => void) | undefined;
    const added: ((msg: { data: unknown }) => void)[] = [];
    const removed: ((msg: { data: unknown }) => void)[] = [];
    class FakeChannel {
      name = CHANNEL_NAME;
      addEventListener(
        _type: string,
        listener: (msg: { data: unknown }) => void,
      ) {
        added.push(listener);
        channelListener = listener;
      }
      removeEventListener(
        _type: string,
        listener: (msg: { data: unknown }) => void,
      ) {
        removed.push(listener);
        if (channelListener === listener) channelListener = undefined;
      }
      postMessage() {}
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.resetModules();
    const bus = await import("./view-event-bus");
    const seen: string[] = [];
    const unsub = bus.onAnyViewEvent((e) => seen.push(e.type));
    channelListener?.({ data: { type: "before:unsub", payload: {} } });
    unsub();
    // The exact listener identity registered is the identity removed.
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(added[0]);
    channelListener?.({ data: { type: "after:unsub", payload: {} } });
    expect(seen).toEqual(["before:unsub"]);
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

  it("falls back to same-window-only delivery when BroadcastChannel construction throws, never posting", async () => {
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
    expect(() => bus.emitViewEvent("throw:bc")).not.toThrow();
    expect(posts).toHaveLength(0);
    expect(seen).toEqual(["throw:bc"]);
    unsub();
  });

  it("skips the window transport entirely when window is undefined", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("window", undefined);
    vi.resetModules();
    const bus = await import("./view-event-bus");
    expect(() => bus.emitViewEvent("ssr:no-window", { x: 1 })).not.toThrow();
    // Neither transport can exist; subscribing and emitting again must be a
    // silent no-op, not a throw.
    const unsub = bus.onAnyViewEvent(() => {
      throw new Error("no transport can deliver here");
    });
    expect(() => bus.emitViewEvent("ssr:no-window-2")).not.toThrow();
    unsub();
  });
});
