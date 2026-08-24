/**
 * @vitest-environment jsdom
 * Unit tests for useDebouncedValue hook.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "../useDebouncedValue.ts";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("initial", 300));
    expect(result.current).toBe("initial");
  });

  it("updates debounced value only after specified delay has elapsed", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: "hello", delay: 300 } },
    );

    expect(result.current).toBe("hello");

    rerender({ value: "hello world", delay: 300 });
    expect(result.current).toBe("hello");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("hello");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("hello world");
  });

  it("resets timer on rapid consecutive updates and commits final value", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebouncedValue(value, delay),
      { initialProps: { value: "v1", delay: 200 } },
    );

    rerender({ value: "v2", delay: 200 });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    rerender({ value: "v3", delay: 200 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("v1");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("v3");
  });
});
