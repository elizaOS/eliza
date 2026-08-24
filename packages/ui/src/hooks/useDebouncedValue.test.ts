/** Verifies useDebouncedValue — timer hold, restart, and commit semantics through the package's configured test harness. */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDebouncedValue } from "./useDebouncedValue";

type Props = { value: string; delayMs: number };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDebouncedValue — initial render", () => {
  it("surfaces the initial value immediately, before any delay elapses", () => {
    const { result } = renderHook(() => useDebouncedValue("first", 100));

    expect(result.current).toBe("first");
  });
});

describe("useDebouncedValue — delayed commit", () => {
  it("holds the previous value until the full delay has elapsed", () => {
    const { result, rerender } = renderHook(
      ({ value, delayMs }: Props) => useDebouncedValue(value, delayMs),
      { initialProps: { value: "first", delayMs: 100 } },
    );

    rerender({ value: "second", delayMs: 100 });
    act(() => {
      vi.advanceTimersByTime(99);
    });

    expect(result.current).toBe("first");
  });

  it("commits the new value once delayMs has elapsed since the change", () => {
    const { result, rerender } = renderHook(
      ({ value, delayMs }: Props) => useDebouncedValue(value, delayMs),
      { initialProps: { value: "first", delayMs: 100 } },
    );

    rerender({ value: "second", delayMs: 100 });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toBe("second");
  });

  it("commits a zero-delay change on the next macrotask tick", () => {
    const { result, rerender } = renderHook(
      ({ value, delayMs }: Props) => useDebouncedValue(value, delayMs),
      { initialProps: { value: "first", delayMs: 0 } },
    );

    rerender({ value: "second", delayMs: 0 });
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(result.current).toBe("second");
  });
});

describe("useDebouncedValue — rapid successive changes", () => {
  it("restarts the timer on every change so only the latest value lands", () => {
    const { result, rerender } = renderHook(
      ({ value, delayMs }: Props) => useDebouncedValue(value, delayMs),
      { initialProps: { value: "a", delayMs: 50 } },
    );

    rerender({ value: "b", delayMs: 50 });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    rerender({ value: "c", delayMs: 50 });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    rerender({ value: "d", delayMs: 50 });

    // "d" landed at t=40ms; its own window closes at t=90ms.
    act(() => {
      vi.advanceTimersByTime(49);
    });
    // Neither intermediate value ever surfaced.
    expect(result.current).not.toBe("b");
    expect(result.current).not.toBe("c");
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("d");
  });
});

describe("useDebouncedValue — delay changes mid-window", () => {
  it("re-arms the pending timer when delayMs changes before the commit", () => {
    const { result, rerender } = renderHook(
      ({ value, delayMs }: Props) => useDebouncedValue(value, delayMs),
      { initialProps: { value: "first", delayMs: 100 } },
    );

    rerender({ value: "second", delayMs: 100 });
    act(() => {
      vi.advanceTimersByTime(60);
    });

    // Extending the delay re-arms the effect: the commit now needs a fresh
    // 200ms measured from this render, not the original 100ms from the value
    // change.
    rerender({ value: "second", delayMs: 200 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("first");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("second");
  });
});

describe("useDebouncedValue — unmount", () => {
  it("cancels the pending commit without throwing when unmounted mid-window", () => {
    const { result, rerender, unmount } = renderHook(
      ({ value, delayMs }: Props) => useDebouncedValue(value, delayMs),
      { initialProps: { value: "first", delayMs: 100 } },
    );

    rerender({ value: "second", delayMs: 100 });
    unmount();

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(150);
      });
    }).not.toThrow();
    // The cancelled commit never rendered.
    expect(result.current).toBe("first");
  });
});

describe("useDebouncedValue — generic values", () => {
  it("passes object values through by reference in both directions", () => {
    const first = { n: 1 };
    const second = { n: 2 };

    const { result, rerender } = renderHook(
      ({ value, delayMs }: { value: { n: number }; delayMs: number }) =>
        useDebouncedValue(value, delayMs),
      { initialProps: { value: first, delayMs: 10 } },
    );

    // Initial object is surfaced by identity, not cloned.
    expect(result.current).toBe(first);

    rerender({ value: second, delayMs: 10 });
    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(result.current).toBe(second);
  });
});
