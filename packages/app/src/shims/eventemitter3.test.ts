/**
 * Unit tests for the browser `eventemitter3` shim. The suite drives the real
 * EventEmitter class (named and default) and records empty-queue, single
 * listener, registration order, once-vs-on removal, missing-item no-ops,
 * context binding including nullish fallback, and the emit snapshot so a
 * listener added or removed mid-dispatch does not change who already runs.
 */
import { describe, expect, it, vi } from "vitest";

import EventEmitterDefault, { EventEmitter } from "./eventemitter3.js";

describe("eventemitter3 exports", () => {
  it("exports the same class as both named EventEmitter and default", () => {
    expect(EventEmitter).toBeTypeOf("function");
    expect(EventEmitterDefault).toBe(EventEmitter);
  });
});

describe("eventemitter3 empty queue", () => {
  it("starts with no names, no listeners, and emit returning false", () => {
    const emitter = new EventEmitter();
    expect(emitter.eventNames()).toEqual([]);
    expect(emitter.listeners("ping")).toEqual([]);
    expect(emitter.listenerCount("ping")).toBe(0);
    expect(emitter.emit("ping", 1)).toBe(false);
  });

  it("treats a missing event as empty for listeners and listenerCount", () => {
    const emitter = new EventEmitter();
    const absent = Symbol("absent");
    expect(emitter.listeners(absent)).toEqual([]);
    expect(emitter.listenerCount(absent)).toBe(0);
  });
});

