/**
 * Unit tests for the `es-toolkit/compat/throttle` browser shim. The suite
 * drives the real re-export (named and default) and records leading invoke,
 * wait-window coalescing, trailing invoke of the last args, cancel, flush,
 * this-binding, and clock-skew (`remaining > wait`) behaviour. There is no
 * queue, comparator, removal, or capacity API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import throttleDefault, { throttle } from "./es-toolkit-compat-throttle.js";

describe("es-toolkit-compat-throttle exports", () => {
  it("re-exports the same function as both named throttle and default", () => {
    expect(throttle).toBeTypeOf("function");
    expect(throttleDefault).toBe(throttle);
  });
});

describe("throttle wait default and leading invoke", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes on every call when wait is omitted (defaults to 0)", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return args[0];
    };
    const throttled = throttle(fn);
    expect(throttled("a")).toBe("a");
    expect(throttled("b")).toBe("b");
    expect(calls).toEqual([["a"], ["b"]]);
  });

  it("invokes immediately on the first call for a positive wait", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return "first";
    };
    const throttled = throttle(fn, 100);
    expect(throttled("lead")).toBe("first");
    expect(calls).toEqual([["lead"]]);
  });
});

describe("throttle wait window, trailing invoke, and last-args", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the previous result and does not re-invoke inside the wait window", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return calls.length;
    };
    const throttled = throttle(fn, 100);
    expect(throttled("a")).toBe(1);
    expect(throttled("b")).toBe(1);
    expect(throttled("c")).toBe(1);
    expect(calls).toEqual([["a"]]);
  });

  it("invokes once more after the wait with the last args of the window", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return args[0];
    };
    const throttled = throttle(fn, 100);
    throttled("first");
    throttled("second");
    throttled("third");
    expect(calls).toEqual([["first"]]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([["first"], ["third"]]);
  });

  it("schedules only one trailing timer for many calls in the same window", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
    };
    const throttled = throttle(fn, 80);
    throttled(1);
    throttled(2);
    throttled(3);
    throttled(4);
    vi.advanceTimersByTime(79);
    expect(calls).toEqual([[1]]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([[1], [4]]);
  });

  it("invokes immediately again once the wait has fully elapsed with no pending call", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return args[0];
    };
    const throttled = throttle(fn, 100);
    expect(throttled("a")).toBe("a");
    vi.advanceTimersByTime(100);
    expect(throttled("b")).toBe("b");
    expect(calls).toEqual([["a"], ["b"]]);
  });

  it("clears a pending trailing timer and invokes immediately when remaining is overdue", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
    };
    const throttled = throttle(fn, 100);
    throttled("lead");
    vi.setSystemTime(1_000_040);
    throttled("pending");
    expect(calls).toEqual([["lead"]]);
    vi.setSystemTime(1_000_200);
    throttled("overdue");
    expect(calls).toEqual([["lead"], ["overdue"]]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([["lead"], ["overdue"]]);
  });

  it("invokes immediately when the clock moves backwards so remaining exceeds wait", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return args[0];
    };
    const throttled = throttle(fn, 100);
    expect(throttled("before")).toBe("before");
    vi.setSystemTime(500_000);
    expect(throttled("after-skew")).toBe("after-skew");
    expect(calls).toEqual([["before"], ["after-skew"]]);
  });

  it("applies the last this-binding and args on the trailing invoke", () => {
    const calls: Array<{ thisArg: unknown; args: unknown[] }> = [];
    const fn = function fn(this: unknown, ...args: unknown[]) {
      calls.push({ thisArg: this, args });
      return args[0];
    };
    const throttled = throttle(fn, 50);
    const firstThis = { id: "first" };
    const lastThis = { id: "last" };
    throttled.call(firstThis, "a");
    throttled.call(lastThis, "b", "c");
    vi.advanceTimersByTime(50);
    expect(calls).toEqual([
      { thisArg: firstThis, args: ["a"] },
      { thisArg: lastThis, args: ["b", "c"] },
    ]);
  });
});

describe("throttle cancel and flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancel drops a pending trailing invoke", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
    };
    const throttled = throttle(fn, 100);
    throttled("lead");
    throttled("dropped");
    throttled.cancel();
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([["lead"]]);
  });

  it("cancel with no pending timer does not invoke or throw", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
    };
    const throttled = throttle(fn, 100);
    throttled("only");
    throttled.cancel();
    expect(calls).toEqual([["only"]]);
  });

  it("cancel does not reset lastCall, so a call still inside the wait is deferred", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
    };
    const throttled = throttle(fn, 100);
    throttled("lead");
    throttled("pending");
    throttled.cancel();
    throttled("after-cancel");
    expect(calls).toEqual([["lead"]]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([["lead"], ["after-cancel"]]);
  });

  it("flush invokes a pending trailing call immediately and returns its result", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return args[0];
    };
    const throttled = throttle(fn, 100);
    expect(throttled("lead")).toBe("lead");
    throttled("flushed");
    expect(throttled.flush()).toBe("flushed");
    expect(calls).toEqual([["lead"], ["flushed"]]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([["lead"], ["flushed"]]);
  });

  it("flush with no pending timer returns lastResult without invoking again", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return "result";
    };
    const throttled = throttle(fn, 100);
    expect(throttled("lead")).toBe("result");
    expect(throttled.flush()).toBe("result");
    expect(calls).toEqual([["lead"]]);
  });

  it("flush before any call returns undefined", () => {
    const fn = (..._args: unknown[]) => "unused";
    const throttled = throttle(fn, 100);
    expect(throttled.flush()).toBeUndefined();
  });

  it("selects through the default export identically to the named export", () => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]) => {
      calls.push(args);
      return args[0];
    };
    const throttled = throttleDefault(fn, 40);
    expect(throttled("x")).toBe("x");
    throttled("y");
    expect(throttled.flush()).toBe("y");
    expect(calls).toEqual([["x"], ["y"]]);
  });
});
