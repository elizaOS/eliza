/**
 * Unit tests for the browser `debug` shim's namespace filter and logger
 * factory. The suite drives the real module and records enablement, wildcard
 * and prefix matching, disable return order, coerce, persistence, and logger
 * snapshot behaviour as implemented — including that leading `-` tokens are
 * skipped rather than subtracted, and that `logger.enabled` is captured at
 * create time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import createDebug, {
  coerce,
  debug,
  disable,
  enable,
  enabled,
} from "./debug.js";

type DebugFactory = typeof debug & {
  enable: typeof enable;
  disable: typeof disable;
  enabled: typeof enabled;
  coerce: typeof coerce;
  debug: typeof debug;
  default: typeof debug;
};

const factory = debug as DebugFactory;

afterEach(() => {
  disable();
  globalThis.localStorage?.removeItem("debug");
});

describe("debug shim exports", () => {
  it("uses the same factory for default and named debug exports", () => {
    expect(createDebug).toBe(debug);
  });

  it("exposes enable/disable/enabled/coerce as factory statics", () => {
    expect(factory.enable).toBe(enable);
    expect(factory.disable).toBe(disable);
    expect(factory.enabled).toBe(enabled);
    expect(factory.coerce).toBe(coerce);
    expect(factory.debug).toBe(debug);
    expect(factory.default).toBe(debug);
  });
});

describe("enable/disable/enabled filter", () => {
  it("starts with an empty queue: nothing is enabled and disable returns empty", () => {
    expect(enabled("app")).toBe(false);
    expect(disable()).toBe("");
  });

  it("enables a single namespace and returns it from disable", () => {
    enable("only");
    expect(enabled("only")).toBe(true);
    expect(enabled("other")).toBe(false);
    expect(disable()).toBe("only");
    expect(enabled("only")).toBe(false);
  });

  it("splits comma and whitespace lists and skips empty tokens", () => {
    enable("a, b  c,,d,");
    expect(enabled("a")).toBe(true);
    expect(enabled("b")).toBe(true);
    expect(enabled("c")).toBe(true);
    expect(enabled("d")).toBe(true);
    expect(enabled("a, b  c,,d,")).toBe(false);
  });

  it("replaces the previous set rather than accumulating (missing item is gone)", () => {
    enable("keep");
    enable("next");
    expect(enabled("keep")).toBe(false);
    expect(enabled("next")).toBe(true);
  });

  it("skips tokens that start with '-' instead of subtracting them", () => {
    enable("keep,-drop,also");
    expect(enabled("keep")).toBe(true);
    expect(enabled("drop")).toBe(false);
    expect(enabled("also")).toBe(true);
  });

  it("does not let a skipped '-secret' token disable the wildcard", () => {
    enable("*,-secret");
    expect(enabled("secret")).toBe(true);
  });

  it("returns disable() namespaces in insertion order and collapses duplicates", () => {
    enable("z,a,z,m");
    expect(disable()).toBe("z,a,m");
  });

  it("enables every namespace when the filter is '*'", () => {
    enable("*");
    expect(enabled("app")).toBe(true);
    expect(enabled("app:ui")).toBe(true);
    expect(enabled("")).toBe(true);
    expect(disable()).toBe("");
  });

  it("matches trailing-'*' as a prefix, including the prefix itself", () => {
    enable("app*");
    expect(enabled("app")).toBe(true);
    expect(enabled("app:ui")).toBe(true);
    expect(enabled("application")).toBe(true);
    expect(enabled("ap")).toBe(false);
    expect(enabled("other")).toBe(false);
  });

  it("treats a '*' that is not the whole token as an exact name unless it is a trailing prefix", () => {
    enable("*foo");
    expect(enabled("*foo")).toBe(true);
    expect(enabled("foo")).toBe(false);
    expect(enabled("xfoo")).toBe(false);
  });

  it("is case-sensitive for exact and prefix matches", () => {
    enable("Foo,Bar*");
    expect(enabled("Foo")).toBe(true);
    expect(enabled("foo")).toBe(false);
    expect(enabled("Bar:ui")).toBe(true);
    expect(enabled("bar:ui")).toBe(false);
  });

  it("does not treat a middle '*' as a prefix wildcard", () => {
    enable("a*b");
    expect(enabled("a*b")).toBe(true);
    expect(enabled("ab")).toBe(false);
    expect(enabled("axb")).toBe(false);
  });
});

describe("localStorage persistence", () => {
  it("persists the raw enable string and clears it on disable", () => {
    enable("a, -b, c");
    expect(globalThis.localStorage.getItem("debug")).toBe("a, -b, c");
    disable();
    expect(globalThis.localStorage.getItem("debug")).toBeNull();
  });

  it("keeps in-memory enablement when localStorage.setItem throws", () => {
    const store = globalThis.localStorage;
    const original = store.setItem.bind(store);
    store.setItem = () => {
      throw new Error("quota");
    };
    try {
      enable("survive");
      expect(enabled("survive")).toBe(true);
    } finally {
      store.setItem = original;
    }
  });

  it("clears in-memory enablement when localStorage.removeItem throws", () => {
    enable("sticky");
    const store = globalThis.localStorage;
    const original = store.removeItem.bind(store);
    store.removeItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(disable()).toBe("sticky");
      expect(enabled("sticky")).toBe(false);
    } finally {
      store.removeItem = original;
    }
  });
});

describe("coerce", () => {
  it("returns Error.stack when present", () => {
    const err = new Error("boom");
    expect(coerce(err)).toBe(err.stack);
  });

  it("falls back to Error.message when stack is empty", () => {
    const err = new Error("only-msg");
    Object.defineProperty(err, "stack", { value: "", configurable: true });
    expect(coerce(err)).toBe("only-msg");
  });

  it("returns non-Error values unchanged", () => {
    expect(coerce("plain")).toBe("plain");
    expect(coerce(3)).toBe(3);
    expect(coerce(null)).toBe(null);
    expect(coerce(undefined)).toBe(undefined);
    const obj = { ok: true };
    expect(coerce(obj)).toBe(obj);
  });
});

describe("createDebug logger", () => {
  it("stamps namespace and snapshots enabled at create time", () => {
    const silent = debug("late");
    expect(silent.namespace).toBe("late");
    expect(silent.enabled).toBe(false);
    enable("late");
    expect(enabled("late")).toBe(true);
    expect(silent.enabled).toBe(false);

    const live = debug("late");
    expect(live.enabled).toBe(true);
    disable();
    expect(enabled("late")).toBe(false);
    expect(live.enabled).toBe(true);
  });

  it("emits to console.debug only when the snapshot is enabled", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      debug("off")("skip", 1);
      expect(spy).not.toHaveBeenCalled();

      enable("on");
      debug("on")("hello", 2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("on", "hello", 2);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps emitting after disable() because enabled is a snapshot", () => {
    enable("snap");
    const logger = debug("snap");
    disable();
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      logger("still");
      expect(spy).toHaveBeenCalledWith("snap", "still");
    } finally {
      spy.mockRestore();
    }
  });

  it("extend joins with ':' by default and an explicit delimiter otherwise", () => {
    enable("app:ui");
    const child = debug("app").extend("ui");
    expect(child.namespace).toBe("app:ui");
    expect(child.enabled).toBe(true);

    const slashed = debug("app").extend("ui", "/");
    expect(slashed.namespace).toBe("app/ui");
    expect(slashed.enabled).toBe(false);
  });

  it("does not throw when console.debug is missing", () => {
    enable("quiet");
    const logger = debug("quiet");
    const consoleRef = globalThis.console;
    const original = consoleRef.debug;
    (consoleRef as { debug?: typeof console.debug }).debug = undefined;
    try {
      expect(() => logger("msg")).not.toThrow();
    } finally {
      consoleRef.debug = original;
    }
  });
});