describe("eventemitter3 addListener / on / once", () => {
  it("registers a single listener, reports it, and emits args in order", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    expect(emitter.on("ping", listener)).toBe(emitter);
    expect(emitter.eventNames()).toEqual(["ping"]);
    expect(emitter.listeners("ping")).toEqual([listener]);
    expect(emitter.listenerCount("ping")).toBe(1);
    expect(emitter.emit("ping", "a", 2)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("a", 2);
    expect(emitter.listenerCount("ping")).toBe(1);
  });

  it("addListener and on both append with once:false and chain this", () => {
    const emitter = new EventEmitter();
    const first = vi.fn();
    const second = vi.fn();
    expect(emitter.addListener("ping", first)).toBe(emitter);
    expect(emitter.on("ping", second)).toBe(emitter);
    emitter.emit("ping", 7);
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(
      second.mock.invocationCallOrder[0],
    );
    expect(first).toHaveBeenCalledWith(7);
    expect(second).toHaveBeenCalledWith(7);
    expect(emitter.listenerCount("ping")).toBe(2);
  });

  it("once registers a listener that is removed before the first call", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn(function oncePing(this: EventEmitter) {
      expect(emitter.listenerCount("ping")).toBe(0);
      expect(emitter.eventNames()).toEqual([]);
    });
    expect(emitter.once("ping", listener)).toBe(emitter);
    expect(emitter.listenerCount("ping")).toBe(1);
    expect(emitter.emit("ping", "only")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("only");
    expect(emitter.emit("ping", "again")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("throws TypeError when addListener, on, or once is given a non-function", () => {
    const emitter = new EventEmitter();
    const notAFunction = { listener: true } as unknown as () => void;
    expect(() => emitter.addListener("ping", notAFunction)).toThrow(TypeError);
    expect(() => emitter.addListener("ping", notAFunction)).toThrow(
      "The listener must be a function",
    );
    expect(() => emitter.on("ping", notAFunction)).toThrow(TypeError);
    expect(() => emitter.once("ping", notAFunction)).toThrow(
      "The listener must be a function",
    );
    expect(emitter.eventNames()).toEqual([]);
  });

  it("keeps independent event names, including symbols", () => {
    const emitter = new EventEmitter();
    const token = Symbol("token");
    const stringListener = vi.fn();
    const symbolListener = vi.fn();
    emitter.on("ping", stringListener);
    emitter.on(token, symbolListener);
    expect(emitter.eventNames()).toEqual(["ping", token]);
    emitter.emit("ping", 1);
    emitter.emit(token, 2);
    expect(stringListener).toHaveBeenCalledWith(1);
    expect(symbolListener).toHaveBeenCalledWith(2);
    expect(stringListener).not.toHaveBeenCalledWith(2);
  });
});

describe("eventemitter3 emit ordering and snapshot", () => {
  it("fires listeners in registration order, including a duplicate function", () => {
    const emitter = new EventEmitter();
    const order: string[] = [];
    const shared = () => {
      order.push("shared");
    };
    emitter.on("ping", () => {
      order.push("first");
    });
    emitter.on("ping", shared);
    emitter.on("ping", shared);
    emitter.emit("ping");
    expect(order).toEqual(["first", "shared", "shared"]);
  });

  it("does not dispatch a listener added during the same emit (copied queue)", () => {
    const emitter = new EventEmitter();
    const late = vi.fn();
    const first = vi.fn(() => {
      emitter.on("ping", late);
    });
    emitter.on("ping", first);
    emitter.emit("ping");
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    emitter.emit("ping");
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("still calls a later listener that another listener removes mid-emit", () => {
    const emitter = new EventEmitter();
    const later = vi.fn();
    const first = vi.fn(() => {
      emitter.removeListener("ping", later);
    });
    emitter.on("ping", first);
    emitter.on("ping", later);
    expect(emitter.emit("ping")).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("ping")).toBe(1);
  });

  it("does not retrigger the same once listener if it re-emits the event", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn(() => {
      emitter.emit("ping", "nested");
    });
    emitter.once("ping", listener);
    emitter.emit("ping", "outer");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("outer");
  });
});

describe("eventemitter3 context binding", () => {
  it("applies the emitter as this when context is omitted", () => {
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    emitter.on("ping", function onPing(this: unknown) {
      seen.push(this);
    });
    emitter.emit("ping");
    expect(seen).toEqual([emitter]);
  });

  it("applies the provided context object as this", () => {
    const emitter = new EventEmitter();
    const context = { id: "ctx" };
    const seen: unknown[] = [];
    emitter.on(
      "ping",
      function onPing(this: unknown, value: unknown) {
        seen.push(this, value);
      },
      context,
    );
    emitter.emit("ping", 9);
    expect(seen).toEqual([context, 9]);
  });

  it("uses a falsy non-nullish context as this, and falls back for null and undefined", () => {
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    const record = function recordThis(this: unknown) {
      seen.push(this);
    };
    emitter.on("zero", record, 0);
    emitter.on("empty", record, "");
    emitter.on("no", record, false);
    emitter.on("nil", record, null);
    emitter.on("void", record, undefined);
    emitter.emit("zero");
    emitter.emit("empty");
    emitter.emit("no");
    emitter.emit("nil");
    emitter.emit("void");
    expect(seen).toEqual([0, "", false, emitter, emitter]);
  });
});

describe("eventemitter3 removeListener / off", () => {
  it("is a no-op when the event or the listener is missing", () => {
    const emitter = new EventEmitter();
    const missing = vi.fn();
    const kept = vi.fn();
    expect(emitter.removeListener("ghost", missing)).toBe(emitter);
    emitter.on("ping", kept);
    expect(emitter.off("ping", missing)).toBe(emitter);
    expect(emitter.listeners("ping")).toEqual([kept]);
    emitter.emit("ping");
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("deletes the whole event when listener is omitted, including falsy listener", () => {
    const emitter = new EventEmitter();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on("ping", first);
    emitter.on("ping", second);
    expect(emitter.removeListener("ping")).toBe(emitter);
    expect(emitter.eventNames()).toEqual([]);
    expect(emitter.emit("ping")).toBe(false);
    emitter.on("pong", first);
    emitter.off("pong", undefined);
    expect(emitter.eventNames()).toEqual([]);
  });

  it("removes every matching registration of the same function", () => {
    const emitter = new EventEmitter();
    const shared = vi.fn();
    const other = vi.fn();
    emitter.on("ping", shared);
    emitter.on("ping", other);
    emitter.on("ping", shared);
    emitter.removeListener("ping", shared);
    expect(emitter.listeners("ping")).toEqual([other]);
    emitter.emit("ping");
    expect(shared).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("deletes the event key when the last matching listener is removed", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on("ping", listener);
    emitter.off("ping", listener);
    expect(emitter.eventNames()).toEqual([]);
    expect(emitter.listenerCount("ping")).toBe(0);
  });

  it("keeps a listener when the provided context does not match", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    const context = { id: "keep" };
    emitter.on("ping", listener, context);
    emitter.removeListener("ping", listener, { id: "other" });
    expect(emitter.listenerCount("ping")).toBe(1);
    emitter.removeListener("ping", listener, context);
    expect(emitter.listenerCount("ping")).toBe(0);
  });

  it("keeps a listener when the once flag does not match", () => {
    const emitter = new EventEmitter();
    const onListener = vi.fn();
    const onceListener = vi.fn();
    emitter.on("ping", onListener);
    emitter.once("ping", onceListener);
    emitter.removeListener("ping", onListener, undefined, true);
    emitter.removeListener("ping", onceListener, undefined, false);
    expect(emitter.listenerCount("ping")).toBe(2);
    emitter.removeListener("ping", onListener, undefined, false);
    emitter.removeListener("ping", onceListener, undefined, true);
    expect(emitter.eventNames()).toEqual([]);
  });

  it("off forwards to removeListener with context and once filters", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    const context = { id: "ctx" };
    emitter.once("ping", listener, context);
    emitter.off("ping", listener, context, true);
    expect(emitter.listenerCount("ping")).toBe(0);
  });
});

describe("eventemitter3 removeAllListeners", () => {
  it("clears every event when called with no argument", () => {
    const emitter = new EventEmitter();
    emitter.on("ping", vi.fn());
    emitter.on("pong", vi.fn());
    expect(emitter.removeAllListeners()).toBe(emitter);
    expect(emitter.eventNames()).toEqual([]);
    expect(emitter.emit("ping")).toBe(false);
    expect(emitter.emit("pong")).toBe(false);
  });

  it("deletes only the named event and leaves others intact", () => {
    const emitter = new EventEmitter();
    const kept = vi.fn();
    emitter.on("ping", vi.fn());
    emitter.on("pong", kept);
    emitter.removeAllListeners("ping");
    expect(emitter.eventNames()).toEqual(["pong"]);
    emitter.emit("pong", "stay");
    expect(kept).toHaveBeenCalledWith("stay");
  });

  it("is a no-op for an event that was never registered", () => {
    const emitter = new EventEmitter();
    const kept = vi.fn();
    emitter.on("ping", kept);
    expect(emitter.removeAllListeners("ghost")).toBe(emitter);
    expect(emitter.listeners("ping")).toEqual([kept]);
  });
});

describe("eventemitter3 listeners copy", () => {
  it("returns a new array so mutating it does not change the registry", () => {
    const emitter = new EventEmitter();
    const listener = vi.fn();
    emitter.on("ping", listener);
    const copy = emitter.listeners("ping");
    copy.pop();
    expect(emitter.listeners("ping")).toEqual([listener]);
    expect(emitter.listenerCount("ping")).toBe(1);
  });
});
