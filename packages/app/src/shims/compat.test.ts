import { afterEach, describe, expect, it, vi } from "vitest";
import { throttle } from "./es-toolkit-compat";
import extend from "./extend";

afterEach(() => vi.useRealTimers());

describe("browser compatibility shims", () => {
  it("honors an explicit shallow merge without retaining nested target keys", () => {
    const nested = { fresh: true };
    const target = { nested: { old: true } };
    const result = extend(false, target, { nested });
    expect(result).toBe(target);
    expect(target.nested).toBe(nested);
    expect(target.nested).toEqual({ fresh: true });
  });

  it("still recursively merges when deep mode is explicitly enabled", () => {
    expect(
      extend(true, { nested: { old: true } }, { nested: { fresh: true } }),
    ).toEqual({ nested: { old: true, fresh: true } });
  });

  it("flush cancels the old timer so it cannot consume a later call early", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const callback = vi.fn();
    const call = throttle(callback, 100);
    call("first");
    vi.advanceTimersByTime(20);
    call("second");
    vi.advanceTimersByTime(20);
    call.flush();
    expect(callback.mock.calls).toEqual([["first"], ["second"]]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10);
    call("third");
    vi.advanceTimersByTime(50);
    expect(callback).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(40);
    expect(callback.mock.calls).toEqual([["first"], ["second"], ["third"]]);
  });
});
